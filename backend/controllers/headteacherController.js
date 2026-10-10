const { nameError, phoneError } = require('../utils/teacherValidation');
const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Assessment = require('../models/Assessment');
const Submission = require('../models/Submission');
const { sendSuccess } = require('../utils/responseHelper');
const { ROLE_HEADTEACHER, ROLE_TEACHER, ROLE_STUDENT } = require('../constants/userRoles');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');
const { ensureTeacherSubject } = require('../services/subjectService');
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
  STRANDS,
  normalizeStrand,
  isSubjectAllowedForStrand,
  getSubjectCategory,
} = require('../constants/strandSubjects');
const {
  normalizeContactNumber,
  mapUserResponse,
  issueInviteForUser,
  applyRoleScopedFields,
} = require('../services/userManagementService');
const { uploadFiles } = require('../services/storageService');
const {
  findSectionById,
  getSectionOrThrow,
  syncTeacherAdvisoryAssignments,
} = require('../services/sectionService');
const {
  createSupabaseAccount,
  findSupabaseAccount,
  findSupabaseAccountByEmail,
  findSupabaseAccountByUsername,
  listSupabaseAccounts,
} = require('../services/supabaseAccountService');
const {
  createSupabaseLesson,
  listSupabaseLessons,
  findSupabaseLesson,
  createSupabaseAssessment,
  listSupabaseAssessments,
} = require('../services/supabaseContentService');
const { createAdminMessageNotification } = require('../services/notificationService');
const {
  notifyAssessmentAssigned,
  notifyLessonPublished,
  safelyRunNotificationTask,
} = require('../services/studentNotificationService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ALLOWED_ACCOUNT_STATUSES = ['pending', 'active', 'inactive', 'suspended'];
const DEFAULT_LESSON_ANALYTICS_MONTHS = 3;
const MIN_LESSON_ANALYTICS_MONTHS = 1;
const MAX_LESSON_ANALYTICS_MONTHS = 12;
const RECENT_TEACHER_CONTENT_DAYS = 30;

function sanitizeAnalyticsMonthCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LESSON_ANALYTICS_MONTHS;
  return Math.min(MAX_LESSON_ANALYTICS_MONTHS, Math.max(MIN_LESSON_ANALYTICS_MONTHS, parsed));
}

function buildRecentMonthBuckets(monthCount = DEFAULT_LESSON_ANALYTICS_MONTHS) {
  const buckets = [];
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  start.setUTCMonth(start.getUTCMonth() - (monthCount - 1));

  for (let index = 0; index < monthCount; index += 1) {
    const bucketDate = new Date(start);
    bucketDate.setUTCMonth(start.getUTCMonth() + index);
    buckets.push({
      year: bucketDate.getUTCFullYear(),
      month: bucketDate.getUTCMonth() + 1,
      label: bucketDate.toLocaleString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      count: 0,
    });
  }

  return buckets;
}

function buildMonthlyCreationAnalytics(content, teacherIds, monthCount) {
  const analyticsBuckets = buildRecentMonthBuckets(monthCount);
  const teacherIdSet = teacherIds instanceof Set ? teacherIds : new Set(teacherIds);
  if (!teacherIdSet.size) {
    return analyticsBuckets;
  }

  const bucketLookup = new Map(analyticsBuckets.map((bucket) => [`${bucket.year}-${bucket.month}`, bucket]));
  content.forEach((entry) => {
    if (!teacherIdSet.has(String(entry?.createdBy || ''))) return;
    const activityDate = entry?.createdAt || entry?.updatedAt;
    const parsedDate = activityDate ? new Date(activityDate) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) return;
    const bucket = bucketLookup.get(`${parsedDate.getUTCFullYear()}-${parsedDate.getUTCMonth() + 1}`);
    if (bucket) bucket.count += 1;
  });

  return analyticsBuckets;
}

function buildLatestTeacherContentActivity(content, teacherIds) {
  const teacherIdSet = teacherIds instanceof Set ? teacherIds : new Set(teacherIds);
  const latestByTeacher = new Map();
  content.forEach((entry) => {
    const teacherId = String(entry?.createdBy || '');
    if (!teacherIdSet.has(teacherId)) return;
    const parsedDate = entry?.createdAt ? new Date(entry.createdAt) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) return;
    const current = latestByTeacher.get(teacherId);
    if (!current || parsedDate > current) latestByTeacher.set(teacherId, parsedDate);
  });
  return latestByTeacher;
}

function ensureHeadTeacher(req) {
  if (String(req.user?.role || '') !== ROLE_HEADTEACHER) {
    const error = new Error('Only HeadTeachers can perform this action');
    error.statusCode = 403;
    throw error;
  }
  const department = String(req.user?.department || '').trim();
  if (!department) {
    const error = new Error('Your HeadTeacher account is missing a department assignment');
    error.statusCode = 400;
    throw error;
  }
  return department;
}

function normalizeLessonUploads(files) {
  const uploadedFiles = Array.isArray(files) ? files : [];
  const seen = new Set();
  return uploadedFiles.filter((file) => {
    const key = `${String(file?.originalname || '').trim().toLowerCase()}:${String(file?.mimetype || '').trim().toLowerCase()}:${Number(file?.size || 0)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildLessonAttachmentPayload(files, { teacherId = '' } = {}) {
  const uploadedFiles = await uploadFiles(normalizeLessonUploads(files), {
    folder: `headteacher-lessons/${String(teacherId || 'unknown')}`,
  });

  return uploadedFiles.map((file) => ({
    originalName: file.originalName,
    storedPath: file.storedPath,
    mimeType: file.mimeType,
    extension: file.extension,
    size: file.size,
    uploadedAt: file.uploadedAt,
  }));
}

function headTeacherLessonToResponse(lesson, teacher) {
  const publisher = lesson?.publishedBy && typeof lesson.publishedBy === 'object'
    ? lesson.publishedBy
    : null;

  return {
    id: String(lesson?._id || ''),
    title: String(lesson?.title || '').trim(),
    description: String(lesson?.description || '').trim(),
    track: String(lesson?.track || '').trim(),
    subject: String(lesson?.subject || '').trim(),
    subjectCode: String(lesson?.subjectCode || '').trim(),
    subjectCategory: String(lesson?.subjectCategory || '').trim(),
    pdfOriginalName: String(lesson?.pdfOriginalName || '').trim(),
    createdAt: lesson?.createdAt || null,
    creator: publisher
      ? {
        id: String(publisher._id || ''),
        name: String(publisher.name || 'Head Teacher').trim() || 'Head Teacher',
        role: String(publisher.role || ROLE_HEADTEACHER).trim() || ROLE_HEADTEACHER,
      }
      : {
        id: String(teacher?._id || ''),
        name: String(teacher?.name || 'Teacher').trim() || 'Teacher',
        role: ROLE_TEACHER,
      },
    teacher: {
      id: String(teacher?._id || ''),
      name: String(teacher?.name || 'Teacher').trim() || 'Teacher',
      subject: String(teacher?.subject || teacher?.department || '').trim(),
      department: String(teacher?.department || '').trim(),
    },
  };
}

function resolveAssessmentSubjectCategory({ subjectCategory, examType, title, lessonTrack }) {
  return normalizeSubjectCategory(subjectCategory)
    || inferSubjectCategory({ subjectCategory, examType, title, lessonTrack })
    || 'Technical';
}

async function findManagedTeacherForHeadTeacher(req, teacherId, options = {}) {
  const department = options.department || ensureHeadTeacher(req);
  const teacher = await findSupabaseAccount('id', String(teacherId || '').trim());

  if (
    !teacher
    || String(teacher.role || '') !== ROLE_TEACHER
    || String(teacher.department || '') !== department
    || String(teacher.managedBy || '') !== String(req.user._id || '')
  ) {
    const error = new Error('Teacher not found');
    error.statusCode = 404;
    throw error;
  }

  return teacher;
}

function ensureManagedTeacherSubject(teacher, requestedSubject) {
  const teacherSubject = String(teacher?.subject || teacher?.department || '').trim();
  if (!teacherSubject) {
    const error = new Error('The selected teacher has no assigned subject');
    error.statusCode = 400;
    throw error;
  }

  const normalizedRequested = String(requestedSubject || '').trim();
  if (normalizedRequested && normalizedRequested !== teacherSubject) {
    const error = new Error(`Assessments for this teacher must stay within the assigned subject: ${teacherSubject}`);
    error.statusCode = 403;
    throw error;
  }

  return teacherSubject;
}

function headTeacherAssessmentToResponse(assessment, teacher, submissionCountsByAssessment = new Map()) {
  return {
    id: String(assessment?._id || ''),
    teacherId: String(teacher?._id || assessment?.createdBy || ''),
    teacherName: String(teacher?.name || 'Teacher').trim() || 'Teacher',
    title: String(assessment?.title || '').trim(),
    examType: String(assessment?.examType || '').trim(),
    subject: String(assessment?.subject || assessment?.lessonId?.subject || '').trim(),
    subjectId: String(assessment?.subjectId || assessment?.lessonId?.subjectId || ''),
    subjectCode: String(assessment?.subjectCode || assessment?.lessonId?.subjectCode || ''),
    subjectCategory: String(assessment?.subjectCategory || 'Technical').trim() || 'Technical',
    difficulty: String(assessment?.difficulty || '').trim(),
    numberOfItems: Number(assessment?.numberOfItems || 0),
    assessmentMode: String(assessment?.assessmentMode || 'activity'),
    gradingPeriod: normalizeGradingPeriod(assessment?.gradingPeriod),
    countsTowardRecommendation: Boolean(assessment?.countsTowardRecommendation)
      && Boolean(normalizeGradingPeriod(assessment?.gradingPeriod)),
    assignmentScope: String(assessment?.assignmentScope || 'handled_class'),
    assignedStudentsCount: Array.isArray(assessment?.assignedStudentIds) ? assessment.assignedStudentIds.length : 0,
    examDurationMinutes: Number(assessment?.examDurationMinutes || 30),
    submissionDeadline: assessment?.submissionDeadline || null,
    isDeadlinePassed: assessment?.submissionDeadline ? isPastDate(assessment.submissionDeadline) : false,
    challengeDescription: String(assessment?.challengeDescription || '').trim(),
    questionsCount: Array.isArray(assessment?.questions) ? assessment.questions.length : 0,
    questions: Array.isArray(assessment?.questions) ? assessment.questions : [],
    lessonTitle: String(assessment?.lessonId?.title || '').trim(),
    lessonTrack: String(assessment?.lessonId?.track || '').trim(),
    submissionsCount: submissionCountsByAssessment.get(String(assessment?._id || '')) || 0,
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
    createdAt: assessment?.createdAt || null,
    updatedAt: assessment?.updatedAt || null,
  };
}

const getManagedTeachers = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const analyticsMonthCount = sanitizeAnalyticsMonthCount(req.query?.months);
  const headTeacherId = String(req.user?._id || req.user?.id || '').trim();
  const accounts = await listSupabaseAccounts();
  const teachers = accounts
    .filter((account) => (
      String(account?.role || '').trim() === ROLE_TEACHER
      && String(account?.department || '').trim() === department
      && String(account?.managedBy?._id || account?.managedBy?.id || account?.managedBy || '').trim() === headTeacherId
    ))
    .sort((left, right) => new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime());

  const teacherAccountIds = teachers
    .map((teacher) => String(teacher?._id || teacher?.id || '').trim())
    .filter(Boolean);
  const teacherAccountIdSet = new Set(teacherAccountIds);
  const studentCount = accounts.filter((account) => (
    String(account?.role || '').trim() === ROLE_STUDENT
    && teacherAccountIds.includes(String(account?.managedBy?._id || account?.managedBy?.id || account?.managedBy || '').trim())
    && account?.archive?.isArchived !== true
  )).length;
  const [allLessons, allAssessments] = await Promise.all([
    listSupabaseLessons(),
    listSupabaseAssessments(),
  ]);
  const lessons = allLessons.filter((lesson) => teacherAccountIdSet.has(String(lesson?.createdBy || '')));
  const assessments = allAssessments.filter((assessment) => teacherAccountIdSet.has(String(assessment?.createdBy || '')));
  const lessonCount = lessons.length;
  const assessmentCount = assessments.length;
  const latestLessonActivity = buildLatestTeacherContentActivity(lessons, teacherAccountIdSet);
  const latestAssessmentActivity = buildLatestTeacherContentActivity(assessments, teacherAccountIdSet);
  const lessonAnalyticsBuckets = buildMonthlyCreationAnalytics(lessons, teacherAccountIdSet, analyticsMonthCount);
  const assessmentAnalyticsBuckets = buildMonthlyCreationAnalytics(assessments, teacherAccountIdSet, analyticsMonthCount);

  const teachersPayload = teachers.map((teacher) => {
    const mappedTeacher = mapUserResponse(teacher, req);
    return mappedTeacher;
  });
  const activeTeachers = teachersPayload.filter((teacher) => String(teacher.status || '').trim().toLowerCase() === 'active').length;
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const recentContentCutoff = new Date(now.getTime() - (RECENT_TEACHER_CONTENT_DAYS * 24 * 60 * 60 * 1000));
  const latestContentByTeacher = new Map();

  [latestLessonActivity, latestAssessmentActivity].forEach((activityMap) => {
    activityMap.forEach((activityDate, teacherId) => {
      const existingDate = latestContentByTeacher.get(teacherId);
      if (!existingDate || activityDate > existingDate) latestContentByTeacher.set(teacherId, activityDate);
    });
  });

  const inactiveTeachers = teachersPayload.filter((teacher) => String(teacher.status || '').trim().toLowerCase() === 'inactive').length;
  const pendingTeacherAccounts = teachersPayload.filter((teacher) => String(teacher.status || '').trim().toLowerCase() === 'pending').length;
  const teachersWithoutRecentContent = teachersPayload.filter((teacher) => {
    if (String(teacher.status || '').trim().toLowerCase() !== 'active') return false;
    const lastContentAt = latestContentByTeacher.get(String(teacher._id || teacher.id || ''));
    return !lastContentAt || lastContentAt < recentContentCutoff;
  }).length;
  const teachersActiveThisMonth = teachersPayload.filter((teacher) => {
    if (String(teacher.status || '').trim().toLowerCase() !== 'active') return false;
    const teacherId = String(teacher._id || teacher.id || '');
    const accountActivityAt = teacher.lastActivityAt || teacher.lastLoginAt;
    const accountActivityDate = accountActivityAt ? new Date(accountActivityAt) : null;
    const contentActivityDate = latestContentByTeacher.get(teacherId);
    const usedAccountThisMonth = accountActivityDate
      && !Number.isNaN(accountActivityDate.getTime())
      && accountActivityDate >= currentMonthStart;
    const createdContentThisMonth = contentActivityDate && contentActivityDate >= currentMonthStart;
    return Boolean(usedAccountThisMonth || createdContentThisMonth);
  }).length;

  return sendSuccess(res, 200, 'Teachers fetched successfully', {
    department,
    teachers: teachersPayload,
    summary: {
      totalTeachers: teachersPayload.length,
      activeTeachers,
      totalStudents: studentCount,
      totalLessonsAndAssessments: Number(lessonCount || 0) + Number(assessmentCount || 0),
      totalLessons: lessonCount,
      totalAssessments: assessmentCount,
      attention: {
        inactiveTeachers,
        teachersWithoutRecentContent,
        pendingTeacherAccounts,
        recentContentWindowDays: RECENT_TEACHER_CONTENT_DAYS,
      },
      teacherActivity: {
        activeThisMonth: teachersActiveThisMonth,
        eligibleTeachers: activeTeachers,
        monthStart: currentMonthStart,
      },
      lessonAnalytics: {
        months: analyticsMonthCount,
        labels: lessonAnalyticsBuckets.map((bucket) => bucket.label),
        values: lessonAnalyticsBuckets.map((bucket) => bucket.count),
      },
      assessmentAnalytics: {
        months: analyticsMonthCount,
        labels: assessmentAnalyticsBuckets.map((bucket) => bucket.label),
        values: assessmentAnalyticsBuckets.map((bucket) => bucket.count),
      },
    },
  });
});

const createTeacherAccount = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const {
    name,
    email,
    username,
    status,
    subject,
    contactNumber,
    advisorySectionId,
  } = req.body || {};

  if (!name || !email || !username) {
    const error = new Error('name, email, and username are required');
    error.statusCode = 400;
    throw error;
  }

  const validationMessage = nameError(name, 'Full name', 100) || phoneError(contactNumber)
    || (/\p{N}/u.test(String(username)) ? 'Username must not contain numbers.' : '');
  if (validationMessage) throw Object.assign(new Error(validationMessage), { statusCode: 400 });
  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedUsername = String(username || '').trim();
  const existing = await findSupabaseAccountByEmail(normalizedEmail);
  if (existing) {
    const error = new Error('Email already exists');
    error.statusCode = 409;
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

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus && !ALLOWED_ACCOUNT_STATUSES.includes(normalizedStatus)) {
    const error = new Error(`status must be one of: ${ALLOWED_ACCOUNT_STATUSES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const scopedFields = applyRoleScopedFields({
    role: ROLE_TEACHER,
    department,
    subject,
  });

  const created = await createSupabaseAccount({
    name: String(name).trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    role: ROLE_TEACHER,
    status: 'active',
    subject: scopedFields.subject,
    department: scopedFields.department,
    advisorySectionId: advisorySectionId ? String(advisorySectionId).trim() : undefined,
    strand: '',
    gradeLevel: '',
    contactNumber: normalizeContactNumber(contactNumber),
    managedBy: req.user._id,
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

  return sendSuccess(res, 201, 'Teacher account created successfully', {
    user: mapUserResponse(created, req),
    invite: inviteResult,
  });
});

const createStudentAccount = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const {
    teacherId,
    name,
    email,
    username,
    contactNumber,
  } = req.body || {};

  if (!teacherId || !name || !email || !username) {
    const error = new Error('teacherId, name, email, and username are required');
    error.statusCode = 400;
    throw error;
  }

  const validationMessage = nameError(name, 'Full name', 100) || phoneError(contactNumber);
  if (validationMessage) throw Object.assign(new Error(validationMessage), { statusCode: 400 });

  const teacher = await findManagedTeacherForHeadTeacher(req, teacherId, { department });
  const advisorySectionId = String(
    teacher?.advisorySectionId?._id || teacher?.advisorySectionId?.id || teacher?.advisorySectionId || ''
  ).trim();
  if (!advisorySectionId) {
    const error = new Error('The selected teacher must have an advisory section before a student can be created');
    error.statusCode = 409;
    throw error;
  }
  await getSectionOrThrow(advisorySectionId);

  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedUsername = String(username).trim();
  if (normalizedUsername.length > 50) {
    const error = new Error('username must be 50 characters or fewer');
    error.statusCode = 400;
    throw error;
  }

  const [existingEmail, existingUsername] = await Promise.all([
    findSupabaseAccountByEmail(normalizedEmail),
    findSupabaseAccountByUsername(normalizedUsername),
  ]);
  if (existingEmail) {
    const error = new Error('Email already exists');
    error.statusCode = 409;
    throw error;
  }
  if (existingUsername) {
    const error = new Error('Username already exists');
    error.statusCode = 409;
    throw error;
  }

  const now = new Date();
  const normalizedTeacherId = String(teacher._id || teacher.id).trim();
  const created = await createSupabaseAccount({
    name: String(name).trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    role: ROLE_STUDENT,
    status: 'active',
    sectionId: advisorySectionId,
    department,
    gradeLevel: 'Grade 10',
    contactNumber: normalizeContactNumber(contactNumber),
    managedBy: normalizedTeacherId,
    enrollment: {
      teacherId: normalizedTeacherId,
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
  const inviteResult = await issueInviteForUser({ user: created, req });

  return sendSuccess(res, 201, 'Student account created successfully', {
    user: mapUserResponse(created, req),
    teacher: {
      id: normalizedTeacherId,
      name: String(teacher.name || 'Teacher').trim() || 'Teacher',
      advisorySectionId,
    },
    invite: inviteResult,
  });
});

const updateManagedTeacher = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const { id } = req.params;
  const { name, email, status, subject, contactNumber, advisorySectionId } = req.body || {};

  const teacher = await findManagedTeacherForHeadTeacher(req, id, { department });

  if (email && String(email).toLowerCase().trim() !== teacher.email) {
    const existing = await findSupabaseAccountByEmail(String(email).toLowerCase().trim());
    if (existing && String(existing._id || existing.id) !== String(teacher._id || teacher.id)) {
      const error = new Error('Email already exists');
      error.statusCode = 409;
      throw error;
    }
  }

  if (name !== undefined) teacher.name = String(name).trim();
  if (email !== undefined) teacher.email = String(email).toLowerCase().trim();
  if (status !== undefined) {
    const normalizedStatus = String(status || '').trim().toLowerCase();
    if (!ALLOWED_ACCOUNT_STATUSES.includes(normalizedStatus)) {
      const error = new Error(`status must be one of: ${ALLOWED_ACCOUNT_STATUSES.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
    teacher.status = normalizedStatus;
  }
  if (contactNumber !== undefined) teacher.contactNumber = normalizeContactNumber(contactNumber);

  if (subject !== undefined) {
    const scopedFields = applyRoleScopedFields({
      role: ROLE_TEACHER,
      department,
      subject,
    });
    teacher.department = scopedFields.department;
    teacher.subject = scopedFields.subject;
  }

  const previousAdvisorySectionId = String(teacher.advisorySectionId || '').trim();
  if (advisorySectionId !== undefined) {
    teacher.advisorySectionId = advisorySectionId
      ? (await getSectionOrThrow(advisorySectionId))._id
      : undefined;
  }

  await teacher.save();
  await syncTeacherAdvisoryAssignments({
    previousSectionId: previousAdvisorySectionId,
    nextSectionId: teacher.advisorySectionId,
  });

  return sendSuccess(res, 200, 'Teacher updated successfully', {
    user: mapUserResponse(teacher, req),
  });
});

const getManagedTeacherStudents = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const { id } = req.params;
  const teacher = await findManagedTeacherForHeadTeacher(req, id, { department });
  const accounts = await listSupabaseAccounts();
  const teacherId = String(teacher._id || teacher.id || '').trim();
  const managedStudents = accounts.filter((account) => (
    String(account?.role || '').trim() === ROLE_STUDENT
    && String(account?.managedBy?._id || account?.managedBy?.id || account?.managedBy || '').trim() === teacherId
    && account?.archive?.isArchived !== true
  ));
  const sectionIds = [...new Set(managedStudents
    .map((student) => String(student?.sectionId?._id || student?.sectionId?.id || student?.sectionId || '').trim())
    .filter(Boolean))];
  const sectionRows = await Promise.all(sectionIds.map((sectionId) => (
    findSectionById(sectionId, { includeInactive: true })
  )));
  const sectionNameById = new Map(
    sectionRows.filter(Boolean).map((section) => [String(section._id || section.id), section.name])
  );
  const students = managedStudents;

  const studentsPayload = students.map((student) => ({
    id: String(student._id),
    name: String(student.name || 'Student').trim() || 'Student',
    email: String(student.email || '').trim(),
    status: String(student.status || 'active').trim().toLowerCase(),
    gradeLevel: String(student.gradeLevel || '').trim(),
    sectionId: String(student?.sectionId?._id || student?.sectionId?.id || student.sectionId || '').trim(),
    sectionName: sectionNameById.get(String(student?.sectionId?._id || student?.sectionId?.id || student.sectionId || '').trim()) || '',
    track: String(student.enrollment?.track || student.enrollment?.trackId || '').trim(),
    createdAt: student.createdAt || null,
    avatar: String(student.profileImage || '').trim()
      || `https://ui-avatars.com/api/?name=${encodeURIComponent(String(student.name || 'Student').trim() || 'Student')}&background=334155&color=fff`,
  }));

  return sendSuccess(res, 200, 'Teacher students fetched successfully', {
    teacher: {
      id: String(teacher._id),
      name: String(teacher.name || 'Teacher').trim() || 'Teacher',
      email: String(teacher.email || '').trim(),
      department: String(teacher.department || department).trim() || department,
      subject: String(teacher.subject || teacher.department || department).trim() || department,
      advisorySectionId: String(teacher?.advisorySectionId?._id || teacher?.advisorySectionId || '').trim(),
      advisorySectionName: String((await findSectionById(teacher.advisorySectionId, { includeInactive: true }))?.name || '').trim(),
      status: String(teacher.status || 'active').trim().toLowerCase(),
      avatar: String(teacher.profileImage || '').trim()
        || `https://ui-avatars.com/api/?name=${encodeURIComponent(String(teacher.name || 'Teacher').trim() || 'Teacher')}&background=334155&color=fff`,
    },
    students: studentsPayload,
    summary: {
      totalStudents: studentsPayload.length,
      activeStudents: studentsPayload.filter((student) => student.status === 'active').length,
    },
  });
});

const getManagedTeacherLessons = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const accounts = await listSupabaseAccounts();
  const teachers = accounts.filter((account) => (
    String(account.role || '') === ROLE_TEACHER
    && String(account.department || '') === department
    && String(account.managedBy?._id || account.managedBy?.id || account.managedBy || '') === String(req.user._id || '')
  ));

  if (teachers.length === 0) {
    return sendSuccess(res, 200, 'Managed lessons fetched successfully', {
      lessons: [],
      summary: {
        totalLessons: 0,
        totalTeachers: 0,
      },
    });
  }

  const teacherMap = new Map(teachers.map((teacher) => [String(teacher._id), teacher]));
  const teacherIds = new Set(teachers.map((teacher) => String(teacher._id || teacher.id)));
  const lessons = (await listSupabaseLessons()).filter((lesson) => teacherIds.has(String(lesson.createdBy)));

  return sendSuccess(res, 200, 'Managed lessons fetched successfully', {
    lessons: lessons.map((lesson) => headTeacherLessonToResponse(lesson, teacherMap.get(String(lesson.createdBy)))),
    summary: {
      totalLessons: lessons.length,
      totalTeachers: teachers.length,
    },
  });
});

const createManagedTeacherLesson = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const { teacherId, title, description, track, strand } = req.body || {};
  const normalizedTeacherId = String(teacherId || '').trim();
  const normalizedTitle = String(title || '').trim();
  const normalizedDescription = String(description || '').trim();

  if (!normalizedTeacherId || !normalizedTitle || !normalizedDescription) {
    const error = new Error('teacherId, title, and description are required');
    error.statusCode = 400;
    throw error;
  }

  const teacher = await findManagedTeacherForHeadTeacher(req, normalizedTeacherId, { department });

  const normalizedTrack = normalizeStrand(strand || track || teacher.strand || 'GENERAL') || 'GENERAL';
  const normalizedSubject = String(teacher.department || department).trim();

  if (!normalizedSubject) {
    const error = new Error('The selected teacher has no assigned department');
    error.statusCode = 400;
    throw error;
  }

  if (!STRANDS.includes(normalizedTrack)) {
    const error = new Error(`strand must be one of: ${STRANDS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  if (!isSubjectAllowedForStrand({ strand: normalizedTrack, subject: normalizedSubject })) {
    const error = new Error(`subject is invalid for strand ${normalizedTrack}`);
    error.statusCode = 400;
    throw error;
  }

  const uploadedFiles = Array.isArray(req.files?.lessonPlanFile) ? req.files.lessonPlanFile : [];
  if (uploadedFiles.length !== 1) {
    const error = new Error('Exactly one lesson plan PDF is required');
    error.statusCode = 400;
    throw error;
  }

  const duplicateLesson = (await listSupabaseLessons(teacher._id)).find((item) => (
    String(item.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
    && String(item.track || '').trim().toLowerCase() === normalizedTrack.toLowerCase()
  ));

  if (duplicateLesson) {
    const error = new Error('A lesson with the same title and track already exists for this teacher');
    error.statusCode = 409;
    throw error;
  }

  const normalizedSubjectCategory = getSubjectCategory(normalizedSubject);

  const attachmentsPayload = await buildLessonAttachmentPayload(uploadedFiles, {
    teacherId: teacher._id,
  });
  const primaryAttachment = attachmentsPayload[0];

  const lesson = await createSupabaseLesson({
    title: normalizedTitle,
    description: normalizedDescription,
    track: normalizedTrack,
    subject: normalizedSubject,
    subjectId: null,
    subjectCode: '',
    subjectCategory: normalizedSubjectCategory,
    pdfPath: primaryAttachment.storedPath,
    pdfOriginalName: primaryAttachment.originalName,
    attachments: attachmentsPayload,
    createdBy: teacher._id,
    publishedBy: req.user._id,
  });

  return sendSuccess(res, 201, 'Lesson created and assigned successfully', {
    lesson: headTeacherLessonToResponse(lesson, teacher),
  });
});

const getManagedTeacherAssessments = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const accounts = await listSupabaseAccounts();
  const teachers = accounts.filter((account) => (
    String(account.role || '') === ROLE_TEACHER
    && String(account.department || '') === department
    && String(account.managedBy?._id || account.managedBy?.id || account.managedBy || '') === String(req.user._id || '')
  ));

  if (teachers.length === 0) {
    return sendSuccess(res, 200, 'Managed assessments fetched successfully', {
      assessments: [],
      summary: {
        totalAssessments: 0,
        totalTeachers: 0,
      },
    });
  }

  const teacherMap = new Map(teachers.map((teacher) => [String(teacher._id), teacher]));
  const teacherIds = new Set(teachers.map((teacher) => String(teacher._id || teacher.id)));
  const [allAssessments, allLessons] = await Promise.all([
    listSupabaseAssessments(),
    listSupabaseLessons(),
  ]);
  const lessonMap = new Map(allLessons.map((lesson) => [String(lesson._id), lesson]));
  const assessments = allAssessments.filter((assessment) => teacherIds.has(String(assessment.createdBy)));
  assessments.forEach((assessment) => {
    if (assessment.lessonId) assessment.lessonId = lessonMap.get(String(assessment.lessonId)) || assessment.lessonId;
  });
  const submissionCountsByAssessment = new Map();

  return sendSuccess(res, 200, 'Managed assessments fetched successfully', {
    assessments: assessments.map((assessment) => headTeacherAssessmentToResponse(
      assessment,
      teacherMap.get(String(assessment.createdBy || '')),
      submissionCountsByAssessment
    )),
    summary: {
      totalAssessments: assessments.length,
      totalTeachers: teachers.length,
    },
  });
});

const createManagedTeacherAssessment = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const {
    teacherId,
    lessonId,
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
  } = req.body || {};

  if (!teacherId || !lessonId || !title || !examType || !difficulty || !numberOfItems) {
    const error = new Error('teacherId, lessonId, title, examType, difficulty, and numberOfItems are required');
    error.statusCode = 400;
    throw error;
  }

  const teacher = await findManagedTeacherForHeadTeacher(req, teacherId, { department });
  const lesson = await findSupabaseLesson(lessonId, teacher._id);
  if (!lesson) {
    const error = new Error('Lesson not found for the selected teacher');
    error.statusCode = 404;
    throw error;
  }

  const normalizedTitle = String(title || '').trim();
  const normalizedSubject = ensureManagedTeacherSubject(teacher, String(subject || lesson.subject || '').trim());
  const lessonStrand = normalizeStrand(lesson.track);
  if (!isSubjectAllowedForStrand({ strand: lessonStrand, subject: normalizedSubject })) {
    const allowedSubjects = STRANDS.includes(lessonStrand) ? [normalizedSubject] : [];
    const error = new Error(
      allowedSubjects.length > 0
        ? `subject is invalid for strand ${lessonStrand}.`
        : `subject is invalid for strand ${lessonStrand}.`
    );
    error.statusCode = 400;
    throw error;
  }

  const existingAssessments = await listSupabaseAssessments(teacher._id);
  const duplicateAssessment = existingAssessments.find((item) => (
    String(item.lessonId || '') === String(lessonId)
    && String(item.title || '').trim().toLowerCase() === normalizedTitle.toLowerCase()
    && String(item.examType || '') === String(examType)
  ));
  if (duplicateAssessment) {
    const error = new Error('An assessment with the same title already exists for this lesson');
    error.statusCode = 409;
    throw error;
  }

  const examDurationMinutes = parseExamDurationMinutes(examDurationMinutesRaw, { required: true });
  const submissionDeadline = parseSubmissionDeadline(
    submissionDeadlineRaw ?? deadlineRaw ?? deadlineAtRaw
  );
  if (submissionDeadline && isPastDate(submissionDeadline)) {
    const error = new Error('submissionDeadline must be a future date and time');
    error.statusCode = 400;
    throw error;
  }

  const challengeDescription = String(challengeDescriptionRaw || '').trim();
  const assessmentPolicy = buildAssessmentPolicy({
    assessmentMode,
    examType,
    gradingPeriod,
    assignmentScope,
  });

  if (assessmentPolicy.countsTowardRecommendation) {
    const duplicateGradingAssessment = existingAssessments.find((item) => (
      item.countsTowardRecommendation === true
      && String(item.subjectId || '') === String(lesson.subjectId || '')
      && String(item.gradingPeriod || '') === String(assessmentPolicy.gradingPeriod || '')
    ));
    if (duplicateGradingAssessment) {
      const error = new Error('A grading assessment already exists for this class and grading period');
      error.statusCode = 409;
      throw error;
    }
  }

  const assignedStudentIds = Array.isArray(req.body?.assignedStudentIds) ? req.body.assignedStudentIds : [];

  const assessment = await createSupabaseAssessment({
    lessonId,
    title: normalizedTitle,
    examType,
    subject: normalizedSubject,
    subjectId: lesson.subjectId || null,
    subjectCode: lesson.subjectCode || '',
    subjectCategory: resolveAssessmentSubjectCategory({
      subjectCategory: subjectCategory || getSubjectCategory(normalizedSubject),
      examType,
      title: normalizedTitle,
      lessonTrack: lesson.track,
    }),
    difficulty,
    numberOfItems,
    examDurationMinutes,
    submissionDeadline: submissionDeadline || null,
    challengeDescription,
    assessmentMode: assessmentPolicy.assessmentMode,
    gradingPeriod: assessmentPolicy.gradingPeriod,
    countsTowardRecommendation: assessmentPolicy.countsTowardRecommendation,
    assignmentScope: assessmentPolicy.assignmentScope,
    assignedStudentIds,
    questions: Array.isArray(questions) ? questions : [],
    createdBy: teacher._id,
    publishedBy: req.user._id,
    lastModifiedBy: req.user._id,
  });

  const hydratedAssessment = { ...assessment, lessonId: lesson };

  return sendSuccess(res, 201, 'Assessment created successfully', {
    assessment: headTeacherAssessmentToResponse(hydratedAssessment, teacher),
  });
});

const updateManagedTeacherAssessment = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
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
  } = req.body || {};

  const assessment = await Assessment.findById(id);
  if (!assessment) {
    const error = new Error('Assessment not found');
    error.statusCode = 404;
    throw error;
  }

  const teacher = await findManagedTeacherForHeadTeacher(req, assessment.createdBy, { department });
  const lesson = await Lesson.findById(assessment.lessonId).select('track').lean();

  if (questions !== undefined) {
    if (!Array.isArray(questions)) {
      const error = new Error('questions must be an array');
      error.statusCode = 400;
      throw error;
    }
    assessment.questions = questions;
  }

  const nextPolicy = buildAssessmentPolicy({
    assessmentMode: assessmentMode !== undefined ? assessmentMode : assessment.assessmentMode,
    examType: examType !== undefined ? examType : assessment.examType,
    gradingPeriod: gradingPeriod !== undefined ? gradingPeriod : assessment.gradingPeriod,
    assignmentScope: assignmentScope !== undefined ? assignmentScope : assessment.assignmentScope,
  });

  if (title !== undefined) assessment.title = String(title || '').trim();
  if (examType !== undefined) assessment.examType = String(examType || '').trim();

  if (subject !== undefined) {
    const nextSubject = ensureManagedTeacherSubject(teacher, String(subject || '').trim());
    const lessonStrand = normalizeStrand(lesson?.track);
    if (!isSubjectAllowedForStrand({ strand: lessonStrand, subject: nextSubject })) {
      const error = new Error(`subject is invalid for strand ${lessonStrand}`);
      error.statusCode = 400;
      throw error;
    }

    const subjectRecord = await ensureTeacherSubject({
      teacherId: teacher._id,
      name: nextSubject,
      track: lesson?.track || '',
      subjectCategory: getSubjectCategory(nextSubject),
      department,
    });
    assessment.subject = nextSubject;
    assessment.subjectId = subjectRecord._id;
    assessment.subjectCode = subjectRecord.code;
  }

  if ((!assessment.subjectId || !assessment.subjectCode) && String(assessment.subject || '').trim()) {
    const subjectRecord = await ensureTeacherSubject({
      teacherId: teacher._id,
      name: String(assessment.subject || '').trim(),
      track: lesson?.track || '',
      subjectCategory: getSubjectCategory(assessment.subject),
      department,
    });
    assessment.subjectId = subjectRecord._id;
    assessment.subjectCode = subjectRecord.code;
  }

  if (subjectCategory !== undefined || examType !== undefined || title !== undefined || subject !== undefined) {
    assessment.subjectCategory = resolveAssessmentSubjectCategory({
      subjectCategory: subjectCategory || getSubjectCategory(assessment.subject),
      examType: examType !== undefined ? examType : assessment.examType,
      title: title !== undefined ? title : assessment.title,
      lessonTrack: lesson?.track || '',
    });
  }
  if (difficulty !== undefined) assessment.difficulty = difficulty;
  if (numberOfItems !== undefined) assessment.numberOfItems = numberOfItems;
  assessment.assessmentMode = nextPolicy.assessmentMode;
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
      teacherId: teacher._id,
      subjectId: assessment.subjectId,
      gradingPeriod: nextPolicy.gradingPeriod,
      excludeAssessmentId: assessment._id,
    });
  }

  assessment.assignedStudentIds = await resolveAssignedStudentIds({
    assignmentScope: nextPolicy.assignmentScope,
    teacherId: teacher._id,
    subjectId: assessment.subjectId,
  });
  assessment.lastModifiedBy = req.user._id;
  if (!assessment.publishedBy) assessment.publishedBy = req.user._id;

  await assessment.save();

  const hydratedAssessment = await Assessment.findById(assessment._id)
    .populate('lessonId', 'title track subject subjectId subjectCode')
    .populate('publishedBy', 'name role')
    .populate('lastModifiedBy', 'name role')
    .lean();

  return sendSuccess(res, 200, 'Assessment updated successfully', {
    assessment: headTeacherAssessmentToResponse(hydratedAssessment, teacher),
  });
});

const sendManagedTeacherAnnouncement = asyncHandler(async (req, res) => {
  const department = ensureHeadTeacher(req);
  const teacher = await findManagedTeacherForHeadTeacher(req, req.params.id, { department });
  const subject = String(req.body?.subject || '').trim();
  const content = String(req.body?.content || '').trim();
  const urgent = req.body?.urgent === true;

  if (!subject || !content) {
    const error = new Error('Announcement subject and message are required');
    error.statusCode = 400;
    throw error;
  }
  if (subject.length > 200 || content.length > 5000) {
    const error = new Error('Announcement subject or message is too long');
    error.statusCode = 400;
    throw error;
  }
  if (String(teacher.status || '').trim().toLowerCase() !== 'active') {
    const error = new Error('Announcements can only be sent to active teachers');
    error.statusCode = 400;
    throw error;
  }

  const { notificationRecord } = await createAdminMessageNotification({
    sender: req.user,
    recipient: teacher,
    subject,
    content,
    urgent,
  });

  return sendSuccess(res, 201, 'Announcement sent successfully', {
    notification: {
      id: notificationRecord._id,
      recipientId: notificationRecord.recipientId,
      subject: notificationRecord.subject,
      preview: notificationRecord.preview,
      urgent: notificationRecord.urgent === true,
      createdAt: notificationRecord.createdAt || null,
    },
  });
});

module.exports = {
  getManagedTeachers,
  createTeacherAccount,
  createStudentAccount,
  updateManagedTeacher,
  getManagedTeacherStudents,
  getManagedTeacherLessons,
  createManagedTeacherLesson,
  getManagedTeacherAssessments,
  createManagedTeacherAssessment,
  updateManagedTeacherAssessment,
  sendManagedTeacherAnnouncement,
};
