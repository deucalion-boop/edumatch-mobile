const { getSupabaseStorageClient } = require('./supabaseStorageService');

const FINAL_STATUSES = new Set(['completed', 'auto_submitted', 'terminated']);
const MINIMUM_COMPLETION_SECONDS = 20;
let warnedMissingProgressTable = false;

function cleanId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function mapLessonProgress(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    lessonId: row.lesson_id,
    status: row.status || 'not_started',
    progressPercent: Number(row.progress_percent || 0),
    engagementSeconds: Number(row.engagement_seconds || 0),
    reachedEnd: row.reached_end === true,
    startedAt: row.started_at || null,
    lastViewedAt: row.last_viewed_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at || null,
  };
}

function isMissingTableError(error, tableName) {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'PGRST205'
    || (message.includes(String(tableName || '').toLowerCase())
      && (message.includes('schema cache') || message.includes('does not exist')));
}

function reportMissingProgressTable(error) {
  if (warnedMissingProgressTable) return;
  warnedMissingProgressTable = true;
  console.warn('[lesson progress] Database migration 008 is not applied. Lessons remain visible, but completion tracking stays unavailable.', {
    code: error?.code || '',
  });
}

async function listLessonProgress(studentId) {
  const { data, error } = await getSupabaseStorageClient().from('lesson_progress').select('*')
    .eq('student_id', cleanId(studentId));
  if (isMissingTableError(error, 'lesson_progress')) {
    reportMissingProgressTable(error);
    return [];
  }
  if (error) throw Object.assign(new Error(error.message || 'Failed to load lesson progress'), { statusCode: 500 });
  return (data || []).map(mapLessonProgress);
}

async function findLessonProgress(studentId, lessonId) {
  const { data, error } = await getSupabaseStorageClient().from('lesson_progress').select('*')
    .eq('student_id', cleanId(studentId)).eq('lesson_id', cleanId(lessonId)).limit(1).maybeSingle();
  if (isMissingTableError(error, 'lesson_progress')) {
    reportMissingProgressTable(error);
    return null;
  }
  if (error) throw Object.assign(new Error(error.message || 'Failed to load lesson progress'), { statusCode: 500 });
  return mapLessonProgress(data);
}

async function recordLessonProgress({ studentId, lessonId, progressPercent, reachedEnd, engagementSeconds }) {
  const existing = await findLessonProgress(studentId, lessonId);
  if (existing?.status === 'completed') return existing;

  const now = new Date().toISOString();
  const reportedProgress = Math.max(0, Math.min(100, Number(progressPercent || 0)));
  const requestedIncrement = Math.max(0, Math.min(60, Math.floor(Number(engagementSeconds || 0))));
  const lastServerTimestamp = existing?.lastViewedAt ? new Date(existing.lastViewedAt).getTime() : NaN;
  const elapsedSinceLastUpdate = Number.isFinite(lastServerTimestamp)
    ? Math.max(0, Math.floor((Date.now() - lastServerTimestamp) / 1000) + 2)
    : 0;
  const safeIncrement = Math.min(requestedIncrement, elapsedSinceLastUpdate);
  const nextProgress = Math.max(Number(existing?.progressPercent || 0), reportedProgress);
  const nextSeconds = Number(existing?.engagementSeconds || 0) + safeIncrement;
  const nextReachedEnd = existing?.reachedEnd === true || reachedEnd === true;
  const completed = nextReachedEnd && nextProgress >= 90 && nextSeconds >= MINIMUM_COMPLETION_SECONDS;
  const row = {
    student_id: cleanId(studentId),
    lesson_id: cleanId(lessonId),
    status: completed ? 'completed' : 'in_progress',
    progress_percent: completed ? 100 : nextProgress,
    engagement_seconds: nextSeconds,
    reached_end: nextReachedEnd,
    started_at: existing?.startedAt || now,
    last_viewed_at: now,
    completed_at: completed ? now : null,
    updated_at: now,
  };
  const client = getSupabaseStorageClient();
  const query = existing
    ? client.from('lesson_progress').update(row).eq('id', existing.id)
    : client.from('lesson_progress').insert(row);
  const { data, error } = await query.select('*').single();
  if (isMissingTableError(error, 'lesson_progress')) {
    reportMissingProgressTable(error);
    throw Object.assign(new Error('Lesson progress is temporarily unavailable. Apply database migration 008, then try again.'), { statusCode: 503 });
  }
  if (error) throw Object.assign(new Error(error.message || 'Failed to save lesson progress'), { statusCode: 500 });
  return mapLessonProgress(data);
}

function assessmentStage(assessment) {
  const mode = String(assessment?.assessmentMode || '').trim().toLowerCase();
  if (mode === 'activity') return 'activity';
  if (mode === 'quiz') return 'quiz';
  return 'exam';
}

function computeAssessmentGate({ assessment, lessonProgress, relatedAssessments, submissions }) {
  const lessonId = cleanId(assessment?.lessonId);
  if (!lessonId || assessment?.requiresLessonCompletion === false) {
    return { isLocked: false, lockReason: '', prerequisite: null };
  }

  if (String(lessonProgress?.status || '') !== 'completed') {
    return {
      isLocked: true,
      lockReason: 'Complete the lesson first to unlock this assessment.',
      prerequisite: 'lesson',
    };
  }

  const stage = assessmentStage(assessment);
  const priorStages = stage === 'quiz' ? ['activity'] : (stage === 'exam' ? ['activity', 'quiz'] : []);
  for (const priorStage of priorStages) {
    const prerequisiteAssessments = (relatedAssessments || []).filter((item) => assessmentStage(item) === priorStage);
    if (!prerequisiteAssessments.length) continue;
    const completed = prerequisiteAssessments.every((item) => (submissions || []).some((submission) => (
      cleanId(submission.assessmentId) === cleanId(item)
      && FINAL_STATUSES.has(String(submission.status || '').toLowerCase())
    )));
    if (!completed) {
      return {
        isLocked: true,
        lockReason: `Complete the linked ${priorStage} first to unlock this ${stage}.`,
        prerequisite: priorStage,
      };
    }
  }

  return { isLocked: false, lockReason: '', prerequisite: null };
}

async function buildAssessmentGates(studentId, assessments) {
  const client = getSupabaseStorageClient();
  const [progressRows, submissionResult] = await Promise.all([
    listLessonProgress(studentId),
    client.from('submissions').select('assessment_id,status').eq('student_id', cleanId(studentId)),
  ]);
  if (submissionResult.error) throw Object.assign(new Error(submissionResult.error.message), { statusCode: 500 });
  const submissions = (submissionResult.data || []).map((row) => ({ assessmentId: row.assessment_id, status: row.status }));
  const progressByLesson = new Map(progressRows.map((row) => [cleanId(row.lessonId), row]));

  return new Map((assessments || []).map((assessment) => {
    const lessonId = cleanId(assessment.lessonId);
    const related = (assessments || []).filter((item) => cleanId(item.lessonId) === lessonId);
    return [cleanId(assessment), computeAssessmentGate({
      assessment,
      lessonProgress: progressByLesson.get(lessonId),
      relatedAssessments: related,
      submissions,
    })];
  }));
}

async function assertAssessmentUnlocked(studentId, assessment, allAssessments) {
  const gates = await buildAssessmentGates(studentId, allAssessments || [assessment]);
  const gate = gates.get(cleanId(assessment)) || { isLocked: false };
  if (gate.isLocked) {
    const error = new Error(gate.lockReason);
    error.statusCode = 423;
    error.details = { prerequisite: gate.prerequisite, lessonId: cleanId(assessment.lessonId) || null };
    throw error;
  }
  return gate;
}

module.exports = {
  FINAL_STATUSES,
  MINIMUM_COMPLETION_SECONDS,
  mapLessonProgress,
  isMissingTableError,
  listLessonProgress,
  findLessonProgress,
  recordLessonProgress,
  assessmentStage,
  computeAssessmentGate,
  buildAssessmentGates,
  assertAssessmentUnlocked,
};
