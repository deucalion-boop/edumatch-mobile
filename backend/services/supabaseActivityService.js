const { getSupabaseStorageClient } = require('./supabaseStorageService');

function activityError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  normalized.code = error?.code;
  return normalized;
}

function mapSubmission(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    studentId: row.student_id,
    assessmentId: row.assessment_id,
    answers: Array.isArray(row.answers) ? row.answers : [],
    score: Number(row.score || 0),
    totalPoints: Number(row.total_points || 0),
    submittedAt: row.submitted_at || null,
    startedAt: row.started_at || null,
    lastActivityAt: row.last_activity_at || null,
    examDurationMinutes: Number(row.exam_duration_minutes || 30),
    violationCount: Number(row.violation_count || 0),
    activityLog: Array.isArray(row.activity_log) ? row.activity_log : [],
    responseText: row.response_text || '',
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    linkAttachments: Array.isArray(row.link_attachments) ? row.link_attachments : [],
    draftSavedAt: row.draft_saved_at || null,
    gradedAt: row.graded_at || null,
    gradeValue: row.grade_value === null || row.grade_value === undefined ? null : Number(row.grade_value),
    teacherFeedback: row.teacher_feedback || '',
    aiEvaluations: Array.isArray(row.ai_evaluations) ? row.ai_evaluations : [],
    aiScore: row.ai_score === null || row.ai_score === undefined ? null : Number(row.ai_score),
    teacherAdjustedScore: row.teacher_adjusted_score === null || row.teacher_adjusted_score === undefined ? null : Number(row.teacher_adjusted_score),
    scoringStatus: row.scoring_status || 'final',
    isLate: row.is_late === true,
    returnedAt: row.returned_at || null,
    autoSubmitted: row.auto_submitted === true,
    terminationReason: row.termination_reason || '',
    status: row.status || 'in_progress',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function submissionRow(payload) {
  return {
    student_id: String(payload.studentId),
    assessment_id: String(payload.assessmentId),
    answers: Array.isArray(payload.answers) ? payload.answers : [],
    score: Number(payload.score || 0),
    total_points: Number(payload.totalPoints || 0),
    submitted_at: payload.submittedAt || null,
    started_at: payload.startedAt || null,
    last_activity_at: payload.lastActivityAt || null,
    exam_duration_minutes: Number(payload.examDurationMinutes || 30),
    violation_count: Number(payload.violationCount || 0),
    activity_log: Array.isArray(payload.activityLog) ? payload.activityLog : [],
    response_text: String(payload.responseText || ''),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    link_attachments: Array.isArray(payload.linkAttachments) ? payload.linkAttachments : [],
    draft_saved_at: payload.draftSavedAt || null,
    graded_at: payload.gradedAt || null,
    grade_value: payload.gradeValue ?? null,
    teacher_feedback: String(payload.teacherFeedback || ''),
    ai_evaluations: Array.isArray(payload.aiEvaluations) ? payload.aiEvaluations : [],
    ai_score: payload.aiScore ?? null,
    teacher_adjusted_score: payload.teacherAdjustedScore ?? null,
    scoring_status: String(payload.scoringStatus || 'final'),
    is_late: payload.isLate === true,
    returned_at: payload.returnedAt || null,
    auto_submitted: payload.autoSubmitted === true,
    termination_reason: String(payload.terminationReason || ''),
    status: String(payload.status || 'in_progress'),
    updated_at: new Date().toISOString(),
  };
}

async function findActivitySubmission(studentId, assessmentId) {
  const { data, error } = await getSupabaseStorageClient().from('submissions').select('*')
    .eq('student_id', String(studentId)).eq('assessment_id', String(assessmentId)).limit(1).maybeSingle();
  if (error) throw activityError(error, 'Failed to load activity submission');
  return mapSubmission(data);
}

async function listStudentActivitySubmissions(studentId) {
  const { data, error } = await getSupabaseStorageClient().from('submissions').select('*')
    .eq('student_id', String(studentId)).order('updated_at', { ascending: false });
  if (error) throw activityError(error, 'Failed to load activity submissions');
  return (data || []).map(mapSubmission);
}

async function findActivitySubmissionById(submissionId, assessmentId) {
  const { data, error } = await getSupabaseStorageClient().from('submissions').select('*')
    .eq('id', String(submissionId)).eq('assessment_id', String(assessmentId)).limit(1).maybeSingle();
  if (error) throw activityError(error, 'Failed to load activity submission');
  return mapSubmission(data);
}

async function saveActivitySubmission(payload) {
  const client = getSupabaseStorageClient();
  const existing = await findActivitySubmission(payload.studentId, payload.assessmentId);
  const row = submissionRow(payload);
  let query = existing
    ? client.from('submissions').update(row).eq('id', existing.id)
    : client.from('submissions').insert(row);
  const { data, error } = await query.select('*').single();
  if (error) throw activityError(error, 'Failed to save activity submission');
  return mapSubmission(data);
}

async function updateActivityReview({ submissionId, assessmentId, values }) {
  const row = {
    score: Number(values.score || 0),
    total_points: Number(values.totalPoints || 0),
    grade_value: values.gradeValue ?? null,
    teacher_feedback: String(values.teacherFeedback || ''),
    graded_at: values.gradedAt || null,
    returned_at: values.returnedAt || null,
    status: String(values.status),
    updated_at: new Date().toISOString(),
  };
  if (values.aiEvaluations !== undefined) row.ai_evaluations = Array.isArray(values.aiEvaluations) ? values.aiEvaluations : [];
  if (values.aiScore !== undefined) row.ai_score = values.aiScore ?? null;
  if (values.teacherAdjustedScore !== undefined) row.teacher_adjusted_score = values.teacherAdjustedScore ?? null;
  if (values.scoringStatus !== undefined) row.scoring_status = String(values.scoringStatus || 'teacher_approved');
  const { data, error } = await getSupabaseStorageClient().from('submissions').update(row)
    .eq('id', String(submissionId)).eq('assessment_id', String(assessmentId)).select('*').maybeSingle();
  if (error) throw activityError(error, 'Failed to save activity review');
  return mapSubmission(data);
}

module.exports = {
  findActivitySubmission,
  findActivitySubmissionById,
  listStudentActivitySubmissions,
  saveActivitySubmission,
  updateActivityReview,
  mapSubmission,
};
