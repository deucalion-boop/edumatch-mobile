const { subjectStudents, removeSubjectStudent, requireTeacherSubject, saveStudentProgress } = require('../services/supabaseTeacherStudentsService');
const { readProfileRows } = require('../services/supabaseUserProfileService');
const { teacherRequests, decideTeacherRequest, teacherResultData } = require('../services/supabaseTeacherRecordsService');
const { nameError, phoneError } = require('../utils/teacherValidation');
const path = require('path');
const crypto = require('crypto');
const Lesson = require('../models/Lesson');
const Assessment = require('../models/Assessment');
const Submission = require('../models/Submission');
const Recommendation = require('../models/Recommendation');
const { sendSuccess } = require('../utils/responseHelper');
const { computeMasteryFromSubmissions } = require('../utils/studentProgress');
const { inferSubjectCategory, normalizeSubjectCategory } = require('../services/recommendationService');
const {
  buildAssessmentPolicy,
  parseSubmissionDeadline,
  parseExamDurationMinutes,
  isPastDate,
  resolveAssignedStudentIds,
  assertUniqueGradingAssessment,
} = require('../services/assessmentPolicyService');
const {
  deleteTeacherSubject,
  ensureTeacherSubject,
  findTeacherSubject,
  getTeacherSubjectCounts,
  listTeacherSubjects,
  updateAttendanceClassName,
  updateTeacherSubject,
} = require('../services/subjectService');
const { uploadFile, uploadFiles } = require('../services/storageService');
const { ROLE_STUDENT } = require('../constants/userRoles');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');
const { normalizeContactNumber, issueInviteForUser, mapUserResponse } = require('../services/userManagementService');
const { getSectionOrThrow } = require('../services/sectionService');
const { resolveStoredFileUrl, downloadOrRedirectStoredFile } = require('../utils/fileStorage');
const { buildExcludeArchivedStudentsFilter, isArchivedStudent } = require('../utils/studentArchive');
const {
  createSupabaseAccount,
  findSupabaseAccountByEmail,
  findSupabaseAccountByUsername,
} = require('../services/supabaseAccountService');
const {
  createSupabaseLesson,
  listSupabaseLessons,
  findSupabaseLesson,
  findSupabaseAssessment,
  createSupabaseAssessment,
  listSupabaseAssessments,
  updateSupabaseAssessment,
} = require('../services/supabaseContentService');
const {
  notifyAssessmentAssigned,
  notifyLessonPublished,
  approvedStudentsForSubject,
  createStudentNotifications,
  safelyRunNotificationTask,
} = require('../services/studentNotificationService');
const {
  STRANDS,
  normalizeStrand,
  getSubjectsByStrand,
  isSubjectAllowedForStrand,
  getSubjectCategory,
} = require('../constants/strandSubjects');
const { findActivitySubmissionById, updateActivityReview } = require('../services/supabaseActivityService');
const { getSupabaseStorageClient } = require('../services/supabaseStorageService');
const { syncStudentSubjectGradeRecords } = require('../services/supabaseGradeRecordService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const CONTACT_NUMBER_REGEX = /^\+?[0-9()\-. ]{7,30}$/;
const ALLOWED_TEACHER_STRANDS = ['', 'STEM', 'HUMSS', 'ABM', 'TVL'];
const PASSING_PERCENTAGE = 50;
const SUBJECT_CATEGORIES = ['Math', 'Science', 'English', 'AP', 'Business', 'Technical'];
function resolveAssessmentSubjectCategory({ subjectCategory, examType, title, lessonTrack }) {
  const resolved = normalizeSubjectCategory(subjectCategory)
    || inferSubjectCategory({ subjectCategory, examType, title, lessonTrack })
    || 'Technical';
  return SUBJECT_CATEGORIES.includes(resolved) ? resolved : 'Technical';
}

function normalizeLessonStrand(input, fallback = '') {
  return normalizeStrand(input || fallback);
}

function normalizeLessonSubject(input) {
  return String(input || '').trim();
}

function buildActivityTitleFromDescription(input) {
  const normalized = String(input || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Classroom Activity';
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57).trimEnd()}...`;
}

function parseActivityPoints(value, fallback = null) {
  const normalized = value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : Number(value);

  if (normalized === null) return null;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 100) {
    const error = new Error('activityPoints must be a whole number from 1 to 100');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

const ACTIVITY_SUBMISSION_TYPES = ['written', 'link', 'file'];

function parseBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

function parseActivitySubmissionTypes(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (_error) { parsed = value.split(','); }
  }
  const normalized = [...new Set((Array.isArray(parsed) ? parsed : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => ACTIVITY_SUBMISSION_TYPES.includes(item)))];
  if (normalized.length === 0) {
    const error = new Error('Select at least one allowed activity submission type');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

const ASSESSMENT_QUESTION_TYPES = new Set(['multiple-choice', 'true-false', 'short-answer', 'essay']);
const TOS_LEARNING_AREAS = new Set(['Language and Communication', 'Mathematics and Quantitative Reasoning', 'Science and Scientific Reasoning', 'Social Science and Humanities', 'Business and Entrepreneurship', 'Technology and Practical/Vocational Reasoning']);
const TOS_COGNITIVE_LEVELS = new Set(['Remembering', 'Understanding', 'Applying', 'Analyzing', 'Evaluating', 'Creating']);

function parseAssessmentQuestions(value) {
  if (Array.isArray(value)) return value;
  if (!String(value || '').trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    throw Object.assign(new Error('questions must contain valid JSON'), { statusCode: 400 });
  }
}

function normalizeAssessmentQuestions(value) {
  if (!Array.isArray(value)) {
    const error = new Error('questions must be an array');
    error.statusCode = 400;
    throw error;
  }
  return value.map((question, index) => {
    const type = String(question?.type || 'multiple-choice').trim().toLowerCase();
    const questionText = String(question?.questionText || '').trim();
    const points = Number(question?.points || 1);
    const minWords = question?.minWords === null || question?.minWords === undefined || question?.minWords === '' ? null : Number(question.minWords);
    const maxWords = question?.maxWords === null || question?.maxWords === undefined || question?.maxWords === '' ? null : Number(question.maxWords);
    if (!questionText) throw Object.assign(new Error(`Question ${index + 1} is required`), { statusCode: 400 });
    if (!ASSESSMENT_QUESTION_TYPES.has(type)) throw Object.assign(new Error(`Question ${index + 1} has an unsupported type`), { statusCode: 400 });
    if (!Number.isFinite(points) || points <= 0 || points > 500) throw Object.assign(new Error(`Question ${index + 1} points must be from 1 to 500`), { statusCode: 400 });
    if (minWords !== null && (!Number.isInteger(minWords) || minWords < 0 || minWords > 10000)) throw Object.assign(new Error(`Question ${index + 1} minimum words is invalid`), { statusCode: 400 });
    if (maxWords !== null && (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 10000)) throw Object.assign(new Error(`Question ${index + 1} maximum words is invalid`), { statusCode: 400 });
    if (minWords !== null && maxWords !== null && minWords > maxWords) throw Object.assign(new Error(`Question ${index + 1} minimum words cannot exceed maximum words`), { statusCode: 400 });
    return {
      questionText,
      type,
      options: type === 'essay' ? [] : (Array.isArray(question?.options) ? question.options.map((item) => String(item || '').trim()).filter(Boolean) : []),
      correctAnswer: type === 'essay' ? String(question?.expectedAnswer || question?.correctAnswer || '').trim() : String(question?.correctAnswer || '').trim(),
      points,
      explanation: String(question?.explanation || '').trim(),
      instructions: String(question?.instructions || '').trim(),
      expectedAnswer: String(question?.expectedAnswer || question?.correctAnswer || '').trim(),
      rubric: String(question?.rubric || '').trim(),
      learningArea: TOS_LEARNING_AREAS.has(String(question?.learningArea || '').trim()) ? String(question.learningArea).trim() : '',
      competency: String(question?.competency || '').trim().slice(0, 300),
      cognitiveLevel: TOS_COGNITIVE_LEVELS.has(String(question?.cognitiveLevel || '').trim()) ? String(question.cognitiveLevel).trim() : '',
      minWords,
      maxWords,
    };
  });
}

function getAssignedTeacherSubject(user) {
  return String(user?.subject || '').trim();
}

function ensureTeacherSubjectAccess(user, requestedSubject) {
  const assignedSubject = getAssignedTeacherSubject(user);
  if (!assignedSubject) {
    const error = new Error('Your teacher profile is missing an assigned subject. Please contact the administrator.');
    error.statusCode = 400;
    throw error;
  }

  if (requestedSubject && requestedSubject !== assignedSubject) {
    const error = new Error(`You can only create lessons and assessments for your assigned subject: ${assignedSubject}`);
    error.statusCode = 403;
    throw error;
  }

  return assignedSubject;
}

function normalizeKeyPart(value) {
  return String(value || '').trim().toLowerCase();
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

function buildTeacherAssessmentAccessQuery({ teacherId, allowedSubjectIds = [], includeUnlinkedActivities = false }) {
  const normalizedTeacherId = String(teacherId || '').trim();
  const normalizedSubjectIds = (Array.isArray(allowedSubjectIds) ? allowedSubjectIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const orClauses = [];

  if (normalizedSubjectIds.length > 0) {
    orClauses.push({ subjectId: { $in: normalizedSubjectIds } });
  }

  if (includeUnlinkedActivities) {
    orClauses.push({ assessmentMode: 'activity', lessonId: null });
  }

  if (orClauses.length === 0) {
    return { createdBy: normalizedTeacherId, _id: null };
  }

  if (orClauses.length === 1) {
    return {
      createdBy: normalizedTeacherId,
      ...orClauses[0],
    };
  }

  return {
    createdBy: normalizedTeacherId,
    $or: orClauses,
  };
}

function formatCountLabel(count, singular, plural = `${singular}s`) {
  const normalizedCount = Number(count || 0);
  return `${normalizedCount} ${normalizedCount === 1 ? singular : plural}`;
}

function joinWithAnd(items) {
  const normalizedItems = (Array.isArray(items) ? items : []).filter(Boolean);
  if (normalizedItems.length === 0) return '';
  if (normalizedItems.length === 1) return normalizedItems[0];
  if (normalizedItems.length === 2) return `${normalizedItems[0]} and ${normalizedItems[1]}`;
  return `${normalizedItems.slice(0, -1).join(', ')}, and ${normalizedItems[normalizedItems.length - 1]}`;
}

function teacherProfileResponse(user, req) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    strand: user.strand || '',
    subject: user.subject || '',
    department: user.department || '',
    advisorySectionId: String(user.advisorySectionId || '').trim(),
    profileImage: userProfileImageToUrl(user, req),
    contactNumber: user.contactNumber || '',
    hasCompletedTeacherTour: user.hasCompletedTeacherTour === true,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

const createStudentInvite = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    username,
    contactNumber,
  } = req.body || {};

  if (!name || !email) {
    const error = new Error('name and email are required');
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedUsername = String(username || '').trim();
  if (!String(req.user?.advisorySectionId || '').trim()) {
    const error = new Error('You must be assigned to an advisory section before creating student accounts');
    error.statusCode = 409;
    throw error;
  }
  const advisorySectionId = String(req.user?.advisorySectionId || '').trim();
  const existing = await findSupabaseAccountByEmail(normalizedEmail);
  if (existing) {
    const error = new Error('Email already exists');
    error.statusCode = 409;
    throw error;
  }

  if (!normalizedUsername) {
    const error = new Error('username is required');
    error.statusCode = 400;
    throw error;
  }

  if (normalizedUsername.length > 50) {
    const error = new Error('username must be 50 characters or fewer');
    error.statusCode = 400;
    throw error;
  }

  const existingUsername = await findSupabaseAccountByUsername(normalizedUsername);
  if (existingUsername) {
    const error = new Error('Username already exists');
    error.statusCode = 409;
    throw error;
  }

  const now = new Date();

  const created = await createSupabaseAccount({
    name: String(name).trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    role: ROLE_STUDENT,
    status: 'active',
    sectionId: advisorySectionId,
    department: String(req.user?.department || '').trim(),
    gradeLevel: 'Grade 10',
    contactNumber: normalizeContactNumber(contactNumber),
    managedBy: req.user._id,
    enrollment: {
      teacherId: req.user._id,
      status: 'approved',
      requestedAt: now,
      approvedAt: now,
    },
    invite: {
      tokenHash: '',
      expiresAt: null,
      sentAt: null,
      usedAt: null,
    },
  });

  const inviteResult = await issueInviteForUser({
    user: created,
    req,
  });

  return sendSuccess(res, 201, 'Student account created successfully', {
    user: mapUserResponse(created, req),
    invite: inviteResult,
  });
});

function getLessonTrack(lesson) {
  return String(lesson?.track || '').trim();
}

function getEnrollmentTrack(enrollment) {
  return String(enrollment?.track || '').trim();
}

function getEnrollmentTrackId(enrollment) {
  return String(enrollment?.trackId || '').trim();
}

function subjectToResponse(subject) {
  return {
    id: String(subject?._id || ''),
    name: String(subject?.name || '').trim(),
    className: String(subject?.className || '').trim(),
    code: String(subject?.code || '').trim(),
    track: String(subject?.track || '').trim(),
    subjectCategory: String(subject?.subjectCategory || '').trim(),
    department: String(subject?.department || '').trim(),
    description: String(subject?.description || '').trim(),
    teacherId: String(subject?.teacherId || ''),
    createdAt: subject?.createdAt || null,
    updatedAt: subject?.updatedAt || null,
  };
}

async function findTeacherSubjectRecord(teacherId, subjectId) {
  const normalizedTeacherId = String(teacherId || '').trim();
  const normalizedSubjectId = String(subjectId?._id || subjectId || '').trim();
  if (!normalizedTeacherId || !normalizedSubjectId) return null;

  return findTeacherSubject(normalizedTeacherId, normalizedSubjectId);
}

async function resolveTeacherSubjectRecord({
  teacherId,
  subjectId,
  subjectName,
  track,
  subjectCategory = '',
  className = '',
  department = '',
}) {
  const existing = await findTeacherSubjectRecord(teacherId, subjectId);
  if (existing) return existing;

  const normalizedSubjectName = String(subjectName || '').trim();
  const normalizedTrack = String(track || '').trim();
  if (!normalizedSubjectName || !normalizedTrack) return null;

  return ensureTeacherSubject({
    teacherId,
    name: normalizedSubjectName,
    track: normalizedTrack,
    subjectCategory,
    className,
    department,
  });
}

const createTeacherClass = asyncHandler(async (req, res) => {
  const className = String(req.body?.className || req.body?.name || '').trim();
  const requestedSubject = String(req.body?.subject || '').trim();
  const assignedSubject = ensureTeacherSubjectAccess(req.user, requestedSubject);
  const description = String(req.body?.description || '').trim();
  const track = normalizeLessonStrand(req.user?.strand || req.body?.track || 'GENERAL') || 'GENERAL';

  if (!className) {
    const error = new Error('className is required');
    error.statusCode = 400;
    throw error;
  }

  const subjectRecord = await ensureTeacherSubject({
    teacherId: req.user._id,
    name: assignedSubject,
    track,
    subjectCategory: getSubjectCategory(assignedSubject),
    className,
    description,
    department: String(req.user?.department || '').trim(),
  });

  return sendSuccess(res, 201, 'Class created successfully', {
    subject: subjectToResponse(subjectRecord),
  });
});

const updateTeacherClass = asyncHandler(async (req, res) => {
  const subjectId = String(req.params?.subjectId || '').trim();
  const className = String(req.body?.className || req.body?.name || '').trim();

  if (!subjectId) {
    const error = new Error('subjectId is required');
    error.statusCode = 400;
    throw error;
  }

  if (!className) {
    const error = new Error('className is required');
    error.statusCode = 400;
    throw error;
  }

  const subjectRecord = await findTeacherSubject(req.user._id, subjectId);

  if (!subjectRecord) {
    const error = new Error('Class not found');
    error.statusCode = 404;
    throw error;
  }

  const assignedSubject = ensureTeacherSubjectAccess(req.user, String(subjectRecord.name || '').trim());
  if (!className.toLowerCase().startsWith(assignedSubject.toLowerCase())) {
    const error = new Error(`Class name must start with the assigned subject: ${assignedSubject}.`);
    error.statusCode = 400;
    throw error;
  }

  const duplicateClass = (await listTeacherSubjects(req.user._id)).find((subject) => (
    String(subject.id) !== subjectId
    && String(subject.name).toLowerCase() === String(subjectRecord.name).toLowerCase()
    && String(subject.track).toLowerCase() === String(subjectRecord.track).toLowerCase()
    && String(subject.className).toLowerCase() === className.toLowerCase()
  ));

  if (duplicateClass) {
    const error = new Error('A class with that name already exists');
    error.statusCode = 409;
    throw error;
  }

  const updatedSubject = await updateTeacherSubject(req.user._id, subjectId, { className });
  await updateAttendanceClassName(req.user._id, subjectId, className);

  return sendSuccess(res, 200, 'Class updated successfully', {
    subject: subjectToResponse(updatedSubject),
  });
});

const deleteTeacherClass = asyncHandler(async (req, res) => {
  const subjectId = String(req.params?.subjectId || '').trim();
  if (!subjectId) {
    const error = new Error('subjectId is required');
    error.statusCode = 400;
    throw error;
  }

  const subject = await findTeacherSubject(req.user._id, subjectId);

  if (!subject) {
    const error = new Error('Class not found');
    error.statusCode = 404;
    throw error;
  }

  const counts = await getTeacherSubjectCounts(req.user._id);
  const lessonCount = counts.lessons.get(subjectId) || 0;
  const assessmentCount = counts.assessments.get(subjectId) || 0;
  const approvedStudentsCount = counts.approvedEnrollments.get(subjectId) || 0;
  const pendingRequestsCount = counts.pendingEnrollments.get(subjectId) || 0;
  const attendanceRecordCount = counts.attendance.get(subjectId) || 0;

  const deletionBlockers = [];
  if (lessonCount > 0) deletionBlockers.push(formatCountLabel(lessonCount, 'lesson'));
  if (assessmentCount > 0) deletionBlockers.push(formatCountLabel(assessmentCount, 'assessment'));
  if (approvedStudentsCount > 0) deletionBlockers.push(formatCountLabel(approvedStudentsCount, 'approved student'));
  if (pendingRequestsCount > 0) deletionBlockers.push(formatCountLabel(pendingRequestsCount, 'pending request'));
  if (attendanceRecordCount > 0) deletionBlockers.push(formatCountLabel(attendanceRecordCount, 'attendance record'));

  if (deletionBlockers.length > 0) {
    const error = new Error(`This class cannot be deleted because it still has ${joinWithAnd(deletionBlockers)}. Remove those items first.`);
    error.statusCode = 409;
    throw error;
  }

  await deleteTeacherSubject(req.user._id, subjectId);

  return sendSuccess(res, 200, 'Class deleted successfully', {
    subject: subjectToResponse(subject),
  });
});

async function syncTeacherSubjects(teacherId) {
  return listTeacherSubjects(teacherId);
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

function assessmentAttachmentKey(file) {
  return [
    String(file?.originalname || file?.originalName || file?.fileName || '').trim().toLowerCase(),
    Number(file?.size || 0),
  ].join(':');
}

async function uploadAssessmentAttachments(files, { teacherId, assessmentId = 'new' } = {}) {
  const rejected = [];
  const seen = new Set();
  const uniqueFiles = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (Number(file?.size || 0) > 10 * 1024 * 1024) {
      rejected.push({ fileName: String(file?.originalname || 'Attachment'), reason: 'File exceeds the 10MB limit' });
      continue;
    }
    const key = assessmentAttachmentKey(file);
    if (!key || seen.has(key)) {
      rejected.push({ fileName: String(file?.originalname || 'Attachment'), reason: 'Duplicate file' });
      continue;
    }
    seen.add(key);
    uniqueFiles.push(file);
  }

  const settled = await Promise.allSettled(uniqueFiles.map((file) => uploadFile({
    file,
    folder: `teacher-assessments/${String(teacherId || 'unknown')}/${String(assessmentId || 'new')}`,
  })));
  const uploaded = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const file = result.value;
      uploaded.push({
        originalName: file.originalName,
        storedPath: file.storedPath,
        mimeType: file.mimeType,
        extension: file.extension,
        size: file.size,
        uploadedAt: file.uploadedAt,
      });
      return;
    }
    rejected.push({
      fileName: String(uniqueFiles[index]?.originalname || 'Attachment'),
      reason: String(result.reason?.message || 'Upload failed'),
    });
  });
  return { uploaded, rejected };
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

function isPreviewableSubmissionAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || '').toLowerCase();
  return mimeType.startsWith('image/') || isPdfLikeAttachment(attachment);
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
    downloadUrl: `${host}/api/teacher/lessons/${lessonId}/attachments/${attachmentId}/download`,
    canPreviewInline: String(attachment?.mimeType || '').toLowerCase().startsWith('image/')
      || isPdfLikeAttachment(attachment),
  };
}

function lessonToResponse(lesson, req) {
  const host = `${req.protocol}://${req.get('host')}`;
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
    pdfOriginalName: primaryAttachment?.originalName || lesson.pdfOriginalName,
    pdfPath: resolveStoredFileUrl(req, primaryAttachment?.storedPath || lesson.pdfPath, {
      fileName: primaryAttachment?.originalName || lesson.pdfOriginalName || '',
    }),
    attachments: attachments.map((attachment) => toAttachmentResponse(attachment, lesson._id, req)),
    downloadUrl: `${host}/api/teacher/lessons/${lesson._id}/download`,
    createdBy: lesson.createdBy,
    createdAt: lesson.createdAt,
  };
}

function userProfileImageToUrl(user, req) {
  const raw = String(user?.profileImage || '').trim();
  if (!raw) return '';
  return resolveStoredFileUrl(req, raw);
}

const createLesson = asyncHandler(async (req, res) => {
  const {
    title,
    description,
    track,
    strand,
    subject,
    subjectCategory,
    trackId,
    lessonTitle,
    lessonContent,
    lessonModule,
    lessonObjectives,
    subjectId,
  } = req.body;

  const normalizedTitle = String(title || lessonTitle || '').trim();
  const requestedStrand = normalizeLessonStrand(strand || track || trackId || lessonModule);
  const normalizedTrack = requestedStrand || 'GENERAL';
  const requestedSubject = normalizeLessonSubject(subject || subjectCategory);
  const normalizedSubject = ensureTeacherSubjectAccess(req.user, requestedSubject);
  const normalizedSubjectCategory = getSubjectCategory(normalizedSubject);
  const normalizedDescription = String(
    description
      || lessonContent
      || lessonObjectives
      || ''
  ).trim();
  const uploadedFiles = Array.isArray(req.files?.lessonPlanFile) ? req.files.lessonPlanFile : [];

  console.log('[createLesson] request files keys:', Object.keys(req.files || {}));

  if (!normalizedTitle || !normalizedSubject || !normalizedDescription) {
    console.warn('[createLesson] validation failed:', {
      hasTitle: Boolean(normalizedTitle),
      hasSubject: Boolean(normalizedSubject),
      hasDescription: Boolean(normalizedDescription),
    });
    const error = new Error('title, subject, and description are required');
    error.statusCode = 400;
    throw error;
  }

  if (!STRANDS.includes(normalizedTrack)) {
    const error = new Error(`strand must be one of: ${STRANDS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  if (uploadedFiles.length !== 1) {
    console.warn('[createLesson] validation failed: missing lesson PDF file');
    const error = new Error('Exactly one lesson plan PDF is required');
    error.statusCode = 400;
    throw error;
  }

  const normalizedUploads = uniqueBy(uploadedFiles, (file) => {
    const originalName = String(file.originalname || '').trim().toLowerCase();
    const mimeType = String(file.mimetype || '').trim().toLowerCase();
    const size = Number(file.size || 0);
    return `${originalName}:${mimeType}:${size}`;
  });
  const uploadedAttachments = await uploadFiles(normalizedUploads, {
    folder: `teacher-lessons/${String(req.user?._id || 'unknown')}`,
  });
  const attachmentsPayload = uploadedAttachments.map((file) => ({
    originalName: file.originalName,
    storedPath: file.storedPath,
    mimeType: file.mimeType,
    extension: file.extension,
    size: file.size,
    uploadedAt: file.uploadedAt,
  }));
  const primaryAttachment = attachmentsPayload.find((file) => isPdfLikeAttachment(file)) || attachmentsPayload[0];

  let lesson;
  try {
    const normalizedSubjectId = String(subjectId || '').trim();
    if (!normalizedSubjectId) {
      const error = new Error('Select the class where this lesson should be posted.');
      error.statusCode = 400;
      throw error;
    }

    const lessonTrack = normalizedTrack;
    if (!isSubjectAllowedForStrand({ strand: lessonTrack, subject: normalizedSubject })) {
      const allowedSubjects = getSubjectsByStrand(lessonTrack);
      const error = new Error(`subject is invalid for strand ${lessonTrack}. Allowed subjects: ${allowedSubjects.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }

    const existingLessons = await listSupabaseLessons(req.user._id);
    const duplicateLesson = existingLessons.find((item) => (
      String(item.subjectId || '') === normalizedSubjectId
      && String(item.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
    ));

    if (duplicateLesson) {
      const error = new Error('A lesson with the same title already exists for this class');
      error.statusCode = 409;
      throw error;
    }

    lesson = await createSupabaseLesson({
      title: normalizedTitle,
      description: normalizedDescription,
      track: lessonTrack,
      subject: normalizedSubject,
      subjectId: normalizedSubjectId,
      subjectCode: '',
      subjectCategory: normalizedSubjectCategory,
      pdfPath: primaryAttachment.storedPath,
      pdfOriginalName: primaryAttachment.originalName,
      attachments: attachmentsPayload,
      createdBy: req.user._id,
    });
    console.log('[createLesson] saved document:', {
      id: lesson._id,
      title: lesson.title,
      primaryFile: lesson.pdfOriginalName,
      attachmentCount: attachmentsPayload.length,
    });
  } catch (saveError) {
    console.error('[createLesson] save failed:', {
      message: saveError.message,
      name: saveError.name,
      code: saveError.code,
      errors: saveError.errors,
      stack: saveError.stack,
    });
    throw saveError;
  }

  await safelyRunNotificationTask('new lesson', () => notifyLessonPublished({ lesson, publisher: req.user }));
  return sendSuccess(res, 201, 'Lesson created successfully', {
    lesson: lessonToResponse(lesson, req),
  });
});

const getTeacherLessons = asyncHandler(async (req, res) => {
  const lessons = await listSupabaseLessons(req.user._id);
  const dedupedLessons = uniqueBy(lessons, (lesson) => {
    if (lesson?._id) return String(lesson._id);
    return `${normalizeKeyPart(lesson?.title)}:${normalizeKeyPart(getLessonTrack(lesson))}:${String(lesson?.createdBy || '')}`;
  });
  return sendSuccess(res, 200, 'Lessons fetched successfully', {
    lessons: dedupedLessons.map((lesson) => lessonToResponse(lesson, req)),
  });
});

const updateTeacherLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findOne({ _id: req.params.id, createdBy: req.user._id });
  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedTitle = String(req.body?.title || '').trim();
  const normalizedDescription = String(req.body?.description || '').trim();
  const normalizedSubjectId = String(req.body?.subjectId || '').trim();
  if (!normalizedTitle || !normalizedDescription || !normalizedSubjectId) {
    const error = new Error('Lesson title, description, and class are required');
    error.statusCode = 400;
    throw error;
  }

  const subjectRecord = await findTeacherSubjectRecord(req.user._id, normalizedSubjectId);
  if (!subjectRecord) {
    const error = new Error('Selected class was not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedSubject = ensureTeacherSubjectAccess(req.user, subjectRecord.name);
  const duplicateLesson = await Lesson.findOne({
    _id: { $ne: lesson._id },
    createdBy: req.user._id,
    subjectId: subjectRecord._id,
    title: new RegExp(`^${normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  }).select('_id');
  if (duplicateLesson) {
    const error = new Error('A lesson with the same title already exists for this class');
    error.statusCode = 409;
    throw error;
  }

  lesson.title = normalizedTitle;
  lesson.description = normalizedDescription;
  lesson.track = normalizeLessonStrand(subjectRecord.track || lesson.track) || lesson.track;
  lesson.subject = normalizedSubject;
  lesson.subjectId = subjectRecord._id;
  lesson.subjectCode = subjectRecord.code;
  lesson.subjectCategory = subjectRecord.subjectCategory || getSubjectCategory(normalizedSubject);
  await lesson.save();
  await lesson.populate('subjectId', 'className code track');

  return sendSuccess(res, 200, 'Lesson updated successfully', {
    lesson: lessonToResponse(lesson, req),
  });
});

const copyTeacherLessonToClasses = asyncHandler(async (req, res) => {
  const sourceLesson = await findSupabaseLesson(req.params.id, req.user._id);
  if (!sourceLesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const requestedSubjectIds = uniqueBy(
    (Array.isArray(req.body?.subjectIds) ? req.body.subjectIds : [req.body?.subjectId])
      .map((subjectId) => String(subjectId || '').trim())
      .filter(Boolean),
    (subjectId) => subjectId
  );
  if (requestedSubjectIds.length === 0) {
    const error = new Error('Select at least one additional class');
    error.statusCode = 400;
    throw error;
  }
  if (requestedSubjectIds.length > 20) {
    const error = new Error('You can add a lesson to at most 20 classes at a time');
    error.statusCode = 400;
    throw error;
  }

  const subjectsById = new Map((await listTeacherSubjects(req.user._id))
    .map((subject) => [String(subject._id), subject]));
  const targetSubjects = requestedSubjectIds.map((subjectId) => subjectsById.get(subjectId)).filter(Boolean);
  if (targetSubjects.length !== requestedSubjectIds.length) {
    const error = new Error('One or more selected classes were not found');
    error.statusCode = 404;
    throw error;
  }

  const sourceSubjectId = String(sourceLesson.subjectId || '').trim();
  const existingLessons = await listSupabaseLessons(req.user._id);
  const createdLessons = [];
  const skippedClasses = [];
  for (const subjectRecord of targetSubjects) {
    if (String(subjectRecord._id) === sourceSubjectId) {
      skippedClasses.push(subjectRecord.className || subjectRecord.name || 'Current class');
      continue;
    }

    const normalizedSubject = ensureTeacherSubjectAccess(req.user, subjectRecord.name);
    const existingLesson = existingLessons.find((lesson) => (
      String(lesson.subjectId || '') === String(subjectRecord._id)
      && normalizeKeyPart(lesson.title) === normalizeKeyPart(sourceLesson.title)
    ));
    if (existingLesson) {
      skippedClasses.push(subjectRecord.className || subjectRecord.name || 'Class');
      continue;
    }

    const copiedAttachments = normalizeLessonAttachments(sourceLesson).map((attachment) => ({
      originalName: attachment.originalName,
      storedPath: attachment.storedPath,
      mimeType: attachment.mimeType,
      extension: attachment.extension,
      size: attachment.size,
      uploadedAt: attachment.uploadedAt,
    }));
    const copiedLesson = await createSupabaseLesson({
      title: sourceLesson.title,
      description: sourceLesson.description,
      track: normalizeLessonStrand(subjectRecord.track || sourceLesson.track) || sourceLesson.track,
      subject: normalizedSubject,
      subjectId: subjectRecord._id,
      subjectCode: subjectRecord.code,
      subjectCategory: subjectRecord.subjectCategory || getSubjectCategory(normalizedSubject),
      pdfPath: sourceLesson.pdfPath,
      pdfOriginalName: sourceLesson.pdfOriginalName,
      attachments: copiedAttachments,
      createdBy: req.user._id,
      publishedBy: req.user._id,
    });
    createdLessons.push(copiedLesson);
    await safelyRunNotificationTask('copied lesson', () => notifyLessonPublished({
      lesson: copiedLesson,
      publisher: req.user,
    }));
  }

  return sendSuccess(res, 201, createdLessons.length > 0
    ? 'Lesson added to the selected classes'
    : 'This lesson is already available in the selected classes', {
    lessons: createdLessons.map((lesson) => lessonToResponse(lesson, req)),
    skippedClasses,
  });
});

const getTeacherSubjects = asyncHandler(async (req, res) => {
  const subjects = await syncTeacherSubjects(req.user._id);
  const counts = await getTeacherSubjectCounts(req.user._id);

  return sendSuccess(res, 200, 'Teacher subjects fetched successfully', {
    subjects: subjects.map((subject) => {
      const lessonCount = counts.lessons.get(String(subject._id)) || 0;
      const assessmentCount = counts.assessments.get(String(subject._id)) || 0;
      const approvedStudentsCount = counts.approvedEnrollments.get(String(subject._id)) || 0;
      const pendingRequestsCount = counts.pendingEnrollments.get(String(subject._id)) || 0;
      const attendanceRecordCount = counts.attendance.get(String(subject._id)) || 0;
      const deletionBlockers = [];

      if (lessonCount > 0) deletionBlockers.push(formatCountLabel(lessonCount, 'lesson'));
      if (assessmentCount > 0) deletionBlockers.push(formatCountLabel(assessmentCount, 'assessment'));
      if (approvedStudentsCount > 0) deletionBlockers.push(formatCountLabel(approvedStudentsCount, 'approved student'));
      if (pendingRequestsCount > 0) deletionBlockers.push(formatCountLabel(pendingRequestsCount, 'pending request'));
      if (attendanceRecordCount > 0) deletionBlockers.push(formatCountLabel(attendanceRecordCount, 'attendance record'));

      return {
        ...subjectToResponse(subject),
        lessonCount,
        assessmentCount,
        approvedStudentsCount,
        pendingRequestsCount,
        attendanceRecordCount,
        canDelete: deletionBlockers.length === 0,
        deleteBlockedReason: deletionBlockers.length === 0
          ? ''
          : `This class cannot be deleted because it still has ${joinWithAnd(deletionBlockers)}.`,
      };
    }),
  });
});

const getTeacherAssessments = asyncHandler(async (req, res) => {
  const [assessments, lessons] = await Promise.all([
    listSupabaseAssessments(req.user._id),
    listSupabaseLessons(req.user._id),
  ]);
  const lessonById = new Map(lessons.map((lesson) => [String(lesson._id), lesson]));
  assessments.forEach((assessment) => {
    if (assessment.lessonId) assessment.lessonId = lessonById.get(String(assessment.lessonId)) || assessment.lessonId;
  });
  const dedupedAssessments = uniqueBy(assessments, (assessment) => {
    if (assessment?._id) return String(assessment._id);
    return [
      String(assessment?.createdBy || ''),
      String(assessment?.lessonId?._id || assessment?.lessonId || ''),
      normalizeKeyPart(assessment?.title),
      normalizeKeyPart(assessment?.examType),
    ].join(':');
  });

  const submissionCountsByAssessment = new Map();

  const mappedAssessments = dedupedAssessments.map((assessment) => ({
    id: assessment._id,
    title: assessment.title,
    examType: String(assessment.assessmentMode || 'activity') === 'activity'
      ? 'File Upload'
      : assessment.examType,
    subject: String(assessment.subject || assessment.lessonId?.subject || '').trim(),
    subjectId: String(assessment.subjectId?._id || assessment.subjectId || assessment.lessonId?.subjectId?._id || assessment.lessonId?.subjectId || ''),
    subjectCode: String(assessment.subjectCode || assessment.subjectId?.code || assessment.lessonId?.subjectCode || assessment.lessonId?.subjectId?.code || ''),
    className: String(assessment.subjectId?.className || assessment.lessonId?.subjectId?.className || '').trim(),
    subjectCategory: assessment.subjectCategory || 'Technical',
    difficulty: assessment.difficulty,
    numberOfItems: assessment.numberOfItems,
    activityPoints: Number.isInteger(Number(assessment.activityPoints)) && Number(assessment.activityPoints) >= 1
      ? Number(assessment.activityPoints)
      : null,
    allowedSubmissionTypes: Array.isArray(assessment.allowedSubmissionTypes)
      ? assessment.allowedSubmissionTypes
      : ['written', 'link', 'file'],
    allowResubmission: assessment.allowResubmission !== false,
    allowLateSubmissions: assessment.allowLateSubmissions === true,
    assessmentMode: String(assessment.assessmentMode || 'activity'),
    gradingPeriod: normalizeGradingPeriod(assessment.gradingPeriod),
    countsTowardRecommendation: Boolean(assessment.countsTowardRecommendation)
      && Boolean(normalizeGradingPeriod(assessment.gradingPeriod)),
    assignmentScope: String(assessment.assignmentScope || 'handled_class'),
    assignedStudentsCount: Array.isArray(assessment.assignedStudentIds) ? assessment.assignedStudentIds.length : 0,
    examDurationMinutes: Number(assessment.examDurationMinutes || 30),
    maxViolations: Number(assessment.maxViolations || 3),
    violationAction: String(assessment.violationAction || 'auto-submit'),
    submissionDeadline: assessment.submissionDeadline || null,
    challengeDescription: String(assessment.challengeDescription || '').trim(),
    isDeadlinePassed: assessment.submissionDeadline ? isPastDate(assessment.submissionDeadline) : false,
    attachments: normalizeAssessmentAttachments(assessment).map((attachment) => toAssessmentAttachmentResponse(attachment, req)),
    attachmentCount: normalizeAssessmentAttachments(assessment).length,
    questionsCount: Array.isArray(assessment.questions) ? assessment.questions.length : 0,
    answerKey: (Array.isArray(assessment.questions) ? assessment.questions : []).map((question, index) => ({
      questionNumber: index + 1,
      questionText: String(question?.questionText || '').trim(),
      type: String(question?.type || '').trim(),
      options: Array.isArray(question?.options) ? question.options : [],
      correctAnswer: String(question?.correctAnswer || '').trim(),
      points: Number(question?.points || 1),
    })),
    lessonTitle: assessment.lessonId?.title || '',
    lessonTrack: getLessonTrack(assessment.lessonId),
    lessonSubject: String(assessment?.lessonId?.subject || '').trim(),
    submissionsCount: submissionCountsByAssessment.get(String(assessment._id)) || 0,
    publishedBy: assessment?.publishedBy
      ? {
        id: String(assessment.publishedBy._id || ''),
        name: String(assessment.publishedBy.name || '').trim(),
        role: String(assessment.publishedBy.role || '').trim(),
      }
      : null,
    lastModifiedBy: assessment?.lastModifiedBy
      ? {
        id: String(assessment.lastModifiedBy._id || ''),
        name: String(assessment.lastModifiedBy.name || '').trim(),
        role: String(assessment.lastModifiedBy.role || '').trim(),
      }
      : null,
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  }));

  return sendSuccess(res, 200, 'Assessments fetched successfully', {
    assessments: mappedAssessments,
  });
});

const updateTeacherAssessment = asyncHandler(async (req, res) => {
  const assessment = await findSupabaseAssessment(req.params.id, req.user._id);
  if (!assessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedTitle = String(req.body?.title || '').trim();
  const normalizedSubjectId = String(req.body?.subjectId || '').trim();
  if (!normalizedTitle || !normalizedSubjectId) {
    const error = new Error('Assessment title and class are required');
    error.statusCode = 400;
    throw error;
  }

  const subjectRecord = await findTeacherSubjectRecord(req.user._id, normalizedSubjectId);
  if (!subjectRecord) {
    const error = new Error('Selected class was not found');
    error.statusCode = 404;
    throw error;
  }
  const normalizedSubject = ensureTeacherSubjectAccess(req.user, subjectRecord.name);
  const duplicateAssessment = (await listSupabaseAssessments(req.user._id)).find((item) => (
    String(item._id) !== String(assessment._id)
    && String(item.subjectId || '') === String(subjectRecord._id)
    && String(item.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
  ));
  if (duplicateAssessment) {
    const error = new Error('An activity or assessment with the same title already exists for this class');
    error.statusCode = 409;
    throw error;
  }

  if (assessment.countsTowardRecommendation) {
    await assertUniqueGradingAssessment({
      teacherId: req.user._id,
      subjectId: subjectRecord._id,
      gradingPeriod: assessment.gradingPeriod,
      excludeAssessmentId: assessment._id,
    });
  }

  let linkedLesson = assessment.lessonId
    ? await findSupabaseLesson(assessment.lessonId, req.user._id)
    : null;
  if (linkedLesson && String(linkedLesson.subjectId || '') !== String(subjectRecord._id)) {
    linkedLesson = (await listSupabaseLessons(req.user._id)).find((lesson) => (
      String(lesson.subjectId || '') === String(subjectRecord._id)
      && normalizeKeyPart(lesson.title) === normalizeKeyPart(linkedLesson.title)
    )) || null;
  }

  assessment.title = normalizedTitle;
  assessment.subject = normalizedSubject;
  assessment.subjectId = subjectRecord._id;
  assessment.subjectCode = subjectRecord.code;
  assessment.subjectCategory = subjectRecord.subjectCategory || assessment.subjectCategory || getSubjectCategory(normalizedSubject);
  assessment.lessonId = linkedLesson?._id || null;
  if (assessment.assessmentMode === 'activity') {
    const challengeDescription = String(req.body?.challengeDescription || '').trim();
    if (!challengeDescription) {
      const error = new Error('Activity instructions are required');
      error.statusCode = 400;
      throw error;
    }
    assessment.challengeDescription = challengeDescription;
    assessment.activityPoints = parseActivityPoints(req.body?.activityPoints, assessment.activityPoints || 100);
  } else if (req.body?.difficulty !== undefined) {
    const difficulty = String(req.body.difficulty || '').trim().toLowerCase();
    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      const error = new Error('Difficulty must be easy, medium, or hard');
      error.statusCode = 400;
      throw error;
    }
    assessment.difficulty = difficulty;
  }

  const currentAttachments = normalizeAssessmentAttachments(assessment);
  let retainedAttachmentIds = req.body?.retainedAttachmentIds;
  if (typeof retainedAttachmentIds === 'string') {
    try {
      retainedAttachmentIds = JSON.parse(retainedAttachmentIds);
    } catch {
      retainedAttachmentIds = retainedAttachmentIds.split(',');
    }
  }
  const retainedIds = Array.isArray(retainedAttachmentIds)
    ? new Set(retainedAttachmentIds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const retainedAttachments = retainedIds
    ? currentAttachments.filter((attachment) => retainedIds.has(String(attachment?._id || '')))
    : currentAttachments;
  const existingKeys = new Set(retainedAttachments.map(assessmentAttachmentKey));
  const uploadedFiles = (Array.isArray(req.files?.attachments) ? req.files.attachments : [])
    .filter((file) => !existingKeys.has(assessmentAttachmentKey(file)));
  const duplicateFiles = (Array.isArray(req.files?.attachments) ? req.files.attachments : [])
    .filter((file) => existingKeys.has(assessmentAttachmentKey(file)))
    .map((file) => ({ fileName: file.originalname, reason: 'Duplicate file' }));
  const uploadResult = await uploadAssessmentAttachments(uploadedFiles, {
    teacherId: req.user._id,
    assessmentId: assessment._id,
  });
  const middlewareRejections = Array.isArray(req.rejectedAssessmentAttachments)
    ? req.rejectedAssessmentAttachments
    : [];
  assessment.attachments = [...retainedAttachments, ...uploadResult.uploaded];
  assessment.assignedStudentIds = await resolveAssignedStudentIds({
    assignmentScope: assessment.assignmentScope,
    teacherId: req.user._id,
    subjectId: subjectRecord._id,
  });
  assessment.lastModifiedBy = req.user._id;
  if (!assessment.publishedBy) assessment.publishedBy = req.user._id;
  const updatedAssessment = await updateSupabaseAssessment(assessment._id, req.user._id, assessment);
  if (!updatedAssessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  const rejectedAttachments = [...middlewareRejections, ...duplicateFiles, ...uploadResult.rejected];
  return sendSuccess(res, 200, rejectedAttachments.length
    ? 'Assessment updated; some attachments were skipped'
    : 'Assessment updated successfully', {
    assessment: updatedAssessment,
    attachmentUpload: {
      uploadedCount: uploadResult.uploaded.length,
      rejected: rejectedAttachments,
    },
  });
});

const copyTeacherAssessmentToClasses = asyncHandler(async (req, res) => {
  const sourceAssessment = await findSupabaseAssessment(req.params.id, req.user._id);
  if (!sourceAssessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  const requestedSubjectIds = uniqueBy(
    (Array.isArray(req.body?.subjectIds) ? req.body.subjectIds : [req.body?.subjectId])
      .map((subjectId) => String(subjectId || '').trim())
      .filter(Boolean),
    (subjectId) => subjectId
  );
  if (requestedSubjectIds.length === 0) {
    const error = new Error('Select at least one additional class');
    error.statusCode = 400;
    throw error;
  }
  if (requestedSubjectIds.length > 20) {
    const error = new Error('You can add an assessment to at most 20 classes at a time');
    error.statusCode = 400;
    throw error;
  }

  const subjectsById = new Map((await listTeacherSubjects(req.user._id))
    .map((subject) => [String(subject._id), subject]));
  const targetSubjects = requestedSubjectIds.map((subjectId) => subjectsById.get(subjectId)).filter(Boolean);
  if (targetSubjects.length !== requestedSubjectIds.length) {
    const error = new Error('One or more selected classes were not found');
    error.statusCode = 404;
    throw error;
  }

  const [sourceLesson, existingAssessments, existingLessons] = await Promise.all([
    sourceAssessment.lessonId ? findSupabaseLesson(sourceAssessment.lessonId, req.user._id) : null,
    listSupabaseAssessments(req.user._id),
    listSupabaseLessons(req.user._id),
  ]);
  const sourceSubjectId = String(sourceAssessment.subjectId || '').trim();
  const createdAssessments = [];
  const skippedClasses = [];

  for (const subjectRecord of targetSubjects) {
    const classLabel = subjectRecord.className || subjectRecord.name || 'Class';
    if (String(subjectRecord._id) === sourceSubjectId) {
      skippedClasses.push(classLabel);
      continue;
    }
    ensureTeacherSubjectAccess(req.user, subjectRecord.name);

    const existingAssessment = existingAssessments.find((assessment) => (
      String(assessment.subjectId || '') === String(subjectRecord._id)
      && normalizeKeyPart(assessment.title) === normalizeKeyPart(sourceAssessment.title)
    ));
    if (existingAssessment) {
      skippedClasses.push(classLabel);
      continue;
    }

    if (sourceAssessment.countsTowardRecommendation) {
      try {
        const gradingConflict = existingAssessments.some((assessment) => (
          String(assessment.subjectId || '') === String(subjectRecord._id)
          && assessment.countsTowardRecommendation === true
          && String(assessment.gradingPeriod || '') === String(sourceAssessment.gradingPeriod || '')
        ));
        if (gradingConflict) {
          const conflict = new Error('A grading assessment for this grading period already exists for this class.');
          conflict.statusCode = 409;
          throw conflict;
        }
      } catch (error) {
        if (error.statusCode === 409) {
          skippedClasses.push(classLabel);
          continue;
        }
        throw error;
      }
    }

    const linkedLesson = sourceLesson
      ? existingLessons.find((lesson) => (
        String(lesson.subjectId || '') === String(subjectRecord._id)
        && normalizeKeyPart(lesson.title) === normalizeKeyPart(sourceLesson.title)
      ))
      : null;
    const assignedStudentIds = sourceAssessment.assignmentScope === 'handled_class'
      ? await approvedStudentsForSubject(subjectRecord._id, req.user._id)
      : [...new Set((sourceAssessment.assignedStudentIds || []).map(String).filter(Boolean))];
    const copiedAttachments = normalizeAssessmentAttachments(sourceAssessment).map((attachment) => ({
      originalName: attachment.originalName,
      storedPath: attachment.storedPath,
      mimeType: attachment.mimeType,
      extension: attachment.extension,
      size: attachment.size,
      uploadedAt: attachment.uploadedAt,
    }));
    const copiedQuestions = (Array.isArray(sourceAssessment.questions) ? sourceAssessment.questions : [])
      .map((question) => ({
        questionText: question.questionText,
        type: question.type,
        options: Array.isArray(question.options) ? [...question.options] : [],
        correctAnswer: question.correctAnswer,
        points: question.points,
        explanation: question.explanation,
      }));

    const copiedAssessment = await createSupabaseAssessment({
      lessonId: linkedLesson?._id || null,
      title: sourceAssessment.title,
      examType: sourceAssessment.examType,
      subject: subjectRecord.name,
      subjectId: subjectRecord._id,
      subjectCode: subjectRecord.code,
      subjectCategory: subjectRecord.subjectCategory || sourceAssessment.subjectCategory,
      difficulty: sourceAssessment.difficulty,
      numberOfItems: sourceAssessment.numberOfItems,
      activityPoints: sourceAssessment.activityPoints,
      allowedSubmissionTypes: sourceAssessment.allowedSubmissionTypes,
      allowResubmission: sourceAssessment.allowResubmission,
      allowLateSubmissions: sourceAssessment.allowLateSubmissions,
      examDurationMinutes: sourceAssessment.examDurationMinutes,
      maxViolations: sourceAssessment.maxViolations,
      violationAction: sourceAssessment.violationAction,
      submissionDeadline: sourceAssessment.submissionDeadline,
      challengeDescription: sourceAssessment.challengeDescription,
      attachments: copiedAttachments,
      assessmentMode: sourceAssessment.assessmentMode,
      gradingPeriod: sourceAssessment.gradingPeriod,
      countsTowardRecommendation: sourceAssessment.countsTowardRecommendation,
      assignmentScope: sourceAssessment.assignmentScope,
      assignedStudentIds,
      questions: copiedQuestions,
      createdBy: req.user._id,
      publishedBy: req.user._id,
      lastModifiedBy: req.user._id,
    });
    createdAssessments.push(copiedAssessment);
    await safelyRunNotificationTask('copied assessment', () => notifyAssessmentAssigned({
      assessment: copiedAssessment,
      publisher: req.user,
    }));
  }

  return sendSuccess(res, 201, createdAssessments.length > 0
    ? 'Assessment added to the selected classes'
    : 'This assessment is already available or conflicts with an existing grading assessment in the selected classes', {
    assessments: createdAssessments,
    skippedClasses,
  });
});

const downloadTeacherLessonPdf = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lesson = await Lesson.findOne({ _id: id, createdBy: req.user._id });

  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
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

const downloadTeacherLessonAttachment = asyncHandler(async (req, res) => {
  const { id, attachmentId } = req.params;
  const lesson = await Lesson.findOne({ _id: id, createdBy: req.user._id });

  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const attachments = normalizeLessonAttachments(lesson);
  const attachment = attachments.find((item) => String(item?._id || '') === String(attachmentId || ''));
  if (!attachment) {
    const error = new Error('Attachment not found');
    error.statusCode = 404;
    throw error;
  }

  return downloadOrRedirectStoredFile(req, res, attachment.storedPath, attachment.originalName);
});

const createAssessment = asyncHandler(async (req, res) => {
  const {
    lessonId,
    subjectId: subjectIdRaw,
    title,
    examType,
    subject,
    subjectCategory,
    difficulty,
    numberOfItems,
    examDurationMinutes: examDurationMinutesRaw,
    challengeDescription: challengeDescriptionRaw,
    questions,
    assessmentMode,
    gradingPeriod,
    assignmentScope,
    submissionDeadline: submissionDeadlineRaw,
    deadline: deadlineRaw,
    deadlineAt: deadlineAtRaw,
    activityPoints: activityPointsRaw,
    allowedSubmissionTypes: allowedSubmissionTypesRaw,
    allowResubmission: allowResubmissionRaw,
    allowLateSubmissions: allowLateSubmissionsRaw,
  } = req.body;

  const normalizedAssessmentMode = String(assessmentMode || 'activity').trim().toLowerCase() || 'activity';
  const isActivityAssessment = normalizedAssessmentMode === 'activity';
  const normalizedChallengeDescription = String(challengeDescriptionRaw || '').trim();
  const normalizedExamType = isActivityAssessment
    ? 'activity_upload'
    : String(examType || '').trim();
  const normalizedActivityPoints = isActivityAssessment
    ? parseActivityPoints(activityPointsRaw, 100)
    : null;
  const allowedSubmissionTypes = isActivityAssessment
    ? parseActivitySubmissionTypes(allowedSubmissionTypesRaw ?? ['written', 'link', 'file'])
    : ['written', 'link', 'file'];
  const allowResubmission = isActivityAssessment
    ? parseBooleanSetting(allowResubmissionRaw, true)
    : false;
  const allowLateSubmissions = isActivityAssessment
    ? parseBooleanSetting(allowLateSubmissionsRaw, false)
    : false;
  const normalizedDifficulty = isActivityAssessment
    ? 'medium'
    : String(difficulty || '').trim();
  const normalizedNumberOfItems = isActivityAssessment
    ? 1
    : Number(numberOfItems || 0);
  const normalizedLessonId = String(lessonId || '').trim();
  const normalizedSubjectId = String(subjectIdRaw || '').trim();
  const hasLinkedLesson = Boolean(normalizedLessonId);
  let selectedClass = null;

  if (!isActivityAssessment && (!normalizedExamType || !normalizedDifficulty || !normalizedNumberOfItems)) {
    const error = new Error('examType, difficulty, and numberOfItems are required for quizzes and exams');
    error.statusCode = 400;
    throw error;
  }

  const examDurationMinutes = isActivityAssessment
    ? parseExamDurationMinutes(examDurationMinutesRaw ?? 30, { required: true })
    : parseExamDurationMinutes(examDurationMinutesRaw, { required: true });

  const lesson = hasLinkedLesson
    ? await findSupabaseLesson(normalizedLessonId, req.user._id)
    : null;
  if (hasLinkedLesson && !lesson) {
    const error = new Error('Lesson not found for this teacher');
    error.statusCode = 404;
    throw error;
  }
  if (normalizedSubjectId) {
    selectedClass = await findTeacherSubjectRecord(req.user._id, normalizedSubjectId);
    if (!selectedClass) {
      const error = new Error('Selected class is not assigned to this teacher');
      error.statusCode = 403;
      throw error;
    }
  }
  if (!hasLinkedLesson && !selectedClass) {
    const error = new Error('Select a linked lesson or class before creating this assessment');
    error.statusCode = 400;
    throw error;
  }
  const normalizedTitle = isActivityAssessment
    ? String(title || '').trim() || buildActivityTitleFromDescription(normalizedChallengeDescription)
    : String(title || '').trim();
  const normalizedRequestedSubject = String(subject || lesson?.subject || selectedClass?.name || req.user?.subject || '').trim();
  if (!normalizedTitle || !normalizedRequestedSubject) {
    const error = new Error('title and subject are required');
    error.statusCode = 400;
    throw error;
  }
  if (isActivityAssessment && !normalizedChallengeDescription) {
    const error = new Error('challengeDescription is required for activities');
    error.statusCode = 400;
    throw error;
  }
  if (isActivityAssessment && !selectedClass) {
    const error = new Error('Class and subject are required for activities');
    error.statusCode = 400;
    throw error;
  }
  if (isActivityAssessment && lesson && String(lesson.subjectId || '') !== String(selectedClass._id || '')) {
    const error = new Error('Related lesson must belong to the selected class and subject');
    error.statusCode = 400;
    throw error;
  }

  const normalizedSubject = ensureTeacherSubjectAccess(req.user, normalizedRequestedSubject);
  const lessonStrand = normalizeLessonStrand(lesson?.track || selectedClass?.track);
  if ((lesson || selectedClass) && !isSubjectAllowedForStrand({ strand: lessonStrand, subject: normalizedSubject })) {
    const allowedSubjects = getSubjectsByStrand(lessonStrand);
    const error = new Error(`subject is invalid for strand ${lessonStrand}. Allowed subjects: ${allowedSubjects.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  const existingAssessments = await listSupabaseAssessments(req.user._id);
  const duplicateAssessment = existingAssessments.find((item) => (
    String(item.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
    && String(item.examType || '') === normalizedExamType
    && String(item.lessonId || '') === (hasLinkedLesson ? normalizedLessonId : '')
    && (hasLinkedLesson || String(item.subjectId || '') === String(selectedClass?._id || ''))
  ));

  if (duplicateAssessment) {
    const error = new Error(hasLinkedLesson
      ? 'An assessment with the same title already exists for this lesson'
      : 'An activity with the same title already exists for this class');
    error.statusCode = 409;
    throw error;
  }

  const submissionDeadline = parseSubmissionDeadline(
    submissionDeadlineRaw ?? deadlineRaw ?? deadlineAtRaw
  );
  const challengeDescription = normalizedChallengeDescription;
  if (submissionDeadline && isPastDate(submissionDeadline)) {
    const error = new Error('submissionDeadline must be a future date and time');
    error.statusCode = 400;
    throw error;
  }

  const assessmentId = crypto.randomUUID().replace(/-/g, '');
  const uploadedAssessmentFiles = Array.isArray(req.files?.attachments) ? req.files.attachments : [];
  let assessmentAttachmentsPayload = [];
  const assessmentUploadResult = await uploadAssessmentAttachments(uploadedAssessmentFiles, {
    teacherId: req.user._id,
    assessmentId,
  });
  assessmentAttachmentsPayload = assessmentUploadResult.uploaded;

  let assessment;
  try {
    const assessmentPolicy = buildAssessmentPolicy({
      assessmentMode: normalizedAssessmentMode,
      examType: normalizedExamType,
      gradingPeriod,
      assignmentScope,
    });
    const subjectRecord = isActivityAssessment
      ? selectedClass
      : lesson
      ? {
        _id: lesson.subjectId,
        id: lesson.subjectId,
        name: lesson.subject || normalizedSubject,
        track: lesson.track,
        code: lesson.subjectCode || '',
        subjectCategory: lesson.subjectCategory || getSubjectCategory(normalizedSubject),
      }
      : selectedClass;
    if (lesson && !subjectRecord) {
      const error = new Error('Linked lesson is not attached to a class. Recreate the lesson with a class selected.');
      error.statusCode = 400;
      throw error;
    }
    if (assessmentPolicy.countsTowardRecommendation) {
      const duplicateGradingAssessment = existingAssessments.find((item) => (
        item.countsTowardRecommendation === true
        && String(item.subjectId || '') === String(subjectRecord?._id || '')
        && String(item.gradingPeriod || '') === String(assessmentPolicy.gradingPeriod || '')
      ));
      if (duplicateGradingAssessment) {
        const error = new Error('A grading assessment already exists for this class and grading period');
        error.statusCode = 409;
        throw error;
      }
    }

    const assignedStudentIds = Array.isArray(req.body?.assignedStudentIds)
      ? req.body.assignedStudentIds
      : [];

    assessment = await createSupabaseAssessment({
      id: assessmentId,
      lessonId: lesson?._id || undefined,
      title: normalizedTitle,
      examType: normalizedExamType,
      subject: String(subjectRecord?.name || normalizedSubject).trim(),
      subjectId: subjectRecord?._id || null,
      subjectCode: subjectRecord?.code || '',
      subjectCategory: resolveAssessmentSubjectCategory({
        subjectCategory: subjectCategory || subjectRecord?.subjectCategory || getSubjectCategory(normalizedSubject),
        examType: normalizedExamType,
        title: normalizedTitle,
        lessonTrack: lesson?.track || subjectRecord?.track || req.user?.strand || '',
      }),
      difficulty: normalizedDifficulty,
      numberOfItems: normalizedNumberOfItems,
      activityPoints: normalizedActivityPoints,
      allowedSubmissionTypes,
      allowResubmission,
      allowLateSubmissions,
      examDurationMinutes,
      submissionDeadline: submissionDeadline || null,
      challengeDescription,
      attachments: assessmentAttachmentsPayload,
      assessmentMode: assessmentPolicy.assessmentMode,
      gradingPeriod: assessmentPolicy.gradingPeriod,
      countsTowardRecommendation: assessmentPolicy.countsTowardRecommendation,
      assignmentScope: assessmentPolicy.assignmentScope,
      assignedStudentIds,
      questions: normalizeAssessmentQuestions(parseAssessmentQuestions(questions)),
      createdBy: req.user._id,
      publishedBy: req.user._id,
      lastModifiedBy: req.user._id,
    });
    console.log('[createAssessment] saved document:', {
      id: assessment._id,
      title: assessment.title,
      numberOfItems: assessment.numberOfItems,
    });
  } catch (saveError) {
    console.error('[createAssessment] save failed:', {
      message: saveError.message,
      name: saveError.name,
      code: saveError.code,
      errors: saveError.errors,
      stack: saveError.stack,
    });
    throw saveError;
  }

  await safelyRunNotificationTask('new assessment', () => notifyAssessmentAssigned({ assessment, publisher: req.user }));
  const rejectedAttachments = [
    ...(Array.isArray(req.rejectedAssessmentAttachments) ? req.rejectedAssessmentAttachments : []),
    ...assessmentUploadResult.rejected,
  ];
  return sendSuccess(res, 201, rejectedAttachments.length
    ? 'Assessment created; some attachments were skipped'
    : 'Assessment created successfully', {
    assessment,
    attachmentUpload: {
      uploadedCount: assessmentAttachmentsPayload.length,
      rejected: rejectedAttachments,
    },
  });
});

const updateAssessmentQuestions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    questions,
    title,
    examType,
    subject,
    subjectCategory,
    difficulty,
    numberOfItems,
    assessmentMode,
    gradingPeriod,
    assignmentScope,
    examDurationMinutes: examDurationMinutesRaw,
    submissionDeadline: submissionDeadlineRaw,
    deadline: deadlineRaw,
    deadlineAt: deadlineAtRaw,
    activityPoints: activityPointsRaw,
  } = req.body;

  const deadlineFieldNames = ['submissionDeadline', 'deadline', 'deadlineAt'];
  const isDeadlineOnlyUpdate = Object.keys(req.body || {}).every((key) => deadlineFieldNames.includes(key))
    && deadlineFieldNames.some((key) => Object.prototype.hasOwnProperty.call(req.body || {}, key));

  // Assessments now live in Supabase and use UUIDs. Keep deadline-only edits on
  // that storage path so UUID teacher IDs are never passed to a Mongoose
  // ObjectId field (which previously caused the deadline editor to fail).
  if (isDeadlineOnlyUpdate) {
    const assessment = await findSupabaseAssessment(id, req.user._id);
    if (!assessment) {
      const error = new Error('Assessment not found');
      error.statusCode = 404;
      throw error;
    }

    const parsedDeadline = parseSubmissionDeadline(
      submissionDeadlineRaw ?? deadlineRaw ?? deadlineAtRaw
    );
    if (parsedDeadline && isPastDate(parsedDeadline)) {
      const error = new Error('submissionDeadline must be a future date and time');
      error.statusCode = 400;
      throw error;
    }

    assessment.submissionDeadline = parsedDeadline ? parsedDeadline.toISOString() : null;
    assessment.lastModifiedBy = req.user._id;
    if (!assessment.publishedBy) assessment.publishedBy = req.user._id;

    const updatedAssessment = await updateSupabaseAssessment(id, req.user._id, assessment);
    if (!updatedAssessment) {
      const error = new Error('Assessment not found');
      error.statusCode = 404;
      throw error;
    }

    return sendSuccess(res, 200, 'Assessment updated successfully', { assessment: updatedAssessment });
  }

  const assessment = await Assessment.findOne({ _id: id, createdBy: req.user._id });
  if (!assessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  if (questions !== undefined) {
    if (!Array.isArray(questions)) {
      const error = new Error('questions must be an array');
      error.statusCode = 400;
      throw error;
    }
    assessment.questions = normalizeAssessmentQuestions(questions);
  }

  const lesson = assessment.lessonId
    ? await Lesson.findById(assessment.lessonId).select('track subject subjectId subjectCode subjectCategory').lean()
    : null;
  const selectedClass = !lesson && assessment.subjectId
    ? await findTeacherSubject(req.user._id, assessment.subjectId)
    : null;
  const nextPolicy = buildAssessmentPolicy({
    assessmentMode: assessmentMode !== undefined ? assessmentMode : assessment.assessmentMode,
    examType: examType !== undefined ? examType : assessment.examType,
    gradingPeriod: gradingPeriod !== undefined ? gradingPeriod : assessment.gradingPeriod,
    assignmentScope: assignmentScope !== undefined ? assignmentScope : assessment.assignmentScope,
  });

  if (!lesson && !selectedClass) {
    const error = new Error('A linked lesson or class is required for this assessment');
    error.statusCode = 400;
    throw error;
  }

  if (title !== undefined) assessment.title = title;
  if (examType !== undefined) assessment.examType = examType;
  if (subject !== undefined) {
    const nextSubject = ensureTeacherSubjectAccess(req.user, String(subject || '').trim());
    const lessonStrand = normalizeLessonStrand(lesson?.track || selectedClass?.track);
    if ((lesson || selectedClass) && !isSubjectAllowedForStrand({ strand: lessonStrand, subject: nextSubject })) {
      const allowedSubjects = getSubjectsByStrand(lessonStrand);
      const error = new Error(`subject is invalid for strand ${lessonStrand}. Allowed subjects: ${allowedSubjects.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
    assessment.subject = nextSubject;
  }

  const subjectRecord = lesson
    ? await resolveTeacherSubjectRecord({
      teacherId: req.user._id,
      subjectId: lesson?.subjectId || assessment.subjectId,
      subjectName: String(assessment.subject || lesson?.subject || '').trim(),
      track: lesson?.track || '',
      subjectCategory: lesson?.subjectCategory || getSubjectCategory(assessment.subject || lesson?.subject),
    })
    : selectedClass;
  if (subjectRecord) {
    assessment.subjectId = subjectRecord._id;
    assessment.subjectCode = subjectRecord.code;
  } else if (!lesson && !selectedClass) {
    assessment.subjectId = null;
    assessment.subjectCode = '';
  }
  if (subjectCategory !== undefined || examType !== undefined || title !== undefined || subject !== undefined) {
    assessment.subjectCategory = resolveAssessmentSubjectCategory({
      subjectCategory: subjectCategory || getSubjectCategory(assessment.subject),
      examType: examType !== undefined ? examType : assessment.examType,
      title: title !== undefined ? title : assessment.title,
      lessonTrack: lesson?.track || selectedClass?.track || req.user?.strand || '',
    });
  }
  if (difficulty !== undefined) assessment.difficulty = difficulty;
  if (numberOfItems !== undefined) assessment.numberOfItems = numberOfItems;
  assessment.assessmentMode = nextPolicy.assessmentMode;
  if (nextPolicy.assessmentMode === 'activity') {
    const currentActivityPoints = Number(assessment.activityPoints);
    const fallbackActivityPoints = Number.isInteger(currentActivityPoints) && currentActivityPoints >= 1
      ? currentActivityPoints
      : 100;
    assessment.activityPoints = parseActivityPoints(activityPointsRaw, fallbackActivityPoints);
  } else {
    assessment.activityPoints = null;
  }
  assessment.gradingPeriod = nextPolicy.gradingPeriod;
  assessment.countsTowardRecommendation = nextPolicy.countsTowardRecommendation;
  assessment.assignmentScope = nextPolicy.assignmentScope;
  if (examDurationMinutesRaw !== undefined) {
    assessment.examDurationMinutes = parseExamDurationMinutes(examDurationMinutesRaw, { required: true });
  }
  if (submissionDeadlineRaw !== undefined || deadlineRaw !== undefined || deadlineAtRaw !== undefined) {
    const parsedDeadline = parseSubmissionDeadline(
      submissionDeadlineRaw ?? deadlineRaw ?? deadlineAtRaw
    );
    if (parsedDeadline && isPastDate(parsedDeadline)) {
      const error = new Error('submissionDeadline must be a future date and time');
      error.statusCode = 400;
      throw error;
    }
    assessment.submissionDeadline = parsedDeadline || null;
  }

  if (nextPolicy.countsTowardRecommendation) {
    await assertUniqueGradingAssessment({
      teacherId: req.user._id,
      subjectId: assessment.subjectId,
      gradingPeriod: nextPolicy.gradingPeriod,
      excludeAssessmentId: assessment._id,
    });
  }

  assessment.assignedStudentIds = await resolveAssignedStudentIds({
    assignmentScope: nextPolicy.assignmentScope,
    teacherId: req.user._id,
    subjectId: assessment.subjectId,
    fallbackToAllHandledStudents: nextPolicy.assessmentMode === 'activity' && !lesson && !selectedClass,
  });
  assessment.lastModifiedBy = req.user._id;
  if (!assessment.publishedBy) assessment.publishedBy = req.user._id;

  await assessment.save();

  return sendSuccess(res, 200, 'Assessment updated successfully', { assessment });
});

const getAssessmentResultsSummary = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const assessment = await Assessment.findOne({ _id: id, createdBy: req.user._id })
    .populate('lessonId', 'title')
    .lean();

  if (!assessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  const submissions = await Submission.find({ assessmentId: id })
    .populate('studentId', 'name email profileImage')
    .sort({ submittedAt: -1 })
    .lean();
  const dedupedSubmissions = uniqueBy(submissions, (submission) => String(submission?.studentId?._id || submission?.studentId || ''));

  const totalSubmissions = dedupedSubmissions.length;
  const averageScore = totalSubmissions
    ? dedupedSubmissions.reduce((sum, row) => sum + row.score, 0) / totalSubmissions
    : 0;

  return sendSuccess(res, 200, 'Assessment summary fetched successfully', {
    summary: {
      assessmentId: assessment._id,
      assessmentTitle: assessment.title,
      lessonTitle: assessment.lessonId?.title || '',
      totalSubmissions,
      averageScore: Number(averageScore.toFixed(2)),
      submissions: dedupedSubmissions,
    },
  });
});

const getTeacherStudents = asyncHandler(async (req, res) => {
  const subjectFilter = String(req.query.subjectId || '').trim();
  if (subjectFilter) await requireTeacherSubject(req.user._id, subjectFilter);
  const subjects = await syncTeacherSubjects(req.user._id);
  const allowedSubjectIds = subjects
    .filter((subject) => !subjectFilter || String(subject._id) === subjectFilter)
    .map((subject) => subject._id);

  if (allowedSubjectIds.length === 0 && subjectFilter) {
    return sendSuccess(res, 200, 'Students fetched successfully', { students: [] });
  }

  const [approvedEnrollments, allAssessments] = await Promise.all([
    teacherRequests(req.user._id, subjectFilter, 'approved'),
    readProfileRows('assessments', 'created_by', req.user._id),
  ]);
  const teacherAssessments = allAssessments.filter(row => allowedSubjectIds.includes(row.subjectId)
    || (!subjectFilter && row.assessmentMode === 'activity' && !row.lessonId));

  const students = uniqueBy(
    approvedEnrollments
    .map((row) => ({
      ...(row.studentId || {}),
      enrollmentSubject: row.subjectId || null,
    }))
    .filter((student) => student?._id && !isArchivedStudent(student)),
    (student) => String(student?._id || '')
  );

  const assessmentIds = teacherAssessments.map((assessment) => assessment._id);
  const totalChallenges = assessmentIds.length;
  const recommendationRows = students.length > 0
    ? await readProfileRows('recommendations', 'student_id', students.map(student => student._id))
    : [];
  const recommendationsByStudentId = new Map(
    recommendationRows.map((row) => [String(row.studentId), row])
  );

  const subjectsByStudentId = new Map();
  const sectionByStudentId = new Map();
  approvedEnrollments.forEach((row) => {
    const studentId = String(row?.studentId?._id || row?.studentId || '');
    if (!studentId) return;
    const items = subjectsByStudentId.get(studentId) || [];
    items.push({
      id: String(row?.subjectId?._id || ''),
      name: String(row?.subjectId?.name || '').trim(),
      className: String(row?.subjectId?.className || '').trim(),
      code: String(row?.subjectId?.code || '').trim(),
      track: String(row?.subjectId?.track || '').trim(),
      requestedAt: row?.requestedAt || null,
      approvedAt: row?.decidedAt || null,
    });
    subjectsByStudentId.set(studentId, items);

    if (!sectionByStudentId.has(studentId)) {
      sectionByStudentId.set(studentId, {
        id: String(row?.sectionId?._id || row?.sectionId || row?.studentId?.sectionId?._id || row?.studentId?.sectionId || '').trim(),
        name: String(row?.sectionId?.name || row?.studentId?.sectionId?.name || row?.sectionName || '').trim(),
      });
    }
  });

  const submissionStatsByStudent = new Map();
  if (assessmentIds.length > 0) {
    const submissions = (await readProfileRows('submissions', 'assessment_id', assessmentIds))
      .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));

    const latestByStudentAndAssessment = new Map();
    for (const submission of submissions) {
      const studentId = String(submission.studentId);
      const assessmentId = String(submission.assessmentId);
      const key = `${studentId}:${assessmentId}`;
      if (!latestByStudentAndAssessment.has(key)) {
        latestByStudentAndAssessment.set(key, submission);
      }
    }

    for (const submission of latestByStudentAndAssessment.values()) {
      const studentId = String(submission.studentId);
      const current = submissionStatsByStudent.get(studentId) || [];
      current.push(submission);
      submissionStatsByStudent.set(studentId, current);
    }
  }

  const bulkProgressUpdates = [];
  const mappedStudents = uniqueBy(students, (student) => String(student?._id || '')).map((student) => {
    const id = String(student._id);
    const subjectsForStudent = subjectsByStudentId.get(id) || [];
    const sectionForStudent = sectionByStudentId.get(id) || null;
    const submissionsForStudent = submissionStatsByStudent.get(id) || [];
    const mastery = computeMasteryFromSubmissions(submissionsForStudent);
    const completedChallenges = mastery.completedAssessments;
    const progress = mastery.masteryProgress;
    const averageScore = mastery.averageScore;
    const recommendation = recommendationsByStudentId.get(id) || null;

    bulkProgressUpdates.push(() => saveStudentProgress(student, mastery));

    return {
      id,
      name: student.name,
      email: student.email,
      status: student.status,
      enrollmentStatus: subjectsForStudent.length > 0
        ? 'approved'
        : String(student?.enrollment?.status || '').trim() || 'invited',
      requestedAt: subjectsForStudent[0]?.requestedAt || student?.createdAt || null,
      approvedAt: subjectsForStudent[0]?.approvedAt || student?.enrollment?.approvedAt || null,
      enrollmentTrack: subjectsForStudent[0]?.track || String(student?.enrollment?.track || '').trim(),
      subjects: subjectsForStudent,
      totalChallenges,
      completedChallenges,
      progress,
      averageScore,
      recommendation: recommendation
        ? {
          subjectPerformance: Array.isArray(recommendation.subjectPerformance) ? recommendation.subjectPerformance : [],
          strandScores: recommendation.strandScores || { STEM: 0, HUMSS: 0, ABM: 0, TVL: 0 },
          recommendedStrand: recommendation.recommendedStrand || { name: 'TVL', confidence: 'Low', generatedAt: null, topTwoStrands: [] },
          recommendationExplanation: recommendation.recommendationExplanation || '',
          updatedAt: recommendation.updatedAt || null,
        }
        : null,
      avatar: userProfileImageToUrl(student, req) || `https://ui-avatars.com/api/?name=${encodeURIComponent(student.name)}&background=334155&color=fff`,
      profileImage: userProfileImageToUrl(student, req),
      gradeLevel: String(student?.gradeLevel || '').trim(),
      sectionId: String(sectionForStudent?.id || student?.sectionId?._id || student?.sectionId || '').trim(),
      sectionName: String(sectionForStudent?.name || student?.sectionId?.name || '').trim(),
    };
  });

  if (bulkProgressUpdates.length > 0) {
    await Promise.all(bulkProgressUpdates.map(save => save()));
  }

  return sendSuccess(res, 200, 'Students fetched successfully', {
    students: mappedStudents,
  });
});

const getTeacherStudentAssessmentResults = asyncHandler(async (req, res) => {
  const sortBy = String(req.query.sort || 'highest').trim().toLowerCase();
  const studentFilter = String(req.query.studentId || '').trim();
  const subjectFilter = String(req.query.subjectId || '').trim();
  const passFailFilter = String(req.query.passFail || '').trim().toLowerCase();

  const { assessmentsById, submissions } = await teacherResultData(req.user._id, subjectFilter, studentFilter);

  let results = submissions.map((submission) => {
    const score = Number(submission?.teacherAdjustedScore ?? submission?.gradeValue ?? submission?.score ?? 0);
    const totalPoints = Number(submission?.totalPoints || 0);
    const percentage = totalPoints > 0 ? Number(((score / totalPoints) * 100).toFixed(2)) : 0;
    const passFailStatus = percentage >= PASSING_PERCENTAGE ? 'pass' : 'fail';
    const assessment = assessmentsById.get(String(submission.assessmentId || '')) || {};
    const student = submission.studentId || {};
    const responseText = String(submission?.responseText || '').trim();
    const links = (Array.isArray(submission?.linkAttachments) ? submission.linkAttachments : [])
      .map((link, index) => ({
        id: String(link?._id || `link-${index + 1}`),
        url: String(link?.url || '').trim(),
        addedAt: link?.addedAt || null,
      }))
      .filter((link) => Boolean(link.url));
    const attachments = (Array.isArray(submission?.attachments) ? submission.attachments : [])
      .map((attachment) => toSubmissionAttachmentResponse(attachment, req))
      .filter((attachment) => Boolean(attachment.fileName));
    const teacherFeedback = String(submission?.teacherFeedback || '').trim();
    const isTeacherGraded = Boolean(submission?.gradedAt || submission?.gradeValue != null);

    return {
      id: String(submission._id),
      studentId: String(student._id || ''),
      studentName: String(student.name || 'Student'),
      studentEmail: String(student.email || ''),
      studentAvatar: userProfileImageToUrl(student, req) || `https://ui-avatars.com/api/?name=${encodeURIComponent(student.name || 'Student')}&background=334155&color=fff`,
      assessmentId: String(assessment._id || submission.assessmentId || ''),
      assessmentTitle: String(assessment.title || 'Assessment'),
      subjectId: String(assessment.subjectId || ''),
      subjectName: String(assessment.subject || assessment?.lessonId?.subject || ''),
      subjectCode: String(assessment.subjectCode || ''),
      lessonTitle: String(assessment?.lessonId?.title || ''),
      lessonTrack: getLessonTrack(assessment?.lessonId),
      assessmentMode: String(assessment.assessmentMode || 'activity'),
      activityPoints: Number.isInteger(Number(assessment.activityPoints)) && Number(assessment.activityPoints) >= 1
        ? Number(assessment.activityPoints)
        : null,
      gradingPeriod: normalizeGradingPeriod(assessment.gradingPeriod),
      countsTowardRecommendation: Boolean(assessment.countsTowardRecommendation),
      assignmentScope: String(assessment.assignmentScope || 'handled_class'),
      score,
      totalItems: Number(assessment?.numberOfItems || 0),
      totalPoints,
      percentage,
      passFailStatus,
      status: String(submission.status || 'completed'),
      submittedAt: submission.submittedAt || submission.createdAt || null,
      violationCount: Number(submission.violationCount || 0),
      terminationReason: String(submission.terminationReason || ''),
      activityLog: (Array.isArray(submission.activityLog) ? submission.activityLog : []).map((event) => ({
        type: String(event?.type || 'system_event'),
        message: String(event?.message || ''),
        metadata: event?.metadata && typeof event.metadata === 'object' ? event.metadata : {},
        occurredAt: event?.occurredAt || null,
      })),
      responseText,
      links,
      attachments,
      gradedAt: submission?.gradedAt || null,
      gradeValue: submission?.gradeValue ?? null,
      teacherFeedback,
      isTeacherGraded,
      isLate: submission?.isLate === true,
      returnedAt: submission?.returnedAt || null,
      aiEvaluations: Array.isArray(submission?.aiEvaluations) ? submission.aiEvaluations : [],
      aiScore: submission?.aiScore ?? null,
      teacherAdjustedScore: submission?.teacherAdjustedScore ?? null,
      scoringStatus: String(submission?.scoringStatus || 'final'),
      hasEssayEvaluation: Array.isArray(submission?.aiEvaluations) && submission.aiEvaluations.length > 0,
    };
  });

  if (passFailFilter === 'pass' || passFailFilter === 'fail') {
    results = results.filter((result) => result.passFailStatus === passFailFilter);
  }

  if (sortBy === 'lowest') {
    results.sort((a, b) => a.score - b.score);
  } else if (sortBy === 'recent') {
    results.sort((a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime());
  } else {
    results.sort((a, b) => b.score - a.score);
  }

  return sendSuccess(res, 200, 'Student assessment results fetched successfully', { results });
});

const reviewActivitySubmission = asyncHandler(async (req, res) => {
  const assessment = await findSupabaseAssessment(req.params.assessmentId, req.user._id);
  if (!assessment) {
    const error = new Error('Assessment not found for this teacher');
    error.statusCode = 404;
    throw error;
  }

  const action = String(req.body?.action || 'grade').trim().toLowerCase();
  if (!['grade', 'return_for_revision'].includes(action)) {
    const error = new Error('Review action must be grade or return_for_revision');
    error.statusCode = 400;
    throw error;
  }
  const currentSubmission = await findActivitySubmissionById(req.params.submissionId, assessment._id);
  if (!currentSubmission) {
    const error = new Error('Student submission not found');
    error.statusCode = 404;
    throw error;
  }
  if (!['completed', 'auto_submitted', 'terminated'].includes(String(currentSubmission.status || ''))) {
    const error = new Error('Only submitted work can be graded or returned');
    error.statusCode = 409;
    throw error;
  }
  const teacherFeedback = String(req.body?.teacherFeedback || '').trim();
  const now = new Date().toISOString();
  let values;

  if (action === 'return_for_revision') {
    if (String(assessment.assessmentMode || '').trim().toLowerCase() !== 'activity') {
      throw Object.assign(new Error('Only classroom activities can be returned for revision'), { statusCode: 400 });
    }
    if (assessment.allowResubmission === false) {
      const error = new Error('Enable student editing/resubmission before returning work for revision');
      error.statusCode = 409;
      throw error;
    }
    if (!teacherFeedback) {
      const error = new Error('Teacher feedback is required when returning work for revision');
      error.statusCode = 400;
      throw error;
    }
    values = {
      score: 0,
      totalPoints: 0,
      gradeValue: null,
      teacherFeedback,
      gradedAt: null,
      returnedAt: now,
      status: 'returned_for_revision',
    };
  } else {
    const activityPoints = String(assessment.assessmentMode || '').trim().toLowerCase() === 'activity'
      ? Number(assessment.activityPoints || 0)
      : Number(currentSubmission.totalPoints || (assessment.questions || []).reduce((sum, question) => sum + Number(question?.points || 1), 0));
    const gradeValue = Number(req.body?.gradeValue);
    if (!Number.isFinite(gradeValue) || gradeValue < 0 || gradeValue > activityPoints) {
      const error = new Error(`Grade must be from 0 to ${activityPoints}`);
      error.statusCode = 400;
      throw error;
    }
    values = {
      score: gradeValue,
      totalPoints: activityPoints,
      gradeValue,
      teacherFeedback,
      gradedAt: now,
      returnedAt: null,
      status: 'completed',
      aiEvaluations: currentSubmission.aiEvaluations,
      aiScore: currentSubmission.aiScore,
      teacherAdjustedScore: gradeValue,
      scoringStatus: currentSubmission.aiScore == null ? 'teacher_approved' : (Number(currentSubmission.aiScore) === gradeValue ? 'teacher_approved' : 'teacher_overridden'),
    };
  }

  const submission = await updateActivityReview({
    submissionId: req.params.submissionId,
    assessmentId: assessment._id,
    values,
  });
  if (!submission) {
    const error = new Error('Student submission not found');
    error.statusCode = 404;
    throw error;
  }

  if (action === 'grade' && String(assessment.assessmentMode || '').trim().toLowerCase() === 'grading_assessment') {
    await syncStudentSubjectGradeRecords(submission.studentId);
  }

  await safelyRunNotificationTask('activity review', () => createStudentNotifications({
    recipientIds: [submission.studentId],
    sender: req.user,
    type: action === 'return_for_revision' ? 'teacher_feedback' : 'grade_released',
    title: action === 'return_for_revision' ? 'Activity returned for revision' : 'Assessment grade published',
    subject: assessment.title,
    preview: action === 'return_for_revision'
      ? teacherFeedback
      : `Your score is ${values.gradeValue} out of ${values.totalPoints}.`,
    eventKey: `activity-review:${submission.id}:${action}:${now}`,
    meta: {
      route: String(assessment.assessmentMode || '').trim().toLowerCase() === 'activity'
        ? `/student/activities?assessmentId=${encodeURIComponent(String(assessment._id))}`
        : '/student/dashboard?section=grades',
      entityType: 'submission',
      entityId: submission.id,
    },
  }));

  return sendSuccess(
    res,
    200,
    action === 'return_for_revision' ? 'Activity returned for revision' : 'Assessment grade published',
    { submission }
  );
});

const getSubjectAssessmentWeights = asyncHandler(async (req, res) => {
  const subject = await findTeacherSubject(req.user._id, req.params.subjectId);
  if (!subject) throw Object.assign(new Error('Class not found for this teacher'), { statusCode: 404 });
  const { data, error } = await getSupabaseStorageClient().from('assessment_weights').select('*')
    .eq('subject_id', String(subject._id)).limit(1).maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  return sendSuccess(res, 200, 'Assessment weights fetched successfully', {
    weights: data ? {
      activity: Number(data.activity_weight), quiz: Number(data.quiz_weight), exam: Number(data.exam_weight),
      minimumEvidenceCount: Number(data.minimum_evidence_count || 2),
    } : { activity: 30, quiz: 30, exam: 40, minimumEvidenceCount: 2 },
  });
});

const updateSubjectAssessmentWeights = asyncHandler(async (req, res) => {
  const subject = await findTeacherSubject(req.user._id, req.params.subjectId);
  if (!subject) throw Object.assign(new Error('Class not found for this teacher'), { statusCode: 404 });
  const activity = Number(req.body?.activity);
  const quiz = Number(req.body?.quiz);
  const exam = Number(req.body?.exam);
  const minimumEvidenceCount = Number(req.body?.minimumEvidenceCount || 2);
  if (![activity, quiz, exam].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
    throw Object.assign(new Error('Each assessment weight must be from 0 to 100'), { statusCode: 400 });
  }
  if (Math.abs(activity + quiz + exam - 100) > 0.001) {
    throw Object.assign(new Error('Activity, Quiz, and Exam weights must total 100%'), { statusCode: 400 });
  }
  if (!Number.isInteger(minimumEvidenceCount) || minimumEvidenceCount < 1 || minimumEvidenceCount > 20) {
    throw Object.assign(new Error('Minimum evidence count must be from 1 to 20'), { statusCode: 400 });
  }
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseStorageClient().from('assessment_weights').upsert({
    subject_id: String(subject._id), activity_weight: activity, quiz_weight: quiz, exam_weight: exam,
    minimum_evidence_count: minimumEvidenceCount, updated_by: String(req.user._id), updated_at: now,
  }, { onConflict: 'subject_id' }).select('*').single();
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  return sendSuccess(res, 200, 'Assessment weights updated successfully', { weights: {
    activity: Number(data.activity_weight), quiz: Number(data.quiz_weight), exam: Number(data.exam_weight),
    minimumEvidenceCount: Number(data.minimum_evidence_count),
  } });
});

const getEnrollmentRequests = asyncHandler(async (req, res) => {
  const subjectFilter = String(req.query.subjectId || '').trim();
  const pendingRequests = await teacherRequests(req.user._id, subjectFilter);

  const requests = uniqueBy(pendingRequests, (row) => String(row?._id || '')).map((row) => {
    const student = row.studentId || {};
    const subject = row.subjectId || {};
    return {
      id: String(row._id),
      studentId: String(student._id || ''),
      name: student.name,
      email: student.email,
      status: student.status,
      enrollmentStatus: row.status || 'pending',
      enrollmentTrack: String(subject.track || '').trim(),
      enrollmentTrackId: String(subject.track || '').trim(),
      requestedAt: row.requestedAt || null,
      sectionId: String(row?.sectionId?._id || row?.sectionId || student?.sectionId?._id || student?.sectionId || ''),
      sectionName: String(row?.sectionId?.name || student?.sectionId?.name || row?.sectionName || '').trim(),
      subjectId: String(subject._id || ''),
      subjectName: String(subject.name || '').trim(),
      className: String(subject.className || '').trim(),
      subjectCode: String(subject.code || '').trim(),
      avatar: userProfileImageToUrl(student, req) || `https://ui-avatars.com/api/?name=${encodeURIComponent(student.name || 'Student')}&background=334155&color=fff`,
      profileImage: userProfileImageToUrl(student, req),
    };
  });

  return sendSuccess(res, 200, 'Enrollment requests fetched successfully', {
    requests,
  });
});

const getTeacherSubjectStudents = asyncHandler(async (req, res) => {
  const { subjectId } = req.params;
  const { subject, enrollments } = await subjectStudents(req.user._id, subjectId);

  const students = uniqueBy(enrollments, (row) => String(row?.studentId?._id || ''))
    .filter((row) => !isArchivedStudent(row?.studentId))
    .map((row) => {
      const student = row.studentId || {};
      return {
        id: String(student._id || ''),
        name: student.name || 'Student',
        email: student.email || '',
        status: student.status || 'active',
        avatar: userProfileImageToUrl(student, req) || `https://ui-avatars.com/api/?name=${encodeURIComponent(student.name || 'Student')}&background=334155&color=fff`,
        sectionId: String(row?.sectionId?._id || row?.sectionId || student?.sectionId?._id || student?.sectionId || ''),
        sectionName: String(row?.sectionId?.name || student?.sectionId?.name || row?.sectionName || '').trim(),
        gradeLevel: String(student?.gradeLevel || '').trim(),
        subjectId: String(subject._id || ''),
        subjectName: String(subject.name || ''),
        subjectCode: String(subject.code || ''),
        track: String(subject.track || ''),
      };
    });

  return sendSuccess(res, 200, 'Subject students fetched successfully', {
    subject: subjectToResponse(subject),
    students,
  });
});

const removeTeacherSubjectStudent = asyncHandler(async (req, res) => {
  const { subjectId, studentId } = req.params;
  const { subject, enrollment } = await removeSubjectStudent(req.user._id, subjectId, studentId);
  const student = enrollment.studentId || {};

  return sendSuccess(res, 200, 'Student removed from class successfully', {
    subject: subjectToResponse(subject),
    student: {
      id: String(student._id || studentId || ''),
      name: String(student.name || '').trim(),
      email: String(student.email || '').trim(),
      sectionId: String(enrollment?.sectionId?._id || enrollment?.sectionId || student?.sectionId?._id || student?.sectionId || ''),
      sectionName: String(enrollment?.sectionId?.name || enrollment?.sectionName || '').trim(),
      profileImage: userProfileImageToUrl(student, req),
    },
  });
});

const approveEnrollmentRequest = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  const requestRow = await decideTeacherRequest(req.user._id, studentId, 'approved');

  const student = requestRow.studentId || {};
  const subject = requestRow.subjectId || {};

  return sendSuccess(res, 200, 'Enrollment request approved successfully', {
    student: {
      id: String(student._id || ''),
      name: student.name,
      email: student.email,
      sectionId: String(requestRow?.sectionId?._id || requestRow?.sectionId || student?.sectionId?._id || student?.sectionId || ''),
      sectionName: String(requestRow?.sectionId?.name || requestRow?.sectionName || '').trim(),
      enrollmentStatus: requestRow.status,
      enrollmentTrack: String(subject.track || '').trim(),
      enrollmentTrackId: String(subject.track || '').trim(),
      approvedAt: requestRow.decidedAt,
      subjectId: String(subject._id || ''),
      subjectName: String(subject.name || '').trim(),
      className: String(subject.className || '').trim(),
      subjectCode: String(subject.code || '').trim(),
      profileImage: userProfileImageToUrl(student, req),
    },
  });
});

const rejectEnrollmentRequest = asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  const requestRow = await decideTeacherRequest(req.user._id, studentId, 'rejected');

  const student = requestRow.studentId || {};
  const subject = requestRow.subjectId || {};

  return sendSuccess(res, 200, 'Enrollment request rejected successfully', {
    student: {
      id: String(student._id || ''),
      name: student.name,
      email: student.email,
      sectionId: String(requestRow?.sectionId?._id || requestRow?.sectionId || student?.sectionId?._id || student?.sectionId || ''),
      sectionName: String(requestRow?.sectionId?.name || requestRow?.sectionName || '').trim(),
      enrollmentStatus: requestRow.status,
      enrollmentTrack: String(subject.track || '').trim(),
      enrollmentTrackId: String(subject.track || '').trim(),
      subjectId: String(subject._id || ''),
      subjectName: String(subject.name || '').trim(),
      subjectCode: String(subject.code || '').trim(),
      profileImage: userProfileImageToUrl(student, req),
    },
  });
});

const getTeacherProfile = asyncHandler(async (req, res) => {
  return sendSuccess(res, 200, 'Profile fetched successfully', {
    user: teacherProfileResponse(req.user, req),
  });
});

const updateTeacherProfile = asyncHandler(async (req, res) => {
  const name = String(req.body?.name || req.body?.fullName || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const contactNumberRaw = String(req.body?.contactNumber || req.body?.phone || '').trim();
  const strandRaw = String(req.body?.strand || '').trim().toUpperCase();
  const uploadedImage = req.file || null;

  console.log('[TEMP][updateTeacherProfile] incoming payload:', {
    userId: String(req.user?._id || ''),
    role: req.user?.role || '',
    name,
    email,
    contactNumberRaw,
    strandRaw,
    hasProfileImage: Boolean(uploadedImage),
    profileImageMeta: uploadedImage
      ? { originalname: uploadedImage.originalname, mimetype: uploadedImage.mimetype, size: uploadedImage.size, filename: uploadedImage.filename }
      : null,
  });

  const profileError = nameError(name, 'Name', 101) || phoneError(contactNumberRaw);
  if (profileError) throw Object.assign(new Error(profileError), { statusCode: 400 });
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
    const existing = await findSupabaseAccountByEmail(email);
    if (existing) {
      const error = new Error('Email already exists');
      error.statusCode = 409;
      throw error;
    }
  }

  req.user.name = name;
  req.user.email = email;

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
    req.user.contactNumber = normalizedContact.startsWith('09') ? '+63' + normalizedContact.slice(1) : normalizedContact;
  } else {
    req.user.contactNumber = '';
  }

  if (!ALLOWED_TEACHER_STRANDS.includes(strandRaw)) {
    const error = new Error(`Strand must be one of: ${ALLOWED_TEACHER_STRANDS.filter(Boolean).join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  req.user.strand = strandRaw;

  if (uploadedImage) {
    const uploadedProfile = await uploadFile({
      file: uploadedImage,
      folder: `profile-images/teachers/${String(req.user?._id || 'unknown')}`,
    });
    req.user.profileImage = uploadedProfile.storedPath;
  }

  await req.user.save();
  console.log('[TEMP][updateTeacherProfile] saved user snapshot:', {
    userId: String(req.user?._id || ''),
    name: req.user.name,
    email: req.user.email,
    strand: req.user.strand || '',
    subject: req.user.subject || '',
    contactNumber: req.user.contactNumber || '',
    profileImage: req.user.profileImage || '',
  });

  return sendSuccess(res, 200, 'Profile updated successfully', {
    user: teacherProfileResponse(req.user, req),
  });
});

const updateTeacherTourPreference = asyncHandler(async (req, res) => {
  req.user.hasCompletedTeacherTour = req.body?.hasCompletedTeacherTour === true;
  await req.user.save();

  return sendSuccess(res, 200, 'Dashboard tour preference updated successfully', {
    user: teacherProfileResponse(req.user, req),
  });
});

module.exports = {
  createTeacherClass,
  updateTeacherClass,
  deleteTeacherClass,
  createLesson,
  getTeacherLessons,
  updateTeacherLesson,
  copyTeacherLessonToClasses,
  getTeacherSubjects,
  getTeacherAssessments,
  updateTeacherAssessment,
  copyTeacherAssessmentToClasses,
  downloadTeacherLessonPdf,
  downloadTeacherLessonAttachment,
  createAssessment,
  updateAssessmentQuestions,
  getAssessmentResultsSummary,
  getTeacherStudents,
  createStudentInvite,
  getTeacherSubjectStudents,
  removeTeacherSubjectStudent,
  getTeacherStudentAssessmentResults,
  reviewActivitySubmission,
  getSubjectAssessmentWeights,
  updateSubjectAssessmentWeights,
  getEnrollmentRequests,
  approveEnrollmentRequest,
  rejectEnrollmentRequest,
  getTeacherProfile,
  updateTeacherProfile,
  updateTeacherTourPreference,
};
