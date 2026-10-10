const crypto = require('crypto');
const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');

function contentError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseContentError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : (error?.code === '23514' ? 400 : 500);
  return normalized;
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim() || null;
}

function normalizeAttachments(value) {
  return (Array.isArray(value) ? value : []).map((attachment) => ({
    _id: String(attachment?._id || crypto.randomUUID().replace(/-/g, '')),
    originalName: String(attachment?.originalName || '').trim(),
    storedPath: String(attachment?.storedPath || '').trim(),
    mimeType: String(attachment?.mimeType || 'application/octet-stream').trim(),
    extension: String(attachment?.extension || '').trim().toLowerCase(),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || new Date().toISOString(),
  }));
}

function mapLesson(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    title: row.title,
    description: row.description,
    track: row.track,
    subject: row.subject,
    subjectId: row.subject_id || null,
    subjectCode: row.subject_code || '',
    subjectCategory: row.subject_category || '',
    pdfPath: row.pdf_path,
    pdfOriginalName: row.pdf_original_name,
    attachments: normalizeAttachments(row.attachments),
    createdBy: row.created_by,
    publishedBy: row.published_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssessment(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    lessonId: row.lesson_id || null,
    title: row.title,
    examType: row.exam_type,
    subject: row.subject,
    subjectId: row.subject_id || null,
    subjectCode: row.subject_code || '',
    subjectCategory: row.subject_category || 'Technical',
    difficulty: row.difficulty,
    numberOfItems: Number(row.number_of_items || 0),
    activityPoints: row.activity_points === null ? null : Number(row.activity_points),
    allowedSubmissionTypes: Array.isArray(row.allowed_submission_types)
      ? row.allowed_submission_types
      : ['written', 'link', 'file'],
    allowResubmission: row.allow_resubmission !== false,
    allowLateSubmissions: row.allow_late_submissions === true,
    examDurationMinutes: Number(row.exam_duration_minutes || 30),
    maxViolations: Number(row.max_violations || 3),
    violationAction: row.violation_action || 'auto-submit',
    submissionDeadline: row.submission_deadline || null,
    challengeDescription: row.challenge_description || '',
    attachments: normalizeAttachments(row.attachments),
    assessmentMode: row.assessment_mode || 'activity',
    gradingPeriod: normalizeGradingPeriod(row.grading_period),
    countsTowardRecommendation: row.counts_toward_recommendation === true
      && Boolean(normalizeGradingPeriod(row.grading_period)),
    requiresLessonCompletion: row.requires_lesson_completion !== false,
    assignmentScope: row.assignment_scope || 'handled_class',
    assignedStudentIds: Array.isArray(row.assigned_student_ids) ? row.assigned_student_ids : [],
    questions: Array.isArray(row.questions) ? row.questions : [],
    createdBy: row.created_by,
    publishedBy: row.published_by || null,
    lastModifiedBy: row.last_modified_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createSupabaseLesson(payload) {
  const row = {
    title: String(payload.title || '').trim(),
    description: String(payload.description || '').trim(),
    track: String(payload.track || '').trim(),
    subject: String(payload.subject || '').trim(),
    subject_id: referenceId(payload.subjectId),
    subject_code: String(payload.subjectCode || '').trim().toUpperCase(),
    subject_category: String(payload.subjectCategory || '').trim(),
    pdf_path: String(payload.pdfPath || '').trim(),
    pdf_original_name: String(payload.pdfOriginalName || '').trim(),
    attachments: normalizeAttachments(payload.attachments),
    created_by: referenceId(payload.createdBy),
    published_by: referenceId(payload.publishedBy),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseStorageClient().from('lessons').insert(row).select('*').single();
  if (error) throw contentError(error, 'Failed to save lesson in Supabase');
  return mapLesson(data);
}

async function listSupabaseLessons(createdBy) {
  let query = getSupabaseStorageClient().from('lessons').select('*').order('created_at', { ascending: false });
  if (referenceId(createdBy)) query = query.eq('created_by', referenceId(createdBy));
  const { data, error } = await query;
  if (error) throw contentError(error, 'Failed to read lessons from Supabase');
  return (data || []).map(mapLesson);
}

async function findSupabaseLesson(id, createdBy = null) {
  let query = getSupabaseStorageClient().from('lessons').select('*').eq('id', referenceId(id));
  if (referenceId(createdBy)) query = query.eq('created_by', referenceId(createdBy));
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw contentError(error, 'Failed to read lesson from Supabase');
  return mapLesson(data);
}

async function createSupabaseAssessment(payload) {
  const assessmentMode = String(payload.assessmentMode || 'activity').trim();
  const gradingPeriod = normalizeGradingPeriod(payload.gradingPeriod);
  if (assessmentMode === 'grading_assessment' && !gradingPeriod) {
    const error = new Error('gradingPeriod is required for grading assessments. Allowed values: 1st, 2nd, 3rd');
    error.statusCode = 400;
    throw error;
  }

  const row = {
    id: referenceId(payload.id) || undefined,
    lesson_id: referenceId(payload.lessonId),
    title: String(payload.title || '').trim(),
    exam_type: String(payload.examType || '').trim(),
    subject: String(payload.subject || '').trim(),
    subject_id: referenceId(payload.subjectId),
    subject_code: String(payload.subjectCode || '').trim().toUpperCase(),
    subject_category: String(payload.subjectCategory || 'Technical').trim(),
    difficulty: String(payload.difficulty || 'medium').trim(),
    number_of_items: Number(payload.numberOfItems || 0),
    activity_points: payload.activityPoints ?? null,
    allowed_submission_types: Array.isArray(payload.allowedSubmissionTypes)
      ? payload.allowedSubmissionTypes
      : ['written', 'link', 'file'],
    allow_resubmission: payload.allowResubmission !== false,
    allow_late_submissions: payload.allowLateSubmissions === true,
    exam_duration_minutes: Number(payload.examDurationMinutes || 30),
    max_violations: Number(payload.maxViolations || 3),
    violation_action: String(payload.violationAction || 'auto-submit'),
    submission_deadline: payload.submissionDeadline || null,
    challenge_description: String(payload.challengeDescription || '').trim(),
    attachments: normalizeAttachments(payload.attachments),
    assessment_mode: assessmentMode,
    grading_period: gradingPeriod,
    counts_toward_recommendation: payload.countsTowardRecommendation === true && Boolean(gradingPeriod),
    requires_lesson_completion: payload.requiresLessonCompletion !== false,
    assignment_scope: String(payload.assignmentScope || 'handled_class'),
    assigned_student_ids: Array.isArray(payload.assignedStudentIds) ? payload.assignedStudentIds.map(referenceId).filter(Boolean) : [],
    questions: Array.isArray(payload.questions) ? payload.questions : [],
    created_by: referenceId(payload.createdBy),
    published_by: referenceId(payload.publishedBy),
    last_modified_by: referenceId(payload.lastModifiedBy),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseStorageClient().from('assessments').insert(row).select('*').single();
  if (error) throw contentError(error, 'Failed to save assessment in Supabase');
  return mapAssessment(data);
}

async function listSupabaseAssessments(createdBy) {
  let query = getSupabaseStorageClient().from('assessments').select('*').order('created_at', { ascending: false });
  if (referenceId(createdBy)) query = query.eq('created_by', referenceId(createdBy));
  const { data, error } = await query;
  if (error) throw contentError(error, 'Failed to read assessments from Supabase');
  return (data || []).map(mapAssessment);
}

async function findSupabaseAssessment(id, createdBy = null) {
  const normalizedId = referenceId(id);
  if (!normalizedId) return null;
  let query = getSupabaseStorageClient().from('assessments').select('*').eq('id', normalizedId);
  if (referenceId(createdBy)) query = query.eq('created_by', referenceId(createdBy));
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw contentError(error, 'Failed to read assessment from Supabase');
  return mapAssessment(data);
}

async function updateSupabaseAssessment(id, createdBy, payload = {}) {
  const normalizedId = referenceId(id);
  const ownerId = referenceId(createdBy);
  if (!normalizedId || !ownerId) return null;
  const row = {
    lesson_id: referenceId(payload.lessonId),
    title: String(payload.title || '').trim(),
    exam_type: String(payload.examType || '').trim(),
    subject: String(payload.subject || '').trim(),
    subject_id: referenceId(payload.subjectId),
    subject_code: String(payload.subjectCode || '').trim().toUpperCase(),
    subject_category: String(payload.subjectCategory || 'Technical').trim(),
    difficulty: String(payload.difficulty || 'medium').trim(),
    number_of_items: Number(payload.numberOfItems || 0),
    activity_points: payload.activityPoints ?? null,
    allowed_submission_types: Array.isArray(payload.allowedSubmissionTypes)
      ? payload.allowedSubmissionTypes
      : ['written', 'link', 'file'],
    allow_resubmission: payload.allowResubmission !== false,
    allow_late_submissions: payload.allowLateSubmissions === true,
    exam_duration_minutes: Number(payload.examDurationMinutes || 30),
    max_violations: Number(payload.maxViolations || 3),
    violation_action: String(payload.violationAction || 'auto-submit'),
    submission_deadline: payload.submissionDeadline || null,
    challenge_description: String(payload.challengeDescription || '').trim(),
    attachments: normalizeAttachments(payload.attachments),
    assessment_mode: String(payload.assessmentMode || 'activity').trim(),
    grading_period: normalizeGradingPeriod(payload.gradingPeriod),
    counts_toward_recommendation: payload.countsTowardRecommendation === true
      && Boolean(normalizeGradingPeriod(payload.gradingPeriod)),
    requires_lesson_completion: payload.requiresLessonCompletion !== false,
    assignment_scope: String(payload.assignmentScope || 'handled_class'),
    assigned_student_ids: Array.isArray(payload.assignedStudentIds) ? payload.assignedStudentIds.map(referenceId).filter(Boolean) : [],
    questions: Array.isArray(payload.questions) ? payload.questions : [],
    published_by: referenceId(payload.publishedBy),
    last_modified_by: referenceId(payload.lastModifiedBy),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseStorageClient()
    .from('assessments')
    .update(row)
    .eq('id', normalizedId)
    .eq('created_by', ownerId)
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) throw contentError(error, 'Failed to update assessment in Supabase');
  return mapAssessment(data);
}

module.exports = {
  createSupabaseLesson,
  listSupabaseLessons,
  findSupabaseLesson,
  createSupabaseAssessment,
  findSupabaseAssessment,
  listSupabaseAssessments,
  updateSupabaseAssessment,
};
