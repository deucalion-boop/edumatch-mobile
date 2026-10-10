const { readProfileRows } = require('./supabaseUserProfileService');
const { listSupabaseLessons, listSupabaseAssessments } = require('./supabaseContentService');
const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');
async function publishedLessons() {
  const lessons = await listSupabaseLessons();
  if (!lessons.length) return [];
  const [subjects, teachers] = await Promise.all([
    readProfileRows('subjects', 'id', [...new Set(lessons.map(row => row.subjectId).filter(Boolean))]),
    readProfileRows('users', 'id', [...new Set(lessons.map(row => row.createdBy).filter(Boolean))]),
  ]);
  return lessons.map(row => ({ ...row, subjectId: subjects.find(subject => subject.id === row.subjectId) || row.subjectId,
    createdBy: teachers.find(teacher => teacher.id === row.createdBy) || null }));
}
async function availableAssessments(studentId, subjectIds) {
  const [assessments, lessons] = await Promise.all([listSupabaseAssessments(), listSupabaseLessons()]);
  const visible = assessments.filter(row => {
    if (String(row.assessmentMode || '').trim().toLowerCase() === 'grading_assessment'
      && !normalizeGradingPeriod(row.gradingPeriod)) return false;
    const assigned = Array.isArray(row.assignedStudentIds) ? row.assignedStudentIds.map(String) : [];
    if (assigned.length) return assigned.includes(String(studentId));
    const lesson = lessons.find(lesson => lesson.id === row.lessonId);
    return subjectIds.map(String).includes(String(row.subjectId || lesson?.subjectId || ''));
  });
  if (!visible.length) return [];
  const teachers = await readProfileRows('users', 'id', [...new Set(visible.map(row => row.createdBy).filter(Boolean))]);
  return visible.map(row => ({ ...row, lessonId: lessons.find(lesson => lesson.id === row.lessonId) || null,
    createdBy: teachers.find(teacher => teacher.id === row.createdBy) || null }));
}
async function studentSubmissions(studentId, finalized = false) {
  const rows = (await readProfileRows('submissions', 'student_id', studentId))
    .filter(row => !finalized || ['completed', 'auto_submitted', 'terminated'].includes(row.status))
    .sort((a, b) => Date.parse(finalized ? b.submittedAt : b.updatedAt) - Date.parse(finalized ? a.submittedAt : a.updatedAt));
  if (!rows.length) return [];
  const assessments = await readProfileRows('assessments', 'id', [...new Set(rows.map(row => row.assessmentId))]);
  return rows.map(row => {
    const assessment = assessments.find(item => item.id === row.assessmentId);
    const gradingPeriod = normalizeGradingPeriod(assessment?.gradingPeriod);
    const safeAssessment = assessment ? { _id: assessment.id, title: assessment.title, examType: assessment.examType,
      difficulty: assessment.difficulty, numberOfItems: assessment.numberOfItems, assessmentMode: assessment.assessmentMode,
      gradingPeriod, lessonId: assessment.lessonId, submissionDeadline: assessment.submissionDeadline } : null;
    return { ...row, assessmentId: safeAssessment };
  });
}
async function studentAttendance(studentId) {
  const { data, error } = await getSupabaseStorageClient().from('attendance_records').select('*')
    .contains('entries', JSON.stringify([{ studentId: String(studentId) }])).order('date_key', { ascending: false });
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  return (data || []).map(row => Object.fromEntries([['_id', row.id], ...Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])]));
}
module.exports = { publishedLessons, availableAssessments, studentSubmissions, studentAttendance };
