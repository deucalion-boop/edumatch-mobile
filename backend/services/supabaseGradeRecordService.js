const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { listHydratedStudentEnrollments } = require('./supabaseEnrollmentService');
const { listSupabaseAssessments } = require('./supabaseContentService');
const { listStudentActivitySubmissions } = require('./supabaseActivityService');
const { GRADING_PERIODS, normalizeGradingPeriod, gradingPeriodOrder } = require('../constants/assessmentConfig');

const FINAL_STATUSES = new Set(['completed', 'auto_submitted', 'terminated']);
const PERIOD_COLUMNS = Object.freeze({ '1st': 'p1', '2nd': 'p2', '3rd': 'p3' });

function cleanId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function roundGrade(value) {
  return Number(Number(value || 0).toFixed(2));
}

function submissionPercentage(submission) {
  const earned = Number(submission?.teacherAdjustedScore ?? submission?.gradeValue ?? submission?.score ?? 0);
  const total = Number(submission?.totalPoints || 0);
  if (!Number.isFinite(earned) || !Number.isFinite(total) || total <= 0) return null;
  return roundGrade(Math.max(0, Math.min(100, earned / total * 100)));
}

function submissionTimestamp(submission) {
  return new Date(submission?.gradedAt || submission?.submittedAt || submission?.updatedAt || submission?.createdAt || 0).getTime() || 0;
}

function buildSubjectGradeRecords({ studentId, subjects = [], assessments = [], submissions = [] }) {
  const gradingAssessments = new Map(
    assessments
      .filter((assessment) => (
        String(assessment?.assessmentMode || '').trim().toLowerCase() === 'grading_assessment'
        && Boolean(normalizeGradingPeriod(assessment?.gradingPeriod))
      ))
      .map((assessment) => [cleanId(assessment), assessment])
  );
  const latestBySubjectPeriod = new Map();

  submissions.forEach((submission) => {
    if (!FINAL_STATUSES.has(String(submission?.status || '').trim().toLowerCase())) return;
    const assessment = gradingAssessments.get(cleanId(submission?.assessmentId));
    if (!assessment) return;
    const percentage = submissionPercentage(submission);
    if (percentage === null) return;
    const subjectId = cleanId(assessment?.subjectId || assessment?.lessonId?.subjectId);
    const gradingPeriod = normalizeGradingPeriod(assessment?.gradingPeriod);
    if (!subjectId || !gradingPeriod) return;
    const key = `${subjectId}:${gradingPeriod}`;
    const current = latestBySubjectPeriod.get(key);
    if (current && submissionTimestamp(current.submission) > submissionTimestamp(submission)) return;
    latestBySubjectPeriod.set(key, { assessment, submission, percentage });
  });

  return subjects.map((subject) => {
    const subjectId = cleanId(subject);
    const periodValues = {};
    const periodSources = {};
    GRADING_PERIODS.forEach((period) => {
      const result = latestBySubjectPeriod.get(`${subjectId}:${period}`);
      const key = PERIOD_COLUMNS[period];
      periodValues[key] = result?.percentage ?? null;
      periodSources[key] = result ? {
        assessmentId: cleanId(result.assessment),
        submissionId: cleanId(result.submission),
        title: String(result.assessment?.title || 'Grading assessment').trim(),
        examType: String(result.assessment?.examType || '').trim(),
        gradingPeriod: period,
        score: Number(result.submission?.teacherAdjustedScore ?? result.submission?.gradeValue ?? result.submission?.score ?? 0),
        totalPoints: Number(result.submission?.totalPoints || 0),
        percentage: result.percentage,
        gradedAt: result.submission?.gradedAt || result.submission?.submittedAt || result.submission?.updatedAt || null,
      } : null;
    });
    const completedPeriods = Object.values(periodValues).filter((value) => value !== null).length;
    const finalGrade = completedPeriods === GRADING_PERIODS.length
      ? roundGrade((periodValues.p1 + periodValues.p2 + periodValues.p3) / GRADING_PERIODS.length)
      : null;
    const latestSource = Object.values(periodSources).filter(Boolean)
      .sort((left, right) => Date.parse(right.gradedAt || 0) - Date.parse(left.gradedAt || 0))[0] || null;

    return {
      studentId: String(studentId || ''),
      subjectId,
      subjectName: String(subject?.name || subject?.className || 'Subject').trim(),
      subjectCode: String(subject?.code || '').trim(),
      subjectCategory: String(subject?.subjectCategory || '').trim(),
      p1: periodValues.p1,
      p2: periodValues.p2,
      p3: periodValues.p3,
      finalGrade,
      completedPeriods,
      latestGradedAt: latestSource?.gradedAt || null,
      periods: GRADING_PERIODS.map((period) => ({
        period,
        grade: periodValues[PERIOD_COLUMNS[period]],
        source: periodSources[PERIOD_COLUMNS[period]],
      })),
    };
  });
}

function toDatabaseRow(record) {
  const source = (period) => record.periods.find((item) => item.period === period)?.source || null;
  return {
    student_id: record.studentId,
    subject_id: record.subjectId,
    subject_name: record.subjectName,
    subject_code: record.subjectCode,
    subject_category: record.subjectCategory,
    p1_grade: record.p1,
    p2_grade: record.p2,
    p3_grade: record.p3,
    final_grade: record.finalGrade,
    p1_source: source('1st'),
    p2_source: source('2nd'),
    p3_source: source('3rd'),
    completed_periods: record.completedPeriods,
    latest_graded_at: record.latestGradedAt,
    updated_at: new Date().toISOString(),
  };
}

function mapDatabaseRow(row) {
  const periods = GRADING_PERIODS.map((period) => {
    const key = PERIOD_COLUMNS[period];
    return {
      period,
      grade: row[`${key}_grade`] === null || row[`${key}_grade`] === undefined ? null : Number(row[`${key}_grade`]),
      source: row[`${key}_source`] || null,
    };
  });
  return {
    id: row.id,
    studentId: row.student_id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    subjectCode: row.subject_code,
    subjectCategory: row.subject_category,
    p1: periods[0].grade,
    p2: periods[1].grade,
    p3: periods[2].grade,
    finalGrade: row.final_grade === null || row.final_grade === undefined ? null : Number(row.final_grade),
    completedPeriods: Number(row.completed_periods || 0),
    latestGradedAt: row.latest_graded_at || null,
    periods,
  };
}

async function saveSubjectGradeRecords(records = []) {
  if (!records.length) return [];
  const { data, error } = await getSupabaseStorageClient().from('student_subject_grades')
    .upsert(records.map(toDatabaseRow), { onConflict: 'student_id,subject_id' })
    .select('*');
  if (error) throw Object.assign(new Error(error.message || 'Failed to save subject grade records'), { statusCode: 500 });
  return (data || []).map(mapDatabaseRow).sort((left, right) => left.subjectName.localeCompare(right.subjectName));
}

async function syncStudentSubjectGradeRecords(studentId) {
  const [enrollments, assessments, submissions] = await Promise.all([
    listHydratedStudentEnrollments(studentId, 'approved'),
    listSupabaseAssessments(),
    listStudentActivitySubmissions(studentId),
  ]);
  const subjects = enrollments.map((row) => row.subjectId).filter(Boolean);
  const subjectIds = new Set(subjects.map(cleanId));
  const records = buildSubjectGradeRecords({
    studentId,
    subjects,
    assessments: assessments.filter((assessment) => subjectIds.has(cleanId(assessment?.subjectId || assessment?.lessonId?.subjectId))),
    submissions,
  });
  return saveSubjectGradeRecords(records);
}

async function listStudentSubjectGradeRecords(studentId, { sync = true } = {}) {
  if (sync) return syncStudentSubjectGradeRecords(studentId);
  const { data, error } = await getSupabaseStorageClient().from('student_subject_grades').select('*')
    .eq('student_id', String(studentId)).order('subject_name', { ascending: true });
  if (error) throw Object.assign(new Error(error.message || 'Failed to load subject grade records'), { statusCode: 500 });
  return (data || []).map(mapDatabaseRow);
}

function latestGradeResults(records = []) {
  return records.flatMap((record) => record.periods
    .filter((period) => period.grade !== null)
    .map((period) => ({
      subjectId: record.subjectId,
      subjectName: record.subjectName,
      subjectCode: record.subjectCode,
      gradingPeriod: period.period,
      grade: period.grade,
      finalGrade: record.finalGrade,
      ...period.source,
    })))
    .sort((left, right) => {
      const dateDelta = Date.parse(right.gradedAt || 0) - Date.parse(left.gradedAt || 0);
      return dateDelta || gradingPeriodOrder(right.gradingPeriod) - gradingPeriodOrder(left.gradingPeriod);
    });
}

module.exports = {
  buildSubjectGradeRecords,
  latestGradeResults,
  listStudentSubjectGradeRecords,
  saveSubjectGradeRecords,
  syncStudentSubjectGradeRecords,
};
