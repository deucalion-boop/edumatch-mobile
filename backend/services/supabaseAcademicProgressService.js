const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { listSupabaseLessons, listSupabaseAssessments } = require('./supabaseContentService');
const { listHydratedStudentEnrollments } = require('./supabaseEnrollmentService');
const { listLessonProgress } = require('./supabaseProgressionService');
const { listStudentActivitySubmissions } = require('./supabaseActivityService');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');
const { buildSubjectGradeRecords, saveSubjectGradeRecords, latestGradeResults } = require('./supabaseGradeRecordService');
const { buildRecommendationFromGradeRecords } = require('./recommendationService');

const DEFAULT_WEIGHTS = { activity: 30, quiz: 30, exam: 40 };
const FINAL_STATUSES = new Set(['completed', 'auto_submitted', 'terminated']);

function cleanId(value) { return String(value?._id || value?.id || value || '').trim(); }
function round(value) { return Number(Number(value || 0).toFixed(2)); }
function percent(score, total) { return Number(total) > 0 ? round(Math.max(0, Math.min(100, Number(score || 0) / Number(total) * 100))) : null; }
function average(values) { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
function assessmentCategory(assessment) {
  const mode = String(assessment?.assessmentMode || '').toLowerCase();
  if (mode === 'activity') return 'activity';
  if (mode === 'quiz') return 'quiz';
  if (mode === 'grading_assessment') {
    return normalizeGradingPeriod(assessment?.gradingPeriod) ? 'exam' : null;
  }
  return null;
}
function performanceLevel(value) {
  if (value === null) return 'Insufficient Data';
  if (value >= 90) return 'Excellent';
  if (value >= 80) return 'Strong';
  if (value >= 75) return 'Developing';
  return 'Needs Improvement';
}

function calculateSubjectMetrics({ subject, lessons, assessments, submissions, progressRows, weightConfig, gradeRecord = null }) {
  const subjectId = cleanId(subject);
  const subjectLessons = lessons.filter((item) => cleanId(item.subjectId) === subjectId);
  const subjectAssessments = assessments.filter((item) => (
    cleanId(item.subjectId || item.lessonId?.subjectId) === subjectId
    && Boolean(assessmentCategory(item))
  ));
  const assessmentIds = new Set(subjectAssessments.map(cleanId));
  const finalSubmissions = submissions.filter((item) => assessmentIds.has(cleanId(item.assessmentId)) && FINAL_STATUSES.has(String(item.status || '').toLowerCase()));
  const progressByLesson = new Map(progressRows.map((item) => [cleanId(item.lessonId), item]));
  const assessmentById = new Map(subjectAssessments.map((item) => [cleanId(item), item]));
  const categoryValues = { activity: [], quiz: [], exam: [] };

  finalSubmissions.forEach((submission) => {
    const assessment = assessmentById.get(cleanId(submission.assessmentId));
    if (!assessment) return;
    const hasEssayEvaluation = Array.isArray(submission.aiEvaluations) && submission.aiEvaluations.length > 0;
    const scoringStatus = String(submission.scoringStatus || '').trim().toLowerCase();
    if (hasEssayEvaluation && !['teacher_approved', 'teacher_overridden'].includes(scoringStatus)) return;
    const category = assessmentCategory(assessment);
    if (!category) return;
    const earned = submission.teacherAdjustedScore ?? submission.gradeValue ?? submission.score;
    const total = Number(submission.totalPoints || (category === 'activity' ? assessment.activityPoints : 0));
    const value = percent(earned, total);
    const activityIsGraded = category !== 'activity' || submission.gradeValue !== null || submission.teacherAdjustedScore !== null || submission.gradedAt;
    if (value !== null && activityIsGraded) categoryValues[category].push(value);
  });

  const averages = {
    activity: average(categoryValues.activity),
    quiz: average(categoryValues.quiz),
    exam: average(categoryValues.exam),
  };
  const weights = weightConfig || DEFAULT_WEIGHTS;
  const applicable = Object.keys(averages).filter((key) => averages[key] !== null && Number(weights[key] || 0) > 0);
  const applicableWeight = applicable.reduce((sum, key) => sum + Number(weights[key] || 0), 0);
  const courseworkPercentage = applicableWeight > 0
    ? round(applicable.reduce((sum, key) => sum + averages[key] * Number(weights[key] || 0), 0) / applicableWeight)
    : null;
  const availablePeriodGrades = [gradeRecord?.p1, gradeRecord?.p2, gradeRecord?.p3]
    .filter((value) => value !== null && value !== undefined).map(Number);
  const gradingRecordPercentage = gradeRecord?.finalGrade ?? (availablePeriodGrades.length
    ? round(availablePeriodGrades.reduce((sum, value) => sum + value, 0) / availablePeriodGrades.length)
    : null);
  const finalPercentage = gradingRecordPercentage ?? courseworkPercentage;
  const completedLessons = subjectLessons.filter((lesson) => progressByLesson.get(cleanId(lesson))?.status === 'completed').length;
  const completedAssessmentIds = new Set(finalSubmissions.map((item) => cleanId(item.assessmentId)));
  const completedAssessments = completedAssessmentIds.size;
  const totalRequiredItems = subjectLessons.length + subjectAssessments.length;
  const completedRequiredItems = completedLessons + completedAssessments;
  const completionPercentage = totalRequiredItems ? round(completedRequiredItems / totalRequiredItems * 100) : 0;
  const minimumEvidenceCount = Number(weightConfig?.minimumEvidenceCount || 2);

  return {
    subjectId,
    subjectName: String(subject?.name || subject?.className || 'Subject').trim(),
    subjectCode: String(subject?.code || '').trim(),
    completionPercentage,
    completedLessons,
    totalLessons: subjectLessons.length,
    completedAssessments,
    totalAssessments: subjectAssessments.length,
    activityAverage: averages.activity,
    quizAverage: averages.quiz,
    examAverage: averages.exam,
    p1: gradeRecord?.p1 ?? null,
    p2: gradeRecord?.p2 ?? null,
    p3: gradeRecord?.p3 ?? null,
    finalGrade: gradeRecord?.finalGrade ?? null,
    gradingHistory: gradeRecord?.periods || [],
    latestGradedAt: gradeRecord?.latestGradedAt || null,
    courseworkPercentage,
    finalPercentage,
    performanceLevel: performanceLevel(finalPercentage),
    evidenceCount: categoryValues.activity.length + categoryValues.quiz.length + categoryValues.exam.length,
    minimumEvidenceCount,
    hasSufficientData: categoryValues.activity.length + categoryValues.quiz.length + categoryValues.exam.length >= minimumEvidenceCount,
    weights: { activity: Number(weights.activity || 0), quiz: Number(weights.quiz || 0), exam: Number(weights.exam || 0) },
    appliedCategories: applicable,
  };
}

async function computeAcademicProgress(studentId) {
  const enrollments = await listHydratedStudentEnrollments(studentId, 'approved');
  const subjects = enrollments.map((row) => row.subjectId).filter(Boolean);
  const subjectIds = subjects.map(cleanId);
  const client = getSupabaseStorageClient();
  const [lessons, assessments, submissions, progressRows, weightsResult] = await Promise.all([
    listSupabaseLessons(),
    listSupabaseAssessments(),
    listStudentActivitySubmissions(studentId),
    listLessonProgress(studentId),
    subjectIds.length ? client.from('assessment_weights').select('*').in('subject_id', subjectIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (weightsResult.error) throw Object.assign(new Error(weightsResult.error.message), { statusCode: 500 });
  const weightsBySubject = new Map((weightsResult.data || []).map((row) => [String(row.subject_id), {
    activity: Number(row.activity_weight), quiz: Number(row.quiz_weight), exam: Number(row.exam_weight), minimumEvidenceCount: Number(row.minimum_evidence_count || 2),
  }]));
  const visibleLessons = lessons.filter((item) => subjectIds.includes(cleanId(item.subjectId)));
  const visibleAssessments = assessments.filter((item) => (
    subjectIds.includes(cleanId(item.subjectId))
    && Boolean(assessmentCategory(item))
  ));
  const calculatedGradeRecords = buildSubjectGradeRecords({
    studentId,
    subjects,
    assessments: visibleAssessments,
    submissions,
  });
  const gradeRecords = await saveSubjectGradeRecords(calculatedGradeRecords);
  const recentGradeResults = latestGradeResults(gradeRecords);
  const gradeRecommendation = buildRecommendationFromGradeRecords(gradeRecords);
  const recommendationSave = await client.from('recommendations').upsert({
    student_id: String(studentId),
    assessment_attempts: recentGradeResults,
    subject_performance: gradeRecommendation.subjectPerformance,
    strand_scores: gradeRecommendation.strandScores,
    recommended_strand: gradeRecommendation.recommendedStrand,
    recommendation_explanation: gradeRecommendation.recommendationExplanation,
    last_reason: 'Subject grading records synchronized',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'student_id' });
  if (recommendationSave.error) {
    throw Object.assign(new Error(recommendationSave.error.message || 'Failed to save grade-based recommendation'), { statusCode: 500 });
  }
  const gradeRecordBySubjectId = new Map(gradeRecords.map((record) => [record.subjectId, record]));
  const subjectPerformance = subjects.map((subject) => calculateSubjectMetrics({
    subject,
    lessons: visibleLessons,
    assessments: visibleAssessments,
    submissions,
    progressRows,
    weightConfig: weightsBySubject.get(cleanId(subject)),
    gradeRecord: gradeRecordBySubjectId.get(cleanId(subject)) || null,
  }));
  const rankedSubjects = subjectPerformance.filter((item) => item.hasSufficientData && item.finalPercentage !== null)
    .sort((a, b) => b.finalPercentage - a.finalPercentage)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const strongestSubject = rankedSubjects[0] || null;
  const prioritySubject = rankedSubjects.length > 1 ? rankedSubjects[rankedSubjects.length - 1] : null;
  const completedLessons = progressRows.filter((item) => item.status === 'completed' && visibleLessons.some((lesson) => cleanId(lesson) === cleanId(item.lessonId))).length;
  const completedByCategory = { activity: 0, quiz: 0, exam: 0 };
  submissions.filter((item) => FINAL_STATUSES.has(String(item.status || '').toLowerCase())).forEach((submission) => {
    const assessment = visibleAssessments.find((item) => cleanId(item) === cleanId(submission.assessmentId));
    const category = assessmentCategory(assessment);
    if (category) completedByCategory[category] += 1;
  });
  const totalRequired = visibleLessons.length + visibleAssessments.length;
  const totalCompleted = completedLessons + Object.values(completedByCategory).reduce((sum, value) => sum + value, 0);

  return {
    overallLearningProgress: {
      lessonsCompleted: completedLessons,
      activitiesCompleted: completedByCategory.activity,
      quizzesCompleted: completedByCategory.quiz,
      examsCompleted: completedByCategory.exam,
      totalRequiredItems: totalRequired,
      completedRequiredItems: totalCompleted,
      completionPercentage: totalRequired ? round(totalCompleted / totalRequired * 100) : 0,
    },
    gradeRecords,
    latestGradeResults: recentGradeResults,
    subjectPerformance,
    rankedSubjects,
    strongestSubject,
    prioritySubject,
    strengthRecommendation: strongestSubject
      ? `You are currently performing strongest in ${strongestSubject.subjectName}. Continue with advanced lessons and activities to further develop this strength.`
      : 'Complete more graded assessments across your subjects to identify your strongest area.',
    improvementRecommendation: prioritySubject
      ? `Your current ${prioritySubject.subjectName} result is lower than your other valid subject results. Review its lessons and complete additional learning activities before progressing.`
      : 'More subject evidence is needed before EduMatch can identify a priority for improvement.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_WEIGHTS,
  percent,
  assessmentCategory,
  performanceLevel,
  calculateSubjectMetrics,
  computeAcademicProgress,
};
