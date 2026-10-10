const { publishedLessons, availableAssessments, studentSubmissions } = require('../services/supabaseStudentDashboardService');
const path = require('path');
const crypto = require('crypto');
const Lesson = require('../models/Lesson');
const User = require('../models/User');
const { sendSuccess } = require('../utils/responseHelper');
const { computeMasteryFromSubmissions } = require('../utils/studentProgress');
const { computeAcademicProgress } = require('../services/supabaseAcademicProgressService');
const { uploadFile } = require('../services/storageService');
const { resolveStoredFileUrl, downloadOrRedirectStoredFile } = require('../utils/fileStorage');
const { findSectionById, normalizeSectionId } = require('../services/sectionService');
const { findSupabaseAccount, listSupabaseAccounts } = require('../services/supabaseAccountService');
const { listSupabaseAssessments, listSupabaseLessons, findSupabaseLesson } = require('../services/supabaseContentService');
const { findSubjectByCode } = require('../services/subjectService');
const {
  findEnrollment,
  listHydratedStudentEnrollments,
  saveEnrollmentRequest,
} = require('../services/supabaseEnrollmentService');
const {
  notifyAutomatedGrade,
  notifySubmissionCompleted,
  safelyRunNotificationTask,
} = require('../services/studentNotificationService');
const {
  notifyEnrollmentRequest,
  notifyExamIncident,
  notifyTeacherSubmission,
} = require('../services/teacherNotificationService');
const {
  findActivitySubmission,
  listStudentActivitySubmissions,
  saveActivitySubmission,
} = require('../services/supabaseActivityService');
const {
  listLessonProgress,
  recordLessonProgress,
  buildAssessmentGates,
  assertAssessmentUnlocked,
} = require('../services/supabaseProgressionService');
const { evaluateAssessmentAnswers, validateEssayWordCounts } = require('../services/essayEvaluationService');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const CONTACT_NUMBER_REGEX = /^\+?[0-9()\-. ]{7,30}$/;
const ALLOWED_STUDENT_GRADE_LEVELS = ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'];
const GRADE_TEN_LEVEL = 'Grade 10';
const PASSING_PERCENTAGE = 50;
const DEFAULT_MAX_VIOLATIONS = 3;
const DEFAULT_VIOLATION_ACTION = 'auto-submit';

function isAssessmentDeadlinePassed(assessment) {
  const deadline = assessment?.submissionDeadline ? new Date(assessment.submissionDeadline) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() <= Date.now();
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeForCompare(value) {
  return String(value || '').trim().toLowerCase();
}

function parseExamDurationMinutes(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) return 30;
  return parsed;
}

function computeExamExpiry(submission) {
  const startedAt = submission?.startedAt ? new Date(submission.startedAt) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) return null;
  const examDurationMinutes = parseExamDurationMinutes(submission?.examDurationMinutes);
  return new Date(startedAt.getTime() + (examDurationMinutes * 60 * 1000));
}

function isSubmissionExpired(submission) {
  const expiresAt = computeExamExpiry(submission);
  if (!expiresAt) return false;
  return expiresAt.getTime() <= Date.now();
}

function calculateAssessmentScore(assessment, answers) {
  const answerMap = new Map();
  (Array.isArray(answers) ? answers : []).forEach((item) => {
    if (item && Number.isInteger(item.questionIndex)) {
      answerMap.set(item.questionIndex, String(item.answer || ''));
    }
  });

  let score = 0;
  let totalPoints = 0;

  (Array.isArray(assessment?.questions) ? assessment.questions : []).forEach((question, index) => {
    const points = Number(question?.points || 1);
    totalPoints += points;

    const isObjectiveType = ['multiple-choice', 'true-false'].includes(question?.type);
    const hasAnswer = normalizeForCompare(question?.correctAnswer).length > 0;

    if (!isObjectiveType || !hasAnswer) return;

    const studentAnswer = normalizeForCompare(answerMap.get(index));
    const correctAnswer = normalizeForCompare(question.correctAnswer);
    if (studentAnswer && studentAnswer === correctAnswer) {
      score += points;
    }
  });

  return { score, totalPoints };
}

function publicAssessment(assessment) {
  const plain = assessment.toObject ? assessment.toObject() : assessment;
  return {
    ...plain,
    examDurationMinutes: parseExamDurationMinutes(plain.examDurationMinutes),
    maxViolations: Number(plain.maxViolations || DEFAULT_MAX_VIOLATIONS),
    violationAction: String(plain.violationAction || DEFAULT_VIOLATION_ACTION),
    assessmentMode: String(plain.assessmentMode || 'activity'),
    gradingPeriod: normalizeGradingPeriod(plain.gradingPeriod),
    countsTowardRecommendation: Boolean(plain.countsTowardRecommendation)
      && Boolean(normalizeGradingPeriod(plain.gradingPeriod)),
    assignmentScope: String(plain.assignmentScope || 'handled_class'),
    questions: (plain.questions || []).map((q) => ({
      questionText: q.questionText,
      type: q.type,
      options: q.options,
      points: q.points,
      explanation: q.explanation,
      instructions: q.instructions || '',
      rubric: q.rubric || '',
      minWords: q.minWords ?? null,
      maxWords: q.maxWords ?? null,
    })),
  };
}

function userProfileImageToUrl(user, req) {
  const raw = String(user?.profileImage || '').trim();
  if (!raw) return '';
  return resolveStoredFileUrl(req, raw);
}

function studentProfileResponse(user, req) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    strand: user.strand || '',
    gradeLevel: user.gradeLevel || '',
    sectionId: String(user.sectionId || '').trim(),
    status: user.status || 'active',
    contactNumber: user.contactNumber || '',
    profileImage: userProfileImageToUrl(user, req),
    hasCompletedStudentTour: user.hasCompletedStudentTour === true,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

function subjectResponse(subject, enrollment = null) {
  return {
    id: String(subject?._id || ''),
    name: String(subject?.name || '').trim(),
    className: String(subject?.className || '').trim(),
    code: String(subject?.code || '').trim(),
    track: String(subject?.track || '').trim(),
    subjectCategory: String(subject?.subjectCategory || '').trim(),
    department: String(subject?.department || '').trim(),
    description: String(subject?.description || '').trim(),
    teacherId: String(subject?.teacherId || '').trim(),
    enrollmentStatus: String(enrollment?.status || '').trim(),
    requestedAt: enrollment?.requestedAt || null,
    decidedAt: enrollment?.decidedAt || null,
    createdAt: subject?.createdAt || null,
  };
}

async function resolveStudentSectionContext(studentId, req) {
  const student = await findSupabaseAccount('id', String(studentId || '').trim());
  const sectionId = normalizeSectionId(student?.sectionId);
  const sectionRow = sectionId ? await findSectionById(sectionId) : null;
  const section = sectionRow
    ? { id: String(sectionRow.id || '').trim(), name: String(sectionRow.name || '').trim() }
    : null;

  if (!section?.id) {
    return {
      section: null,
      adviser: null,
    };
  }

  const accounts = await listSupabaseAccounts();
  const adviser = accounts.find((account) => (
    String(account?.role || '').trim() === 'teacher'
    && normalizeSectionId(account?.advisorySectionId) === section.id
  )) || null;

  return {
    section,
    adviser: adviser
      ? {
        id: String(adviser._id || ''),
        name: String(adviser.name || '').trim(),
        email: String(adviser.email || '').trim(),
        department: String(adviser.department || '').trim(),
        subject: String(adviser.subject || adviser.department || '').trim(),
        profileImage: userProfileImageToUrl(adviser, req),
      }
      : null,
  };
}

function getLessonTrack(lesson) {
  return String(lesson?.track || '').trim();
}

function getAssessmentAssignedStudentIds(assessment) {
  return (Array.isArray(assessment?.assignedStudentIds) ? assessment.assignedStudentIds : [])
    .map((value) => String(value?._id || value || '').trim())
    .filter(Boolean);
}

function isPdfLikeAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || attachment?.mimetype || '').toLowerCase();
  const extension = String(attachment?.extension || path.extname(attachment?.originalName || attachment?.originalname || '') || '').toLowerCase();
  return mimeType === 'application/pdf' || extension === '.pdf';
}

function normalizeLessonAttachments(lesson) {
  const attachments = Array.isArray(lesson?.attachments) ? lesson.attachments : [];
  if (attachments.length > 0) return attachments;

  const legacyPath = String(lesson?.pdfPath || '').trim();
  const legacyName = String(lesson?.pdfOriginalName || '').trim();
  if (!legacyPath || !legacyName) return [];

  return [{
    _id: `legacy-${String(lesson?._id || '')}`,
    originalName: legacyName,
    storedPath: legacyPath,
    mimeType: 'application/pdf',
    extension: '.pdf',
    size: 0,
    uploadedAt: lesson?.createdAt || new Date(),
  }];
}

function resolvePrimaryLessonAttachment(lesson) {
  const attachments = normalizeLessonAttachments(lesson);
  if (attachments.length === 0) return null;
  return attachments.find((attachment) => isPdfLikeAttachment(attachment)) || attachments[0];
}

function normalizeAssessmentAttachments(assessment) {
  return Array.isArray(assessment?.attachments) ? assessment.attachments : [];
}

function toAssessmentAttachmentResponse(attachment, req) {
  return {
    id: String(attachment?._id || ''),
    fileName: String(attachment?.originalName || '').trim(),
    fileType: String(attachment?.mimeType || 'application/octet-stream').trim(),
    extension: String(attachment?.extension || '').trim().toLowerCase(),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || null,
    url: resolveStoredFileUrl(req, attachment?.storedPath, {
      fileName: attachment?.originalName || '',
    }),
    downloadUrl: resolveStoredFileUrl(req, attachment?.storedPath, {
      download: true,
      fileName: attachment?.originalName || '',
    }),
    canPreviewInline: String(attachment?.mimeType || '').toLowerCase().startsWith('image/')
      || isPdfLikeAttachment(attachment),
  };
}

function toAttachmentResponse(attachment, lessonId, req) {
  const host = `${req.protocol}://${req.get('host')}`;
  const attachmentId = String(attachment?._id || '');
  return {
    id: attachmentId,
    fileName: String(attachment?.originalName || '').trim(),
    fileType: String(attachment?.mimeType || 'application/octet-stream').trim(),
    extension: String(attachment?.extension || '').trim().toLowerCase(),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || null,
    url: resolveStoredFileUrl(req, attachment?.storedPath, {
      fileName: attachment?.originalName || '',
    }),
    downloadUrl: `${host}/api/student/lessons/${lessonId}/attachments/${attachmentId}/download`,
    canPreviewInline: String(attachment?.mimeType || '').toLowerCase().startsWith('image/')
      || isPdfLikeAttachment(attachment),
  };
}

function isPreviewableSubmissionAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || attachment?.mimetype || '').toLowerCase();
  return mimeType.startsWith('image/') || isPdfLikeAttachment(attachment);
}

function parseJsonArrayInput(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function normalizeSubmissionLinks(value) {
  const seen = new Set();
  return parseJsonArrayInput(value).reduce((links, item) => {
    const rawUrl = typeof item === 'string'
      ? item
      : String(item?.url || '').trim();
    if (!rawUrl) return links;

    let normalizedUrl = '';
    try {
      normalizedUrl = new URL(rawUrl).toString();
    } catch (_error) {
      return links;
    }

    const key = normalizedUrl.toLowerCase();
    if (seen.has(key)) return links;
    seen.add(key);
    links.push({
      url: normalizedUrl,
      addedAt: new Date(),
    });
    return links;
  }, []);
}

function normalizeObjectIdArray(value) {
  return parseJsonArrayInput(value)
    .map((item) => String(item?._id || item || '').trim())
    .filter(Boolean);
}

function toStoredSubmissionAttachment(attachment) {
  return {
    _id: attachment?._id,
    originalName: String(attachment?.originalName || '').trim(),
    storedPath: String(attachment?.storedPath || '').trim(),
    mimeType: String(attachment?.mimeType || 'application/octet-stream').trim(),
    extension: String(attachment?.extension || '').trim().toLowerCase(),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || new Date(),
  };
}

function toSubmissionAttachmentResponse(attachment, req) {
  return {
    id: String(attachment?._id || ''),
    fileName: String(attachment?.originalName || '').trim(),
    fileType: String(attachment?.mimeType || 'application/octet-stream').trim(),
    extension: String(attachment?.extension || '').trim().toLowerCase(),
    size: Number(attachment?.size || 0),
    uploadedAt: attachment?.uploadedAt || null,
    url: resolveStoredFileUrl(req, attachment?.storedPath, {
      fileName: attachment?.originalName || '',
    }),
    downloadUrl: resolveStoredFileUrl(req, attachment?.storedPath, {
      download: true,
      fileName: attachment?.originalName || '',
    }),
    canPreviewInline: isPreviewableSubmissionAttachment(attachment),
  };
}

function hasActivitySubmissionContent(submissionLike) {
  return Boolean(
    String(submissionLike?.responseText || '').trim()
    || (Array.isArray(submissionLike?.linkAttachments) && submissionLike.linkAttachments.length > 0)
    || (Array.isArray(submissionLike?.attachments) && submissionLike.attachments.length > 0)
  );
}

function toActivitySubmissionResponse(submission, req) {
  const assessment = submission?.assessmentId || {};
  const totalPoints = Number(submission?.totalPoints || 0);
  const score = Number(submission?.score || 0);
  const percentage = totalPoints > 0 ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;

  return {
    id: String(submission?._id || ''),
    assessmentId: String(assessment?._id || submission?.assessmentId || '').trim(),
    assessmentTitle: String(assessment?.title || '').trim(),
    assessmentMode: String(assessment?.assessmentMode || 'activity').trim().toLowerCase(),
    lessonId: String(assessment?.lessonId || '').trim(),
    submissionDeadline: assessment?.submissionDeadline || null,
    status: String(submission?.status || 'in_progress').trim().toLowerCase(),
    responseText: String(submission?.responseText || '').trim(),
    links: (Array.isArray(submission?.linkAttachments) ? submission.linkAttachments : [])
      .map((link, index) => ({
        id: String(link?._id || `link-${index + 1}`),
        url: String(link?.url || '').trim(),
        addedAt: link?.addedAt || null,
      }))
      .filter((link) => Boolean(link.url)),
    attachments: (Array.isArray(submission?.attachments) ? submission.attachments : [])
      .map((attachment) => toSubmissionAttachmentResponse(attachment, req))
      .filter((attachment) => Boolean(attachment.fileName)),
    draftSavedAt: submission?.draftSavedAt || null,
    submittedAt: submission?.submittedAt || null,
    gradedAt: submission?.gradedAt || null,
    gradeValue: submission?.gradeValue ?? null,
    teacherFeedback: String(submission?.teacherFeedback || '').trim(),
    isLate: submission?.isLate === true,
    returnedAt: submission?.returnedAt || null,
    score,
    totalPoints,
    percentage,
    hasContent: hasActivitySubmissionContent(submission),
    aiScore: submission?.aiScore ?? null,
    aiEvaluations: Array.isArray(submission?.aiEvaluations) ? submission.aiEvaluations : [],
    scoringStatus: String(submission?.scoringStatus || 'final'),
  };
}

async function findPublishedLessons() {
  return publishedLessons();
}

async function getStudentApprovedEnrollments(studentId) {
  return listHydratedStudentEnrollments(studentId, 'approved');
}

async function getStudentApprovedSubjectIds(studentId) {
  const rows = await getStudentApprovedEnrollments(studentId);
  return rows
    .map((row) => row?.subjectId?._id || null)
    .filter(Boolean);
}

async function assertStudentAssessmentAccess(studentId, assessmentId) {
  const approvedSubjectIds = await getStudentApprovedSubjectIds(studentId);
  const assessments = await availableAssessments(studentId, approvedSubjectIds);
  const assessment = assessments.find((item) => String(item?._id || item?.id || '') === String(assessmentId || ''));
  if (!assessment) {
    const error = new Error('Assessment not found or is not assigned to your class');
    error.statusCode = 403;
    throw error;
  }
  await assertAssessmentUnlocked(studentId, assessment, assessments);
  return assessment;
}

async function assertStudentActivityAssessmentAccess(studentId, assessmentId) {
  const approvedSubjectIds = await getStudentApprovedSubjectIds(studentId);
  const assessments = await availableAssessments(studentId, approvedSubjectIds);
  const assessment = assessments.find((item) => String(item?._id || '') === String(assessmentId || ''));
  if (!assessment) {
    const error = new Error('This activity is not assigned to your class');
    error.statusCode = 403;
    throw error;
  }
  if (String(assessment?.assessmentMode || 'activity').trim().toLowerCase() !== 'activity') {
    const error = new Error('This response workspace is only available for activity-type tasks');
    error.statusCode = 400;
    throw error;
  }
  await assertAssessmentUnlocked(studentId, assessment, assessments);
  return assessment;
}

async function uploadStudentSubmissionAttachments(files, studentId, assessmentId) {
  const normalizedFiles = uniqueBy(
    Array.isArray(files) ? files : [],
    (file) => `${String(file?.originalname || '').trim().toLowerCase()}:${String(file?.mimetype || '').trim().toLowerCase()}:${Number(file?.size || 0)}`
  );

  if (normalizedFiles.length === 0) return [];

  const uploads = await Promise.all(normalizedFiles.map((file) => uploadFile({
    file,
    folder: `student-submissions/${String(studentId || 'unknown')}/${String(assessmentId || 'unknown')}`,
  })));

  return uploads.map((file) => ({
    _id: crypto.randomUUID().replace(/-/g, ''),
    originalName: file.originalName,
    storedPath: file.storedPath,
    mimeType: file.mimeType,
    extension: file.extension,
    size: file.size,
    uploadedAt: file.uploadedAt,
  }));
}

async function saveActivitySubmissionState({ req, assessment, finalize = false }) {
  const now = new Date();
  const responseText = String(req.body?.responseText || req.body?.answerText || '').trim();
  const linkAttachments = normalizeSubmissionLinks(req.body?.links);
  const retainedAttachmentIds = normalizeObjectIdArray(req.body?.retainedAttachmentIds);
  const hasRetainedAttachmentIds = Object.prototype.hasOwnProperty.call(req.body || {}, 'retainedAttachmentIds');
  const uploadedFiles = Array.isArray(req.files?.attachments) ? req.files.attachments : [];

  let submission = await findActivitySubmission(req.user._id, assessment._id);

  const allowedTypes = new Set(Array.isArray(assessment.allowedSubmissionTypes)
    ? assessment.allowedSubmissionTypes
    : ['written', 'link', 'file']);
  if (responseText && !allowedTypes.has('written')) {
    const error = new Error('Written responses are not enabled for this activity');
    error.statusCode = 400;
    throw error;
  }
  if (linkAttachments.length > 0 && !allowedTypes.has('link')) {
    const error = new Error('External links are not enabled for this activity');
    error.statusCode = 400;
    throw error;
  }
  if (uploadedFiles.length > 0 && !allowedTypes.has('file')) {
    const error = new Error('File uploads are not enabled for this activity');
    error.statusCode = 400;
    throw error;
  }

  const currentStatus = String(submission?.status || '').trim().toLowerCase();
  if (submission && ['auto_submitted', 'terminated'].includes(currentStatus)) {
    const error = new Error('This activity can no longer be edited.');
    error.statusCode = 403;
    throw error;
  }

  if (submission && currentStatus === 'completed' && submission.gradedAt) {
    const error = new Error('Graded work can only be changed after the teacher returns it for revision.');
    error.statusCode = 409;
    throw error;
  }
  if (submission && currentStatus === 'completed' && assessment.allowResubmission === false) {
    const error = new Error(finalize
      ? 'Activity already submitted.'
      : 'Activity already submitted. Unsubmit it first before editing.');
    error.statusCode = 409;
    throw error;
  }

  if (isAssessmentDeadlinePassed(assessment) && assessment.allowLateSubmissions !== true) {
    const error = new Error('Deadline has passed. Submission is closed.');
    error.statusCode = 403;
    error.details = {
      submissionDeadline: assessment.submissionDeadline || null,
    };
    throw error;
  }

  if (!submission) {
    submission = {
      studentId: req.user._id,
      assessmentId: assessment._id,
      status: 'in_progress',
      score: 0,
      totalPoints: 0,
      submittedAt: null,
      startedAt: null,
      lastActivityAt: now,
      examDurationMinutes: parseExamDurationMinutes(assessment.examDurationMinutes),
      activityLog: [],
      attachments: [],
      linkAttachments: [],
    };
  }

  const existingAttachments = Array.isArray(submission.attachments) ? submission.attachments : [];
  const keptAttachments = hasRetainedAttachmentIds
    ? existingAttachments.filter((attachment) => retainedAttachmentIds.includes(String(attachment?._id || '')))
    : existingAttachments;
  const uploadedAttachments = await uploadStudentSubmissionAttachments(uploadedFiles, req.user._id, assessment._id);
  const nextAttachments = [
    ...keptAttachments.map((attachment) => toStoredSubmissionAttachment(attachment)),
    ...uploadedAttachments,
  ];

  if (finalize && !hasActivitySubmissionContent({
    responseText,
    linkAttachments,
    attachments: nextAttachments,
  })) {
    const error = new Error('Add a response, link, or file before turning in this activity.');
    error.statusCode = 400;
    throw error;
  }

  let activityEvaluation = null;
  const hasEssayQuestion = (Array.isArray(assessment.questions) ? assessment.questions : [])
    .some((question) => String(question?.type || '').trim().toLowerCase() === 'essay');
  if (finalize && hasEssayQuestion && responseText) {
    const answers = [{ questionIndex: 0, answer: responseText }];
    validateEssayWordCounts(assessment, answers);
    activityEvaluation = await evaluateAssessmentAnswers(assessment, answers);
  }

  submission.responseText = responseText;
  submission.linkAttachments = linkAttachments;
  submission.attachments = nextAttachments;
  submission.lastActivityAt = now;
  submission.draftSavedAt = now;
  submission.status = finalize ? 'completed' : 'in_progress';
  submission.submittedAt = finalize ? now : null;
  submission.isLate = finalize && isAssessmentDeadlinePassed(assessment);
  submission.gradeValue = null;
  submission.gradedAt = null;
  submission.returnedAt = null;
  submission.teacherFeedback = '';
  submission.score = Number(activityEvaluation?.score || 0);
  submission.totalPoints = Number(activityEvaluation?.totalPoints || 0);
  submission.aiScore = activityEvaluation?.aiScore ?? null;
  submission.aiEvaluations = activityEvaluation?.aiEvaluations || [];
  submission.scoringStatus = activityEvaluation?.scoringStatus || 'final';
  submission.teacherAdjustedScore = null;
  submission.autoSubmitted = false;
  submission.terminationReason = '';
  submission.activityLog = [
    ...(Array.isArray(submission.activityLog) ? submission.activityLog : []),
    {
      type: finalize ? 'manual_submit' : 'draft_saved',
      message: finalize ? 'Activity submitted by student.' : 'Activity draft saved by student.',
      metadata: {
        responseLength: responseText.length,
        linkCount: linkAttachments.length,
        attachmentCount: nextAttachments.length,
      },
      occurredAt: now,
    },
  ];

  return saveActivitySubmission(submission);
}

function assertGradeTenStudentAccess(req) {
  const role = String(req.user?.role || '').toLowerCase().trim();
  const gradeLevel = String(req.user?.gradeLevel || '').trim();
  if (role === 'student' && gradeLevel !== GRADE_TEN_LEVEL) {
    const error = new Error('This feature is available for Grade 10 students only');
    error.statusCode = 403;
    throw error;
  }
}

const getStudentLessons = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const approvedSubjectIds = await getStudentApprovedSubjectIds(req.user._id);
  if (approvedSubjectIds.length === 0) {
    return sendSuccess(res, 200, 'Lessons fetched successfully', { lessons: [] });
  }
  const [lessons, progressRows] = await Promise.all([
    findPublishedLessons(),
    listLessonProgress(req.user._id),
  ]);
  const progressByLessonId = new Map(progressRows.map((row) => [String(row.lessonId), row]));
  const dedupedLessons = uniqueBy(
    lessons.filter((lesson) => {
      const lessonSubjectId = String(lesson?.subjectId?._id || lesson?.subjectId || '').trim();
      return approvedSubjectIds.some((subjectId) => String(subjectId) === lessonSubjectId);
    }),
    (lesson) => String(lesson?._id || '')
  );

  const host = `${req.protocol}://${req.get('host')}`;

  return sendSuccess(res, 200, 'Lessons fetched successfully', {
    lessons: dedupedLessons.map((lesson) => {
      const attachments = normalizeLessonAttachments(lesson);
      const primaryAttachment = resolvePrimaryLessonAttachment(lesson);
      return {
      id: lesson._id,
      title: lesson.title,
      description: lesson.description,
      track: getLessonTrack(lesson),
      strand: getLessonTrack(lesson),
      subject: String(lesson?.subject || '').trim(),
      subjectId: String(lesson?.subjectId?._id || lesson?.subjectId || '').trim(),
      subjectCode: String(lesson?.subjectCode || lesson?.subjectId?.code || '').trim(),
      subjectCategory: String(lesson?.subjectCategory || '').trim(),
      className: String(lesson?.subjectId?.className || '').trim(),
      teacher: lesson.createdBy
        ? {
          id: lesson.createdBy._id,
          name: lesson.createdBy.name,
          email: lesson.createdBy.email,
          role: lesson.createdBy.role,
          strand: lesson.createdBy.strand || '',
          profileImage: userProfileImageToUrl(lesson.createdBy, req),
        }
        : null,
      pdfOriginalName: primaryAttachment?.originalName || lesson.pdfOriginalName,
      pdfPath: resolveStoredFileUrl(req, primaryAttachment?.storedPath || lesson.pdfPath, {
        fileName: primaryAttachment?.originalName || lesson.pdfOriginalName || '',
      }),
      attachments: attachments.map((attachment) => toAttachmentResponse(attachment, lesson._id, req)),
      downloadUrl: `${host}/api/student/lessons/${lesson._id}/download`,
      postedAt: lesson.createdAt,
      createdAt: lesson.createdAt,
      progress: progressByLessonId.get(String(lesson._id)) || {
        status: 'not_started',
        progressPercent: 0,
        engagementSeconds: 0,
        reachedEnd: false,
        startedAt: null,
        completedAt: null,
      },
    };
    }),
  });
});

const getStudentTeachers = asyncHandler(async (_req, res) => {
  const teachers = await User.find({ role: 'teacher', status: 'active' })
    .select('_id name email role strand profileImage')
    .sort({ name: 1 })
    .lean();
  const dedupedTeachers = uniqueBy(teachers, (teacher) => String(teacher?._id || ''));

  return sendSuccess(res, 200, 'Teachers fetched successfully', {
    teachers: dedupedTeachers.map((teacher) => {
      const id = String(teacher._id);
      const fixedTrack = String(teacher.strand || '').trim();
      const tracks = fixedTrack ? [fixedTrack] : [];
      return {
        id,
        name: teacher.name,
        email: teacher.email,
        role: teacher.role,
        strand: teacher.strand || '',
        profileImage: userProfileImageToUrl(teacher, _req),
        tracks,
        subjects: tracks,
      };
    }),
  });
});

const downloadStudentLessonPdf = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const lesson = await findSupabaseLesson(req.params.id);

  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const enrollment = await findEnrollment({
    studentId: req.user._id,
    subjectId: lesson.subjectId,
    status: 'approved',
  });
  if (!enrollment) {
    const error = new Error('You must be enrolled in this subject before downloading lessons');
    error.statusCode = 403;
    throw error;
  }

  const primaryAttachment = resolvePrimaryLessonAttachment(lesson);
  if (!primaryAttachment) {
    const error = new Error('Lesson has no downloadable files');
    error.statusCode = 404;
    throw error;
  }

  return downloadOrRedirectStoredFile(
    req,
    res,
    primaryAttachment.storedPath || lesson.pdfPath,
    primaryAttachment.originalName || lesson.pdfOriginalName
  );
});

const downloadStudentLessonAttachment = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const lesson = await findSupabaseLesson(req.params.id);

  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const enrollment = await findEnrollment({
    studentId: req.user._id,
    subjectId: lesson.subjectId,
    status: 'approved',
  });
  if (!enrollment) {
    const error = new Error('You must be enrolled in this subject before downloading attachments');
    error.statusCode = 403;
    throw error;
  }

  const attachments = normalizeLessonAttachments(lesson);
  const attachment = attachments.find((item) => String(item?._id || '') === String(req.params.attachmentId || ''));
  if (!attachment) {
    const error = new Error('Attachment not found');
    error.statusCode = 404;
    throw error;
  }

  return downloadOrRedirectStoredFile(req, res, attachment.storedPath, attachment.originalName);
});

const getAvailableAssessments = asyncHandler(async (_req, res) => {
  assertGradeTenStudentAccess(_req);
  const approvedSubjectIds = await getStudentApprovedSubjectIds(_req.user._id);
  const assessments = await availableAssessments(_req.user._id, approvedSubjectIds);
  const dedupedAssessments = uniqueBy(assessments, (item) => String(item?._id || ''));
  const filteredAssessments = dedupedAssessments.filter((item) => {
    const assignedStudentIds = getAssessmentAssignedStudentIds(item);
    if (assignedStudentIds.length > 0) {
      return assignedStudentIds.includes(String(_req.user._id || ''));
    }
    const effectiveSubjectId = String(item?.subjectId || item?.lessonId?.subjectId || '').trim();
    return approvedSubjectIds.some((subjectId) => String(subjectId) === effectiveSubjectId);
  });
  const gates = await buildAssessmentGates(_req.user._id, filteredAssessments);

  return sendSuccess(res, 200, 'Assessments fetched successfully', {
    assessments: filteredAssessments.map((item) => ({
      id: item._id,
      lessonId: item.lessonId?._id,
      lessonTitle: item.lessonId?.title,
      track: getLessonTrack(item.lessonId),
      subject: String(item.subject || item.lessonId?.subject || '').trim(),
      subjectId: String(item.subjectId || item.lessonId?.subjectId || '').trim(),
      subjectCode: String(item.subjectCode || item.lessonId?.subjectCode || '').trim(),
      lessonSubject: String(item.lessonId?.subject || '').trim(),
      title: item.title,
      examType: item.examType,
      subjectCategory: item.subjectCategory || 'Technical',
      difficulty: item.difficulty,
      numberOfItems: item.numberOfItems,
      activityPoints: Number.isInteger(Number(item.activityPoints)) && Number(item.activityPoints) >= 1
        ? Number(item.activityPoints)
        : null,
      allowedSubmissionTypes: Array.isArray(item.allowedSubmissionTypes)
        ? item.allowedSubmissionTypes
        : ['written', 'link', 'file'],
      allowResubmission: item.allowResubmission !== false,
      allowLateSubmissions: item.allowLateSubmissions === true,
      assessmentMode: String(item.assessmentMode || 'activity'),
      gradingPeriod: normalizeGradingPeriod(item.gradingPeriod),
      countsTowardRecommendation: Boolean(item.countsTowardRecommendation)
        && Boolean(normalizeGradingPeriod(item.gradingPeriod)),
      assignmentScope: String(item.assignmentScope || 'handled_class'),
      examDurationMinutes: parseExamDurationMinutes(item.examDurationMinutes),
      maxViolations: Number(item.maxViolations || DEFAULT_MAX_VIOLATIONS),
      violationAction: String(item.violationAction || DEFAULT_VIOLATION_ACTION),
      submissionDeadline: item.submissionDeadline || null,
      challengeDescription: String(item.challengeDescription || '').trim(),
      attachments: normalizeAssessmentAttachments(item).map((attachment) => toAssessmentAttachmentResponse(attachment, _req)),
      isDeadlinePassed: isAssessmentDeadlinePassed(item),
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      isLocked: gates.get(String(item._id || item.id))?.isLocked === true,
      lockReason: gates.get(String(item._id || item.id))?.lockReason || '',
      prerequisite: gates.get(String(item._id || item.id))?.prerequisite || null,
    })),
  });
});

const getAssessmentForExam = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const assessment = await assertStudentAssessmentAccess(req.user._id, req.params.id);
  const existingSubmission = await findActivitySubmission(req.user._id, assessment._id);

  const existingStatus = String(existingSubmission?.status || '').toLowerCase();
  const isFinalized = ['completed', 'auto_submitted', 'terminated'].includes(existingStatus);
  if (existingSubmission && isFinalized) {
    const percentage = Number(existingSubmission.totalPoints || 0) > 0
      ? Number(((Number(existingSubmission.score || 0) / Number(existingSubmission.totalPoints || 0)) * 100).toFixed(2))
      : 0;
    const error = new Error(`Assessment already submitted on ${new Date(existingSubmission.submittedAt).toISOString()}. Retake is not allowed.`);
    error.statusCode = 409;
    error.details = {
      submissionId: String(existingSubmission._id || ''),
      submittedAt: existingSubmission.submittedAt || null,
      score: Number(existingSubmission.score || 0),
      totalPoints: Number(existingSubmission.totalPoints || 0),
      percentage,
      status: existingSubmission.status || 'completed',
    };
    throw error;
  }
  if (isAssessmentDeadlinePassed(assessment)) {
    const error = new Error('Deadline has passed. Submission is closed.');
    error.statusCode = 403;
    error.details = {
      submissionDeadline: assessment.submissionDeadline || null,
    };
    throw error;
  }

  return sendSuccess(res, 200, 'Assessment fetched successfully', {
    assessment: publicAssessment(assessment),
    session: existingSubmission && existingStatus === 'in_progress'
      ? {
        status: 'in_progress',
        startedAt: existingSubmission.startedAt || null,
        examDurationMinutes: parseExamDurationMinutes(existingSubmission.examDurationMinutes || assessment.examDurationMinutes),
        violationCount: Number(existingSubmission.violationCount || 0),
      }
      : null,
    serverTime: new Date().toISOString(),
  });
});

async function finalizeSubmission({
  submission,
  assessment,
  answers,
  status,
  autoSubmitted = false,
  terminationReason = '',
  appendActivity = null,
}) {
  const normalizedAnswers = Array.isArray(answers) ? answers : [];
  const evaluation = await evaluateAssessmentAnswers(assessment, normalizedAnswers);
  const { score, totalPoints, aiScore, aiEvaluations, scoringStatus } = evaluation;
  const now = new Date();

  submission.answers = normalizedAnswers;
  submission.score = score;
  submission.totalPoints = totalPoints;
  submission.aiScore = aiScore;
  submission.aiEvaluations = aiEvaluations;
  submission.scoringStatus = scoringStatus;
  submission.teacherAdjustedScore = null;
  submission.submittedAt = now;
  submission.lastActivityAt = now;
  submission.status = status;
  submission.autoSubmitted = Boolean(autoSubmitted);
  submission.terminationReason = String(terminationReason || '').trim();
  submission.examDurationMinutes = parseExamDurationMinutes(
    submission.examDurationMinutes || assessment.examDurationMinutes
  );
  if (appendActivity && typeof appendActivity === 'object') {
    submission.activityLog = [
      ...(Array.isArray(submission.activityLog) ? submission.activityLog : []),
      {
        type: String(appendActivity.type || 'system_event'),
        message: String(appendActivity.message || 'Exam status updated by system'),
        metadata: appendActivity.metadata || {},
        occurredAt: now,
      },
    ];
  }
  submission = await saveActivitySubmission(submission);

  const percentage = totalPoints > 0 ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;
  const totalItems = Array.isArray(assessment.questions)
    ? assessment.questions.length
    : Number(assessment.numberOfItems || 0);
  let masteryProgress = { masteryProgress: 0, averageScore: 0, completedAssessments: 0, lastCalculatedAt: now };
  let recommendationSummary = null;
  try {
    recommendationSummary = await computeAcademicProgress(submission.studentId);
    const validSubjects = recommendationSummary.subjectPerformance.filter((item) => item.finalPercentage !== null);
    const averageScore = validSubjects.length
      ? Number((validSubjects.reduce((sum, item) => sum + Number(item.finalPercentage || 0), 0) / validSubjects.length).toFixed(2))
      : 0;
    masteryProgress = {
      masteryProgress: Math.round(averageScore),
      averageScore,
      completedAssessments: recommendationSummary.overallLearningProgress.activitiesCompleted
        + recommendationSummary.overallLearningProgress.quizzesCompleted
        + recommendationSummary.overallLearningProgress.examsCompleted,
      lastCalculatedAt: now,
    };
  } catch (recommendationError) {
    console.error('[RECOMMENDATION] recompute failed:', {
      studentId: String(submission.studentId || ''),
      assessmentId: String(submission.assessmentId || ''),
      status: String(status || ''),
      message: recommendationError?.message || 'Unknown recommendation error',
    });
  }

  await Promise.all([
    safelyRunNotificationTask('assessment submission', () => notifySubmissionCompleted({
      submission,
      assessment,
    })),
    ...(scoringStatus === 'final'
      ? [safelyRunNotificationTask('automated grade', () => notifyAutomatedGrade({
        submission,
        assessment,
      }))]
      : []),
    safelyRunNotificationTask('teacher submission', () => notifyTeacherSubmission({
      submission,
      assessment,
    })),
    ...(['auto_submitted', 'terminated'].includes(String(status || '').toLowerCase())
      ? [safelyRunNotificationTask('exam incident', () => notifyExamIncident({
        submission,
        assessment,
        action: String(status || '').toLowerCase(),
      }))]
      : []),
  ]);

  return {
    submission,
    summary: {
      id: submission._id,
      studentId: submission.studentId,
      assessmentId: submission.assessmentId,
      score,
      totalPoints,
      totalItems,
      percentage,
      status: submission.status || 'completed',
      passFailStatus: percentage >= PASSING_PERCENTAGE ? 'pass' : 'fail',
      submittedAt: submission.submittedAt,
      autoSubmitted: Boolean(submission.autoSubmitted),
      violationCount: Number(submission.violationCount || 0),
      terminationReason: submission.terminationReason || '',
      aiScore: submission.aiScore ?? null,
      aiEvaluations: Array.isArray(submission.aiEvaluations) ? submission.aiEvaluations : [],
      scoringStatus: submission.scoringStatus || 'final',
    },
    masteryProgress,
    recommendation: recommendationSummary,
  };
}

const startAssessmentSession = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const { id } = req.params;
  const assessment = await assertStudentAssessmentAccess(req.user._id, id);
  if (isAssessmentDeadlinePassed(assessment)) {
    const error = new Error('Deadline has passed. Submission is closed.');
    error.statusCode = 403;
    throw error;
  }

  let submission = await findActivitySubmission(req.user._id, assessment._id);
  const currentStatus = String(submission?.status || '').toLowerCase();

  if (submission && ['completed', 'auto_submitted', 'terminated'].includes(currentStatus)) {
    const error = new Error('Assessment already submitted. Retake is not allowed.');
    error.statusCode = 409;
    throw error;
  }

  if (submission && currentStatus === 'in_progress' && isSubmissionExpired(submission)) {
    const finalized = await finalizeSubmission({
      submission,
      assessment,
      answers: submission.answers || [],
      status: 'auto_submitted',
      autoSubmitted: true,
      terminationReason: 'timer_expired',
      appendActivity: {
        type: 'timer_expired',
        message: 'Exam timer expired. Exam auto-submitted.',
      },
    });
    return sendSuccess(res, 200, 'Existing session expired and was auto-submitted', {
      assessment: publicAssessment(assessment),
      session: null,
      submission: finalized.summary,
      masteryProgress: finalized.masteryProgress,
      recommendation: finalized.recommendation,
      serverTime: new Date().toISOString(),
    });
  }

  if (!submission) {
    submission = await saveActivitySubmission({
      studentId: req.user._id,
      assessmentId: assessment._id,
      answers: [],
      score: 0,
      totalPoints: 0,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      examDurationMinutes: parseExamDurationMinutes(assessment.examDurationMinutes),
      violationCount: 0,
      activityLog: [{
        type: 'session_started',
        message: 'Exam session started.',
        metadata: {},
        occurredAt: new Date(),
      }],
      status: 'in_progress',
      autoSubmitted: false,
      terminationReason: '',
    });
  } else {
    submission.lastActivityAt = new Date();
    submission = await saveActivitySubmission(submission);
  }

  const expiresAt = computeExamExpiry(submission);
  const remainingMs = Math.max(0, Number(expiresAt ? expiresAt.getTime() - Date.now() : 0));

  return sendSuccess(res, 200, 'Exam session started', {
    assessment: publicAssessment(assessment),
    session: {
      id: String(submission._id || ''),
      status: submission.status,
      startedAt: submission.startedAt,
      expiresAt,
      remainingSeconds: Math.floor(remainingMs / 1000),
      examDurationMinutes: parseExamDurationMinutes(submission.examDurationMinutes),
      violationCount: Number(submission.violationCount || 0),
      maxViolations: Number(assessment.maxViolations || DEFAULT_MAX_VIOLATIONS),
      violationAction: String(assessment.violationAction || DEFAULT_VIOLATION_ACTION),
      answers: Array.isArray(submission.answers) ? submission.answers : [],
    },
    serverTime: new Date().toISOString(),
  });
});

const saveAssessmentProgress = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const { id } = req.params;
  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    const error = new Error('answers must be an array');
    error.statusCode = 400;
    throw error;
  }

  const assessment = await assertStudentAssessmentAccess(req.user._id, id);

  let submission = await findActivitySubmission(req.user._id, assessment._id);
  if (!submission || String(submission.status || '').toLowerCase() !== 'in_progress') {
    const error = new Error('Exam session is not active');
    error.statusCode = 403;
    throw error;
  }

  if (isSubmissionExpired(submission)) {
    const finalized = await finalizeSubmission({
      submission,
      assessment,
      answers: submission.answers || [],
      status: 'auto_submitted',
      autoSubmitted: true,
      terminationReason: 'timer_expired',
      appendActivity: {
        type: 'timer_expired',
        message: 'Exam timer expired. Exam auto-submitted.',
      },
    });
    const error = new Error('Exam timer has expired. Submission was auto-submitted.');
    error.statusCode = 409;
    error.details = { submission: finalized.summary };
    throw error;
  }

  submission.answers = answers;
  submission.lastActivityAt = new Date();
  submission = await saveActivitySubmission(submission);

  const expiresAt = computeExamExpiry(submission);
  const remainingMs = Math.max(0, Number(expiresAt ? expiresAt.getTime() - Date.now() : 0));

  return sendSuccess(res, 200, 'Exam progress saved', {
    session: {
      id: String(submission._id || ''),
      status: submission.status,
      startedAt: submission.startedAt,
      expiresAt,
      remainingSeconds: Math.floor(remainingMs / 1000),
      violationCount: Number(submission.violationCount || 0),
      answersSaved: Number(Array.isArray(submission.answers) ? submission.answers.length : 0),
      savedAt: submission.lastActivityAt,
    },
    serverTime: new Date().toISOString(),
  });
});

const logAssessmentActivity = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const { id } = req.params;
  const { type, message, metadata } = req.body || {};
  const normalizedType = String(type || '').trim().toLowerCase();
  if (!normalizedType) {
    const error = new Error('type is required');
    error.statusCode = 400;
    throw error;
  }

  const assessment = await assertStudentAssessmentAccess(req.user._id, id);

  let submission = await findActivitySubmission(req.user._id, assessment._id);
  if (!submission || String(submission.status || '').toLowerCase() !== 'in_progress') {
    const error = new Error('Exam session is not active');
    error.statusCode = 403;
    throw error;
  }

  const violationTypes = new Set([
    'tab_hidden',
    'window_blur',
    'fullscreen_exit',
    'navigation_attempt',
    'inspection_shortcut',
    'copy_attempt',
    'paste_attempt',
    'contextmenu_attempt',
  ]);
  const isViolation = violationTypes.has(normalizedType);
  const now = new Date();
  const normalizedMessage = String(message || '').trim()
    || `${normalizedType.replace(/_/g, ' ')} detected at ${now.toLocaleTimeString()}`;

  submission.activityLog = [
    ...(Array.isArray(submission.activityLog) ? submission.activityLog : []),
    {
      type: normalizedType,
      message: normalizedMessage,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      occurredAt: now,
    },
  ];
  if (isViolation) {
    submission.violationCount = Number(submission.violationCount || 0) + 1;
  }
  submission.lastActivityAt = now;

  const maxViolations = Number(assessment.maxViolations || DEFAULT_MAX_VIOLATIONS);
  const violationAction = String(assessment.violationAction || DEFAULT_VIOLATION_ACTION);
  const reachedLimit = isViolation && Number(submission.violationCount || 0) >= maxViolations;

  if (reachedLimit && violationAction === 'auto-submit') {
    const finalized = await finalizeSubmission({
      submission,
      assessment,
      answers: submission.answers || [],
      status: 'auto_submitted',
      autoSubmitted: true,
      terminationReason: 'max_violations',
      appendActivity: {
        type: 'max_violations_auto_submit',
        message: 'Maximum violations reached. Exam auto-submitted.',
      },
    });
    return sendSuccess(res, 200, 'Violation logged and exam auto-submitted', {
      ruleTriggered: true,
      violationCount: Number(finalized.submission.violationCount || 0),
      actionTaken: 'auto-submit',
      submission: finalized.summary,
      masteryProgress: finalized.masteryProgress,
      recommendation: finalized.recommendation,
      serverTime: new Date().toISOString(),
    });
  }

  if (reachedLimit && violationAction === 'terminate') {
    const finalized = await finalizeSubmission({
      submission,
      assessment,
      answers: submission.answers || [],
      status: 'terminated',
      autoSubmitted: false,
      terminationReason: 'max_violations',
      appendActivity: {
        type: 'max_violations_terminated',
        message: 'Maximum violations reached. Exam terminated.',
      },
    });
    return sendSuccess(res, 200, 'Violation logged and exam terminated', {
      ruleTriggered: true,
      violationCount: Number(finalized.submission.violationCount || 0),
      actionTaken: 'terminate',
      submission: finalized.summary,
      masteryProgress: finalized.masteryProgress,
      recommendation: finalized.recommendation,
      serverTime: new Date().toISOString(),
    });
  }

  if (reachedLimit && violationAction === 'pause') {
    submission = await saveActivitySubmission(submission);
    await safelyRunNotificationTask('paused assessment incident', () => notifyExamIncident({
      submission,
      assessment,
      student: req.user,
      action: 'paused',
    }));
    return sendSuccess(res, 200, 'Violation logged and exam paused', {
      ruleTriggered: true,
      violationCount: Number(submission.violationCount || 0),
      actionTaken: 'pause',
      pauseSeconds: 15,
      maxViolations,
      violationAction,
      serverTime: new Date().toISOString(),
    });
  }

  submission = await saveActivitySubmission(submission);

  return sendSuccess(res, 200, 'Exam activity logged', {
    ruleTriggered: false,
    violationCount: Number(submission.violationCount || 0),
    maxViolations,
    violationAction,
    serverTime: new Date().toISOString(),
  });
});

const submitAssessment = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const { id } = req.params;
  const { answers } = req.body;

  if (!Array.isArray(answers)) {
    const error = new Error('answers must be an array');
    error.statusCode = 400;
    throw error;
  }

  const assessment = await assertStudentAssessmentAccess(req.user._id, id);
  validateEssayWordCounts(assessment, answers);
  const existingSubmission = await findActivitySubmission(req.user._id, assessment._id);
  const existingStatus = String(existingSubmission?.status || '').toLowerCase();

  if (!existingSubmission || existingStatus !== 'in_progress') {
    if (['completed', 'auto_submitted', 'terminated'].includes(existingStatus)) {
      const error = new Error('Assessment already submitted. Retake is not allowed.');
      error.statusCode = 409;
      throw error;
    }
    const error = new Error('Exam session not started');
    error.statusCode = 403;
    throw error;
  }
  if (isAssessmentDeadlinePassed(assessment)) {
    const error = new Error('Deadline has passed. Submission is closed.');
    error.statusCode = 403;
    error.details = {
      submissionDeadline: assessment.submissionDeadline || null,
    };
    throw error;
  }

  if (isSubmissionExpired(existingSubmission)) {
    const finalized = await finalizeSubmission({
      submission: existingSubmission,
      assessment,
      answers: existingSubmission.answers || [],
      status: 'auto_submitted',
      autoSubmitted: true,
      terminationReason: 'timer_expired',
      appendActivity: {
        type: 'timer_expired',
        message: 'Exam timer expired. Exam auto-submitted.',
      },
    });
    return sendSuccess(res, 200, 'Exam timer expired. Auto-submitted.', {
      submission: finalized.summary,
      masteryProgress: finalized.masteryProgress,
      recommendation: finalized.recommendation,
    });
  }

  const finalized = await finalizeSubmission({
    submission: existingSubmission,
    assessment,
    answers,
    status: 'completed',
    autoSubmitted: false,
    terminationReason: '',
    appendActivity: {
      type: 'manual_submit',
      message: 'Exam submitted by student.',
    },
  });

  return sendSuccess(res, 201, 'Exam submitted successfully', {
    submission: finalized.summary,
    masteryProgress: finalized.masteryProgress,
    recommendation: finalized.recommendation,
  });
});

const getMySubmissions = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const submissions = await studentSubmissions(req.user._id, true);
  const dedupedSubmissions = uniqueBy(
    submissions,
    (submission) => `${String(submission?.studentId || '')}:${String(submission?.assessmentId?._id || submission?.assessmentId || '')}`
  );
  const scoredSubmissions = dedupedSubmissions.filter((submission) => {
    const assessmentMode = String(submission?.assessmentId?.assessmentMode || '').trim().toLowerCase();
    return assessmentMode !== 'activity' || Number(submission?.totalPoints || 0) > 0;
  });
  const masterySummary = computeMasteryFromSubmissions(scoredSubmissions.filter((submission) => (
    !['ai_assisted', 'pending_teacher_review'].includes(String(submission?.scoringStatus || '').trim().toLowerCase())
  )));

  return sendSuccess(res, 200, 'Submissions fetched successfully', {
    submissions: scoredSubmissions.map((submission) => {
      const score = Number(submission?.teacherAdjustedScore ?? submission?.gradeValue ?? submission?.score ?? 0);
      const totalPoints = Number(submission?.totalPoints || 0);
      const percentage = totalPoints > 0 ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;
      const totalItems = Array.isArray(submission?.assessmentId?.questions)
        ? submission.assessmentId.questions.length
        : Number(submission?.assessmentId?.numberOfItems || 0);

      return {
        ...submission,
        score,
        percentage,
        totalItems,
        status: submission?.status || 'completed',
        passFailStatus: percentage >= PASSING_PERCENTAGE ? 'pass' : 'fail',
      };
    }),
    summary: masterySummary,
  });
});

const getMyActivitySubmissions = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const approvedSubjectIds = await getStudentApprovedSubjectIds(req.user._id);
  const activityAssessments = (await availableAssessments(req.user._id, approvedSubjectIds))
    .filter((assessment) => String(assessment?.assessmentMode || '').trim().toLowerCase() === 'activity');
  const assessmentById = new Map(activityAssessments.map((assessment) => [String(assessment._id), assessment]));
  const activitySubmissions = (await listStudentActivitySubmissions(req.user._id))
    .filter((submission) => assessmentById.has(String(submission.assessmentId)))
    .map((submission) => ({ ...submission, assessmentId: assessmentById.get(String(submission.assessmentId)) }));

  return sendSuccess(res, 200, 'Activity submissions fetched successfully', {
    submissions: activitySubmissions.map((submission) => toActivitySubmissionResponse(submission, req)),
  });
});

const saveActivityResponseDraft = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const assessment = await assertStudentActivityAssessmentAccess(req.user._id, req.params.id);
  const submission = await saveActivitySubmissionState({
    req,
    assessment,
    finalize: false,
  });

  return sendSuccess(res, 200, 'Activity draft saved successfully', {
    submission: toActivitySubmissionResponse({ ...submission, assessmentId: assessment }, req),
  });
});

const turnInActivityResponse = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const assessment = await assertStudentActivityAssessmentAccess(req.user._id, req.params.id);
  const submission = await saveActivitySubmissionState({
    req,
    assessment,
    finalize: true,
  });

  await safelyRunNotificationTask('activity submission', () => notifySubmissionCompleted({
    submission,
    assessment,
  }));
  await safelyRunNotificationTask('teacher activity submission', () => notifyTeacherSubmission({
    submission,
    assessment,
    student: req.user,
  }));

  return sendSuccess(res, 201, 'Activity submitted successfully', {
    submission: toActivitySubmissionResponse({ ...submission, assessmentId: assessment }, req),
  });
});

const unsubmitActivityResponse = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const assessment = await assertStudentActivityAssessmentAccess(req.user._id, req.params.id);
  if (assessment.allowResubmission === false) {
    const error = new Error('The teacher has disabled editing and resubmission for this activity.');
    error.statusCode = 403;
    throw error;
  }
  if (isAssessmentDeadlinePassed(assessment) && assessment.allowLateSubmissions !== true) {
    const error = new Error('Deadline has passed. Unsubmit is no longer allowed.');
    error.statusCode = 403;
    throw error;
  }

  const submission = await findActivitySubmission(req.user._id, assessment._id);

  if (!submission || String(submission.status || '').trim().toLowerCase() !== 'completed') {
    const error = new Error('Only submitted activity work can be unsubmitted.');
    error.statusCode = 409;
    throw error;
  }

  if (submission.gradedAt || submission.gradeValue !== null) {
    const error = new Error('This work has already been graded and can no longer be unsubmitted.');
    error.statusCode = 403;
    throw error;
  }

  const now = new Date();
  submission.status = 'in_progress';
  submission.submittedAt = null;
  submission.lastActivityAt = now;
  submission.draftSavedAt = now;
  submission.activityLog = [
    ...(Array.isArray(submission.activityLog) ? submission.activityLog : []),
    {
      type: 'unsubmitted',
      message: 'Student unsubmitted the activity response.',
      occurredAt: now,
    },
  ];
  const savedSubmission = await saveActivitySubmission(submission);

  return sendSuccess(res, 200, 'Activity unsubmitted successfully', {
    submission: toActivitySubmissionResponse({ ...savedSubmission, assessmentId: assessment }, req),
  });
});

const updateStudentLessonProgress = asyncHandler(async (req, res) => {
  assertGradeTenStudentAccess(req);
  const lesson = await findSupabaseLesson(req.params.id);
  if (!lesson) throw Object.assign(new Error('Lesson not found'), { statusCode: 404 });
  const enrollment = await findEnrollment({ studentId: req.user._id, subjectId: lesson.subjectId, status: 'approved' });
  if (!enrollment) throw Object.assign(new Error('You must be enrolled in this subject to record lesson progress'), { statusCode: 403 });

  const progressPercent = Number(req.body?.progressPercent || 0);
  const engagementSeconds = Number(req.body?.engagementSeconds || 0);
  if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    throw Object.assign(new Error('progressPercent must be from 0 to 100'), { statusCode: 400 });
  }
  if (!Number.isFinite(engagementSeconds) || engagementSeconds < 0) {
    throw Object.assign(new Error('engagementSeconds must be a positive number'), { statusCode: 400 });
  }
  const progress = await recordLessonProgress({
    studentId: req.user._id,
    lessonId: lesson._id,
    progressPercent,
    reachedEnd: req.body?.reachedEnd === true,
    engagementSeconds,
  });
  return sendSuccess(res, 200, progress.status === 'completed'
    ? 'Lesson completed. Linked assessments are now available.'
    : 'Lesson progress saved.', { progress });
});

const getMySubjects = asyncHandler(async (req, res) => {

  const [approvedEnrollments, pendingEnrollments] = await Promise.all([
    listHydratedStudentEnrollments(req.user._id, 'approved'),
    listHydratedStudentEnrollments(req.user._id, 'pending'),
  ]);

  // Class membership is available to every student. Coursework and grade-based
  // recommendations remain limited to Grade 10, including their database writes.
  if (String(req.user?.gradeLevel || '').trim() !== GRADE_TEN_LEVEL) {
    const mapClassEnrollment = (row) => {
      const subject = row.subjectId || {};
      const teacher = row.teacherId || {};
      return {
        ...subjectResponse(subject, row),
        teacher: {
          id: String(teacher._id || ''),
          name: teacher.name || 'Teacher',
          email: teacher.email || '',
          profileImage: userProfileImageToUrl(teacher, req),
        },
      };
    };
    const studentContext = await resolveStudentSectionContext(req.user._id, req);
    return sendSuccess(res, 200, 'Subjects fetched successfully', {
      subjects: approvedEnrollments.map(mapClassEnrollment),
      pendingSubjects: pendingEnrollments.map(mapClassEnrollment),
      studentContext,
      insights: {},
    });
  }

  const approvedSubjectIds = approvedEnrollments
    .map((row) => row?.subjectId?._id || null)
    .filter(Boolean);

  const approvedSubjectIdSet = new Set(approvedSubjectIds.map(String));
  const contentResults = await Promise.allSettled([
    listSupabaseLessons(),
    listSupabaseAssessments(),
  ]);
  const [allLessons, allAssessments] = contentResults.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    console.error('[student subjects] Failed to load content counts:', index === 0 ? 'lessons' : 'assessments', result.reason?.code || 'unavailable');
    return [];
  });
  const lessons = allLessons.filter((lesson) => approvedSubjectIdSet.has(String(lesson.subjectId || '')));
  const assessments = allAssessments.filter((assessment) => approvedSubjectIdSet.has(String(assessment.subjectId || '')));
  const academicProgress = await computeAcademicProgress(req.user._id);

  const lessonCounts = new Map();
  lessons.forEach((lesson) => {
    const key = String(lesson?.subjectId || '');
    lessonCounts.set(key, Number(lessonCounts.get(key) || 0) + 1);
  });

  const assessmentCounts = new Map();
  assessments.forEach((assessment) => {
    const key = String(assessment?.subjectId || '');
    assessmentCounts.set(key, Number(assessmentCounts.get(key) || 0) + 1);
  });

  const subjectPerformanceById = new Map(
    (Array.isArray(academicProgress?.subjectPerformance) ? academicProgress.subjectPerformance : [])
      .map((item) => [String(item?.subjectId || ''), item])
  );

  const mapEnrollmentRow = (row) => {
    const subject = row.subjectId || {};
    const teacher = row.teacherId || {};
    const performance = subjectPerformanceById.get(String(subject._id || '')) || null;

    return {
      ...subjectResponse(subject, row),
      teacher: {
        id: String(teacher._id || ''),
        name: teacher.name || 'Teacher',
        email: teacher.email || '',
        profileImage: userProfileImageToUrl(teacher, req),
      },
      lessonCount: lessonCounts.get(String(subject._id || '')) || 0,
      assessmentCount: assessmentCounts.get(String(subject._id || '')) || 0,
      performance: performance
        ? {
          completedAssessments: Number(performance.completedAssessments || 0),
          averageScore: Number(performance.averageScore || 0),
          progress: Number(performance.progress || 0),
          latestCompletedAt: performance.latestCompletedAt || null,
        }
        : {
          completedAssessments: 0,
          averageScore: 0,
          progress: 0,
          latestCompletedAt: null,
        },
    };
  };

  const studentContext = await resolveStudentSectionContext(req.user._id, req);

  return sendSuccess(res, 200, 'Subjects fetched successfully', {
    subjects: approvedEnrollments.map(mapEnrollmentRow),
    pendingSubjects: pendingEnrollments.map(mapEnrollmentRow),
    studentContext,
    insights: {
      ...academicProgress,
    },
  });
});

const joinSubjectByCode = asyncHandler(async (req, res) => {
  const code = String(req.body?.code || req.body?.subjectCode || '').trim().toUpperCase();
  if (!code) {
    const error = new Error('Subject code is required');
    error.statusCode = 400;
    throw error;
  }

  const subject = await findSubjectByCode(code);
  if (!subject) {
    const error = new Error('Subject code is invalid');
    error.statusCode = 404;
    throw error;
  }

  const existing = await findEnrollment({
    studentId: req.user._id,
    subjectId: subject._id,
  });

  if (existing && existing.status === 'approved') {
    const error = new Error('You are already enrolled in this class');
    error.statusCode = 409;
    throw error;
  }

  if (existing && existing.status === 'pending') {
    const error = new Error('Your enrollment request is already pending approval');
    error.statusCode = 409;
    throw error;
  }

  const section = req.user?.sectionId
    ? await findSectionById(req.user.sectionId)
    : null;
  const enrollment = await saveEnrollmentRequest({
    studentId: req.user._id,
    subjectId: subject._id,
    teacherId: subject.teacherId,
    sectionId: req.user?.sectionId || null,
    sectionName: String(section?.name || '').trim(),
  });

  await safelyRunNotificationTask('enrollment request', () => notifyEnrollmentRequest({
    enrollment,
    student: req.user,
    subject,
  }));

  return sendSuccess(res, 201, 'Enrollment request sent successfully', {
    request: {
      id: String(enrollment._id),
      subject: subjectResponse(subject, enrollment),
    },
  });
});

const getStudentProfile = asyncHandler(async (req, res) => {
  const studentContext = await resolveStudentSectionContext(req.user._id, req);
  return sendSuccess(res, 200, 'Profile fetched successfully', {
    user: {
      ...studentProfileResponse(req.user, req),
      section: studentContext.section,
      adviser: studentContext.adviser,
    },
  });
});

const updateStudentProfile = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || req.body?.fullName || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const contactNumberRaw = String(req.body?.contactNumber || req.body?.phone || '').trim();
  const gradeLevel = String(req.body?.gradeLevel || '').trim();
  const existingGradeLevel = String(req.user?.gradeLevel || '').trim();
  const resolvedGradeLevel = gradeLevel || existingGradeLevel;
  const uploadedImage = req.file || null;

  console.log('[TEMP][updateStudentProfile] incoming payload:', {
    userId: String(req.user?._id || ''),
    role: req.user?.role || '',
    name,
    email,
    contactNumberRaw,
    gradeLevel,
    hasProfileImage: Boolean(uploadedImage),
    profileImageMeta: uploadedImage
      ? { originalname: uploadedImage.originalname, mimetype: uploadedImage.mimetype, size: uploadedImage.size, filename: uploadedImage.filename }
      : null,
  });

  if (!name) {
    const error = new Error('Name is required');
    error.statusCode = 400;
    throw error;
  }

  if (!email) {
    const error = new Error('Email is required');
    error.statusCode = 400;
    throw error;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    const error = new Error('Please provide a valid email');
    error.statusCode = 400;
    throw error;
  }

  if (email !== String(req.user.email || '').toLowerCase()) {
    const existing = await User.findOne({ email, _id: { $ne: req.user._id } }).select('_id');
    if (existing) {
      const error = new Error('Email already exists');
      error.statusCode = 409;
      throw error;
    }
  }

  if (contactNumberRaw) {
    const normalizedContact = contactNumberRaw.replace(/\s+/g, ' ');
    if (normalizedContact.length > 30) {
      const error = new Error('Contact number must be 30 characters or fewer');
      error.statusCode = 400;
      throw error;
    }
    if (!CONTACT_NUMBER_REGEX.test(normalizedContact)) {
      const error = new Error('Contact number format is invalid');
      error.statusCode = 400;
      throw error;
    }
    req.user.contactNumber = normalizedContact;
  } else {
    req.user.contactNumber = '';
  }

  req.user.name = name;
  req.user.email = email;
  if (req.user.role === 'student') {
    if (resolvedGradeLevel && !ALLOWED_STUDENT_GRADE_LEVELS.includes(resolvedGradeLevel)) {
      const error = new Error(`Grade level must be one of: ${ALLOWED_STUDENT_GRADE_LEVELS.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
    req.user.gradeLevel = resolvedGradeLevel;
  } else {
    req.user.gradeLevel = '';
  }

  if (uploadedImage) {
    const uploadedProfile = await uploadFile({
      file: uploadedImage,
      folder: `profile-images/students/${String(req.user?._id || 'unknown')}`,
    });
    req.user.profileImage = uploadedProfile.storedPath;
  }

  await req.user.save();
  console.log('[TEMP][updateStudentProfile] saved user snapshot:', {
    userId: String(req.user?._id || ''),
    name: req.user.name,
    email: req.user.email,
    gradeLevel: req.user.gradeLevel,
    contactNumber: req.user.contactNumber || '',
    profileImage: req.user.profileImage || '',
  });

  return sendSuccess(res, 200, 'Profile updated successfully', {
    user: studentProfileResponse(req.user, req),
  });
});

const updateStudentTourPreference = asyncHandler(async (req, res) => {
  req.user.hasCompletedStudentTour = req.body?.hasCompletedStudentTour === true;
  await req.user.save();

  return sendSuccess(res, 200, 'Student tour preference updated successfully', {
    user: studentProfileResponse(req.user, req),
  });
});

module.exports = {
  getMySubjects,
  joinSubjectByCode,
  getStudentLessons,
  updateStudentLessonProgress,
  getStudentTeachers,
  downloadStudentLessonPdf,
  downloadStudentLessonAttachment,
  getAvailableAssessments,
  getAssessmentForExam,
  startAssessmentSession,
  saveAssessmentProgress,
  logAssessmentActivity,
  submitAssessment,
  getMySubmissions,
  getMyActivitySubmissions,
  saveActivityResponseDraft,
  turnInActivityResponse,
  unsubmitActivityResponse,
  getStudentProfile,
  updateStudentProfile,
  updateStudentTourPreference,
};
