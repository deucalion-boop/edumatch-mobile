const { readProfileRows } = require('../services/supabaseUserProfileService');
const { listHydratedStudentEnrollments, listStudentEnrollments } = require('../services/supabaseEnrollmentService');
﻿const User = require('../models/User');
const Lesson = require('../models/Lesson');
const Assessment = require('../models/Assessment');
const Submission = require('../models/Submission');
const Recommendation = require('../models/Recommendation');
const Subject = require('../models/Subject');
const SubjectEnrollment = require('../models/SubjectEnrollment');
const { getAppSettings, saveAppSettings } = require('../services/supabaseSettingsService');
const path = require('path');
const fs = require('fs/promises');
const { sendSuccess } = require('../utils/responseHelper');
const { assertPasswordMeetsPolicy } = require('../utils/passwordPolicy');
const {
  ROLE_ADMIN,
  ROLE_SECRETARY,
  ROLE_HEADTEACHER,
  ROLE_TEACHER,
  ROLE_STUDENT,
} = require('../constants/userRoles');
const {
  normalizeContactNumber: normalizeManagedContactNumber,
  normalizeDepartment,
  mapUserResponse: mapManagedUserResponse,
  issueInviteForUser,
  applyRoleScopedFields,
} = require('../services/userManagementService');
const { createAdminMessageNotification } = require('../services/notificationService');
const { countUnreadNotifications } = require('../services/supabaseNotificationService');
const { getSupabaseAnalytics } = require('../services/supabaseAnalyticsService');
const { listLoginAttempts, revokeNonAdminSessions } = require('../services/supabaseAuthPersistenceService');
const { listAuditLogs } = require('../services/supabaseAuditLogService');
const {
  APPROVED_EXPORT_REQUEST_TTL_MINUTES,
  EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
  EXPORT_APPROVAL_STATUS_PENDING,
  EXPORT_APPROVAL_STATUS_APPROVED,
  EXPORT_APPROVAL_STATUS_REJECTED,
  expireExportApprovalRequestIfNeeded,
  getApprovedExportRequestExpiryDate,
  normalizeExportApprovalRequest,
} = require('../services/exportApprovalService');
const {
  countExportApprovalRequests,
  findExportApprovalRequest,
  listExportApprovalRequests,
} = require('../services/supabaseExportApprovalService');
const { formatRecommendationPayload } = require('../services/recommendationService');
const { normalizeGradingPeriod } = require('../constants/assessmentConfig');
const { computeMasteryFromSubmissions } = require('../utils/studentProgress');
const { uploadFile } = require('../services/storageService');
const { resolveStoredFileUrl } = require('../utils/fileStorage');
const {
  createSupabaseAccount,
  findSupabaseAccount,
  findSupabaseAccountByUsername,
  deleteSupabaseAccount,
  findSupabaseAccountByEmail,
  findSupabaseHeadTeacherByDepartment,
  listSupabaseAccounts,
} = require('../services/supabaseAccountService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ALLOWED_STRANDS = ['STEM', 'HUMSS', 'ABM', 'TVL'];
const ALLOWED_STUDENT_GRADE_LEVELS = ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'];
const FIXED_STUDENT_GRADE_LEVEL = 'Grade 10';
const ALLOWED_ACCOUNT_STATUSES = ['pending', 'active', 'inactive', 'suspended'];
const MIN_SESSION_TIMEOUT_MINUTES = 5;
const MAX_SESSION_TIMEOUT_MINUTES = 1440;
const MIN_MAX_LOGIN_ATTEMPTS = 3;
const MAX_MAX_LOGIN_ATTEMPTS = 10;
const MIN_ACCOUNT_LOCKOUT_DURATION_MINUTES = 1;
const MAX_ACCOUNT_LOCKOUT_DURATION_MINUTES = 1440;
const DEFAULT_EMAIL_VERIFICATION_REQUIRED = true;
const DEFAULT_MAINTENANCE_MESSAGE = 'The system is currently under maintenance. Please check back later.';
const DEFAULT_SYSTEM_VERSION = 'v1.0.0';

function buildRecentDayBuckets(dayCount = 30) {
  const buckets = [];
  const now = new Date();

  for (let index = dayCount - 1; index >= 0; index -= 1) {
    const bucketDate = new Date(now);
    bucketDate.setHours(0, 0, 0, 0);
    bucketDate.setDate(bucketDate.getDate() - index);

    buckets.push({
      date: bucketDate,
      key: bucketDate.toISOString().slice(0, 10),
      label: bucketDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }

  return buckets;
}

function roundToOneDecimal(value) {
  return Number(Number(value || 0).toFixed(1));
}

function systemSettingsResponse(settings) {
  return {
    user: {
      emailVerificationRequired: settings?.user?.emailVerificationRequired ?? DEFAULT_EMAIL_VERIFICATION_REQUIRED,
    },
    security: {
      sessionTimeoutMinutes: Number(settings?.security?.sessionTimeoutMinutes || 120),
      maxLoginAttempts: Number(settings?.security?.maxLoginAttempts || 5),
      accountLockoutDurationMinutes: Number(settings?.security?.accountLockoutDurationMinutes || 30),
    },
    maintenance: {
      maintenanceModeEnabled: settings?.maintenance?.maintenanceModeEnabled === true,
      maintenanceMessage:
        String(settings?.maintenance?.maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE).trim() || DEFAULT_MAINTENANCE_MESSAGE,
      systemVersion: String(settings?.maintenance?.systemVersion || DEFAULT_SYSTEM_VERSION).trim() || DEFAULT_SYSTEM_VERSION,
      lastBackupAt: settings?.maintenance?.lastBackupAt || null,
      lastBackupFileName: String(settings?.maintenance?.lastBackupFileName || '').trim(),
      backupHistory: Array.isArray(settings?.maintenance?.backupHistory)
        ? settings.maintenance.backupHistory.map((backup) => ({
          fileName: String(backup?.fileName || '').trim(),
          generatedAt: backup?.generatedAt || null,
          collectionCount: Number(backup?.collectionCount || 0),
          sizeBytes: Number(backup?.sizeBytes || 0),
        }))
        : [],
      lastCacheClearedAt: settings?.maintenance?.lastCacheClearedAt || null,
    },
    updatedAt: settings?.updatedAt || null,
  };
}

function normalizeSystemSettings(input = {}) {
  const userSettings = input?.user || {};
  const securitySettings = input?.security || {};
  const maintenanceSettings = input?.maintenance || {};

  const maintenanceMessage = String(
    maintenanceSettings.maintenanceMessage ?? DEFAULT_MAINTENANCE_MESSAGE
  ).trim();
  if (maintenanceMessage.length > 500) {
    const error = new Error('maintenanceMessage must be 500 characters or fewer');
    error.statusCode = 400;
    throw error;
  }

  const systemVersion = String(maintenanceSettings.systemVersion ?? DEFAULT_SYSTEM_VERSION).trim();
  if (!systemVersion) {
    const error = new Error('systemVersion is required');
    error.statusCode = 400;
    throw error;
  }
  if (systemVersion.length > 50) {
    const error = new Error('systemVersion must be 50 characters or fewer');
    error.statusCode = 400;
    throw error;
  }

  return {
    user: {
      emailVerificationRequired: userSettings.emailVerificationRequired !== false,
    },
    security: {
      sessionTimeoutMinutes: parseBoundedInteger(securitySettings.sessionTimeoutMinutes ?? 120, {
        min: MIN_SESSION_TIMEOUT_MINUTES,
        max: MAX_SESSION_TIMEOUT_MINUTES,
        fieldName: 'sessionTimeoutMinutes',
      }),
      maxLoginAttempts: parseBoundedInteger(securitySettings.maxLoginAttempts ?? 5, {
        min: MIN_MAX_LOGIN_ATTEMPTS,
        max: MAX_MAX_LOGIN_ATTEMPTS,
        fieldName: 'maxLoginAttempts',
      }),
      accountLockoutDurationMinutes: parseBoundedInteger(securitySettings.accountLockoutDurationMinutes ?? 30, {
        min: MIN_ACCOUNT_LOCKOUT_DURATION_MINUTES,
        max: MAX_ACCOUNT_LOCKOUT_DURATION_MINUTES,
        fieldName: 'accountLockoutDurationMinutes',
      }),
    },
    maintenance: {
      maintenanceModeEnabled: maintenanceSettings.maintenanceModeEnabled === true,
      maintenanceMessage: maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE,
      systemVersion,
    },
  };
}

async function clearDirectoryContents(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name);
        await fs.rm(entryPath, { recursive: true, force: true });
      })
    );
    return entries.length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
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

function normalizeStrand(input) {
  return String(input || '').trim().toUpperCase();
}

function normalizeTeacherSubject(input) {
  return String(input || '').trim().replace(/\s+/g, ' ');
}

function normalizeContactNumber(input) {
  return normalizeManagedContactNumber(input);
}

function pctGrowth(current, previous) {
  if (!previous) {
    if (current > 0) return 100;
    if (current < 0) return -100;
    return 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function formatTimeAgo(value) {
  if (!value) return 'Just now';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Just now';

  const diffMs = Date.now() - timestamp.getTime();
  if (diffMs <= 0) return 'Just now';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < minute) return 'Just now';
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  return timestamp.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: timestamp.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function buildRecentActivityEntry({
  id,
  type,
  title,
  description,
  icon,
  occurredAt,
}) {
  return {
    id: `${type}-${id}`,
    type,
    title,
    description,
    icon,
    occurredAt,
    timeAgo: formatTimeAgo(occurredAt),
  };
}

async function getRecentActivities(limit = 10) {
  const perModelLimit = Math.max(limit, 5);

  const [recentUsers, recentLessons, recentAssessments, recentSubmissions] = await Promise.all([
    User.find({})
      .select('name role createdAt')
      .sort({ createdAt: -1 })
      .limit(perModelLimit)
      .lean(),
    Lesson.find({})
      .select('title track subject createdAt')
      .sort({ createdAt: -1 })
      .limit(perModelLimit)
      .lean(),
    Assessment.find({})
      .select('title examType subject difficulty createdAt')
      .sort({ createdAt: -1 })
      .limit(perModelLimit)
      .lean(),
    Submission.find({})
      .select('score totalPoints submittedAt createdAt')
      .populate('studentId', 'name')
      .populate('assessmentId', 'title')
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(perModelLimit)
      .lean(),
  ]);

  const activities = [
    ...recentUsers.map((user) =>
      buildRecentActivityEntry({
        id: user._id,
        type: 'user',
        title: `New ${String(user.role || 'user')} account`,
        description: `${user.name || 'A user'} joined the platform.`,
        icon: 'fas fa-user-plus',
        occurredAt: user.createdAt,
      })
    ),
    ...recentLessons.map((lesson) =>
      buildRecentActivityEntry({
        id: lesson._id,
        type: 'lesson',
        title: 'Lesson published',
        description: `${lesson.title || 'Untitled lesson'} was added to ${lesson.track || lesson.subject || 'the catalog'}.`,
        icon: 'fas fa-book-open',
        occurredAt: lesson.createdAt,
      })
    ),
    ...recentAssessments.map((assessment) =>
      buildRecentActivityEntry({
        id: assessment._id,
        type: 'assessment',
        title: 'Assessment created',
        description: `${assessment.title || 'Untitled assessment'} (${assessment.examType || 'exam'}) is now available.`,
        icon: 'fas fa-file-alt',
        occurredAt: assessment.createdAt,
      })
    ),
    ...recentSubmissions.map((submission) =>
      buildRecentActivityEntry({
        id: submission._id,
        type: 'submission',
        title: 'Assessment submitted',
        description: `${submission.studentId?.name || 'A student'} submitted ${submission.assessmentId?.title || 'an assessment'}.`,
        icon: 'fas fa-paper-plane',
        occurredAt: submission.submittedAt || submission.createdAt,
      })
    ),
  ];

  return activities
    .filter((activity) => activity.occurredAt)
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, limit);
}

function normalizeProfileImageUrl(user, req) {
  const raw = String(user?.profileImage || '').trim();
  if (!raw) return '';
  return resolveStoredFileUrl(req, raw);
}

function mapUserResponse(user, req) {
  return mapManagedUserResponse(user, req);
}

function toObjectIdString(value) {
  return String(value?._id || value || '').trim();
}

function calculateSubmissionPercentage(submission) {
  const score = Number(submission?.score || 0);
  const totalPoints = Number(submission?.totalPoints || 0);
  if (totalPoints <= 0) return 0;
  return roundToOneDecimal((score / totalPoints) * 100);
}

function buildRecommendationSnapshot(studentId, recommendationRow = null) {
  const payload = recommendationRow
    ? formatRecommendationPayload(recommendationRow)
    : formatRecommendationPayload({
      studentId,
      assessmentAttempts: [],
      strandScores: { STEM: 0, HUMSS: 0, ABM: 0, TVL: 0 },
      recommendedStrand: {
        name: null,
        confidence: null,
        generatedAt: null,
        topTwoStrands: [],
      },
      recommendationExplanation: '',
      updatedAt: null,
      lastReason: '',
    });

  return {
    strand: String(payload?.recommendedStrand?.name || '').trim(),
    confidence: String(payload?.recommendedStrand?.confidence || '').trim(),
    explanation: String(recommendationRow?.recommendationExplanation || payload?.recommendationExplanation || '').trim(),
    status: String(payload?.recommendationStatus || 'not_started').trim(),
    updatedAt: payload?.updatedAt || recommendationRow?.updatedAt || null,
  };
}

function getLatestSubmissionsByAssessment(submissions = []) {
  const latestByAssessment = new Map();

  [...submissions]
    .sort((left, right) => {
      const rightTime = new Date(right?.submittedAt || right?.createdAt || 0).getTime();
      const leftTime = new Date(left?.submittedAt || left?.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .forEach((submission) => {
      const assessmentId = toObjectIdString(submission?.assessmentId);
      if (!assessmentId || latestByAssessment.has(assessmentId)) return;
      latestByAssessment.set(assessmentId, submission);
    });

  return [...latestByAssessment.values()];
}

async function buildStudentLearningInsights(student) {
  const studentId = toObjectIdString(student?._id || student?.id);
  const emptyRecommendation = buildRecommendationSnapshot(studentId);
  const emptyLearningSnapshot = {
    totalQuizzes: 0,
    totalActivities: 0,
    latestExamResult: null,
    aiRecommendation: emptyRecommendation,
  };
  if (!studentId) {
    return {
      progressSummary: {
        masteryProgress: 0,
        averageScore: 0,
        completedAssessments: 0,
        completedSubjects: 0,
        completionRate: 0,
        enrolledSubjects: 0,
        pendingSubjects: 0,
        totalLessons: 0,
        totalAssessments: 0,
        lastCalculatedAt: null,
        lastSubmittedAt: null,
      },
      courses: [],
      recentSubmissions: [],
      learningSnapshot: emptyLearningSnapshot,
    };
  }

  const finalizedStatuses = ['completed', 'auto_submitted', 'terminated'];
  const fallbackProgress = student?.enrollment?.progress || {};

  const [approvedEnrollments, pendingSubjects, recommendationRow] = await Promise.all([
    listHydratedStudentEnrollments(studentId, 'approved'),
    listStudentEnrollments(studentId, 'pending').then((rows) => rows.length),
    readProfileRows('recommendations', 'student_id', studentId).then((rows) => rows[0] || null),
  ]);
  const recommendationSnapshot = buildRecommendationSnapshot(studentId, recommendationRow);

  const subjectIds = [...new Set(
    approvedEnrollments
      .map((row) => toObjectIdString(row?.subjectId?._id || row?.subjectId))
      .filter(Boolean)
  )];

  if (subjectIds.length === 0) {
    return {
      progressSummary: {
        masteryProgress: Number(fallbackProgress.masteryProgress || 0),
        averageScore: Number(fallbackProgress.averageScore || 0),
        completedAssessments: Number(fallbackProgress.completedAssessments || 0),
        completedSubjects: 0,
        completionRate: 0,
        enrolledSubjects: 0,
        pendingSubjects: Number(pendingSubjects || 0),
        totalLessons: 0,
        totalAssessments: 0,
        lastCalculatedAt: fallbackProgress.lastCalculatedAt || null,
        lastSubmittedAt: null,
      },
      courses: [],
      recentSubmissions: [],
      learningSnapshot: {
        ...emptyLearningSnapshot,
        aiRecommendation: recommendationSnapshot,
      },
    };
  }

  const [lessons, assessments] = await Promise.all([
    readProfileRows('lessons', 'subject_id', subjectIds),
    readProfileRows('assessments', 'subject_id', subjectIds),
  ]);

  const eligibleAssessments = assessments.filter((assessment) => {
    const assignedStudentIds = Array.isArray(assessment?.assignedStudentIds)
      ? assessment.assignedStudentIds
        .map((value) => toObjectIdString(value))
        .filter(Boolean)
      : [];

    return assignedStudentIds.length === 0 || assignedStudentIds.includes(studentId);
  });

  const assessmentIds = eligibleAssessments.map((assessment) => assessment._id);
  const submissions = assessmentIds.length > 0
    ? (await readProfileRows('submissions', 'student_id', studentId))
      .filter((row) => assessmentIds.includes(row.assessmentId) && finalizedStatuses.includes(row.status))
      .map((row) => ({ ...row, assessmentId: eligibleAssessments.find((assessment) => assessment._id === row.assessmentId) }))
    : [];

  const latestSubmissions = getLatestSubmissionsByAssessment(submissions);
  const computedMastery = computeMasteryFromSubmissions(latestSubmissions);
  const hasComputedSubmissions = latestSubmissions.length > 0;
  const totalQuizzes = eligibleAssessments.filter(
    (assessment) => String(assessment?.assessmentMode || '').trim().toLowerCase() === 'quiz'
  ).length;
  const totalActivities = eligibleAssessments.filter(
    (assessment) => String(assessment?.assessmentMode || '').trim().toLowerCase() === 'activity'
  ).length;

  const lessonCountsBySubject = new Map();
  lessons.forEach((lesson) => {
    const subjectId = toObjectIdString(lesson?.subjectId);
    if (!subjectId) return;
    lessonCountsBySubject.set(subjectId, Number(lessonCountsBySubject.get(subjectId) || 0) + 1);
  });

  const assessmentCountsBySubject = new Map();
  eligibleAssessments.forEach((assessment) => {
    const subjectId = toObjectIdString(assessment?.subjectId);
    if (!subjectId) return;
    assessmentCountsBySubject.set(subjectId, Number(assessmentCountsBySubject.get(subjectId) || 0) + 1);
  });

  const submissionsBySubject = new Map();
  latestSubmissions.forEach((submission) => {
    const subjectId = toObjectIdString(submission?.assessmentId?.subjectId);
    if (!subjectId) return;
    const rows = submissionsBySubject.get(subjectId) || [];
    rows.push(submission);
    submissionsBySubject.set(subjectId, rows);
  });

  const courses = approvedEnrollments
    .map((row) => {
      const subject = row?.subjectId || {};
      const teacher = row?.teacherId || {};
      const subjectId = toObjectIdString(subject?._id || subject);
      if (!subjectId) return null;

      const lessonCount = Number(lessonCountsBySubject.get(subjectId) || 0);
      const assessmentCount = Number(assessmentCountsBySubject.get(subjectId) || 0);
      const subjectSubmissions = submissionsBySubject.get(subjectId) || [];
      const completedAssessments = subjectSubmissions.length;
      const averageScore = completedAssessments > 0
        ? roundToOneDecimal(
          subjectSubmissions.reduce((sum, submission) => sum + calculateSubmissionPercentage(submission), 0)
            / completedAssessments
        )
        : 0;
      const progress = assessmentCount > 0
        ? roundToOneDecimal((completedAssessments / assessmentCount) * 100)
        : 0;
      const lastSubmittedAt = subjectSubmissions
        .map((submission) => submission?.submittedAt || submission?.createdAt || null)
        .filter(Boolean)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
      const titleBase = String(subject?.name || 'Subject').trim() || 'Subject';
      const className = String(subject?.className || '').trim();

      return {
        id: subjectId,
        title: className ? `${titleBase} (${className})` : titleBase,
        name: titleBase,
        code: String(subject?.code || '').trim(),
        className,
        track: String(subject?.track || '').trim(),
        teacherName: String(teacher?.name || '').trim(),
        teacherEmail: String(teacher?.email || '').trim(),
        lessonCount,
        assessmentCount,
        completedAssessments,
        averageScore,
        progress,
        lastSubmittedAt,
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left?.title || '').localeCompare(String(right?.title || '')));

  const completedSubjects = courses.filter(
    (course) => Number(course?.assessmentCount || 0) > 0
      && Number(course?.completedAssessments || 0) >= Number(course?.assessmentCount || 0)
  ).length;

  const recentSubmissions = latestSubmissions
    .sort((left, right) => {
      const rightTime = new Date(right?.submittedAt || right?.createdAt || 0).getTime();
      const leftTime = new Date(left?.submittedAt || left?.createdAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 5)
    .map((submission) => {
      const subjectId = toObjectIdString(submission?.assessmentId?.subjectId);
      const matchedCourse = courses.find((course) => String(course?.id || '') === subjectId) || null;

      return {
        id: toObjectIdString(submission?._id),
        title: String(submission?.assessmentId?.title || 'Assessment').trim() || 'Assessment',
        subjectTitle: matchedCourse?.title || 'Subject',
        examType: String(submission?.assessmentId?.examType || '').trim(),
        score: Number(submission?.score || 0),
        totalPoints: Number(submission?.totalPoints || 0),
        percentage: calculateSubmissionPercentage(submission),
        status: String(submission?.status || 'completed').trim() || 'completed',
        submittedAt: submission?.submittedAt || submission?.createdAt || null,
      };
    });
  const latestExamSubmission = [...latestSubmissions]
    .filter((submission) => (
      String(submission?.assessmentId?.assessmentMode || '').trim().toLowerCase() === 'grading_assessment'
      && Boolean(normalizeGradingPeriod(submission?.assessmentId?.gradingPeriod))
    ))
    .sort((left, right) => {
      const rightTime = new Date(right?.submittedAt || right?.createdAt || 0).getTime();
      const leftTime = new Date(left?.submittedAt || left?.createdAt || 0).getTime();
      return rightTime - leftTime;
    })[0] || null;

  const computedCompletedAssessments = hasComputedSubmissions
    ? Number(computedMastery.completedAssessments || 0)
    : Number(fallbackProgress.completedAssessments || 0);
  const totalAssessments = eligibleAssessments.length;
  const completionRate = totalAssessments > 0
    ? roundToOneDecimal((computedCompletedAssessments / totalAssessments) * 100)
    : 0;

  return {
    progressSummary: {
      masteryProgress: hasComputedSubmissions
        ? Number(computedMastery.masteryProgress || 0)
        : Number(fallbackProgress.masteryProgress || 0),
      averageScore: hasComputedSubmissions
        ? Number(computedMastery.averageScore || 0)
        : Number(fallbackProgress.averageScore || 0),
      completedAssessments: computedCompletedAssessments,
      completedSubjects,
      completionRate,
      enrolledSubjects: courses.length,
      pendingSubjects: Number(pendingSubjects || 0),
      totalLessons: lessons.length,
      totalAssessments,
      lastCalculatedAt: hasComputedSubmissions
        ? computedMastery.lastCalculatedAt
        : (fallbackProgress.lastCalculatedAt || null),
      lastSubmittedAt: recentSubmissions[0]?.submittedAt || null,
    },
    courses,
    recentSubmissions,
    learningSnapshot: {
      totalQuizzes,
      totalActivities,
      latestExamResult: latestExamSubmission
        ? {
          title: String(latestExamSubmission?.assessmentId?.title || 'Exam').trim() || 'Exam',
          gradingPeriod: normalizeGradingPeriod(latestExamSubmission?.assessmentId?.gradingPeriod),
          score: Number(latestExamSubmission?.score || 0),
          totalPoints: Number(latestExamSubmission?.totalPoints || 0),
          percentage: calculateSubmissionPercentage(latestExamSubmission),
          submittedAt: latestExamSubmission?.submittedAt || latestExamSubmission?.createdAt || null,
        }
        : null,
      aiRecommendation: recommendationSnapshot,
    },
  };
}

function parseBoundedInteger(value, { min, max, fieldName }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    const error = new Error(`${fieldName} must be an integer`);
    error.statusCode = 400;
    throw error;
  }
  if (parsed < min || parsed > max) {
    const error = new Error(`${fieldName} must be between ${min} and ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseBoundedNumber(value, { min, max, fieldName, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    const error = new Error(`${fieldName} must be a number`);
    error.statusCode = 400;
    throw error;
  }
  if (parsed < min || parsed > max) {
    const error = new Error(`${fieldName} must be between ${min} and ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

const ADMIN_MANAGED_ROLES = [ROLE_SECRETARY, ROLE_HEADTEACHER, ROLE_TEACHER, ROLE_STUDENT];
const SECRETARY_MANAGED_ROLES = [ROLE_HEADTEACHER, ROLE_TEACHER, ROLE_STUDENT];

function ensureAdminManagedRole(role) {
  if (!ADMIN_MANAGED_ROLES.includes(role)) {
    const error = new Error('Administrators can only manage Secretary, Head Teacher, Teacher, and Student accounts');
    error.statusCode = 403;
    throw error;
  }
}

function ensureUserManagementPermission(req, role) {
  const actorRole = String(req?.user?.role || '').trim().toLowerCase();
  const allowedRoles = actorRole === ROLE_SECRETARY ? SECRETARY_MANAGED_ROLES : ADMIN_MANAGED_ROLES;
  if (![ROLE_ADMIN, ROLE_SECRETARY].includes(actorRole) || !allowedRoles.includes(role)) {
    const error = new Error('Forbidden: you cannot manage accounts with this role');
    error.statusCode = 403;
    throw error;
  }
}

function normalizeStudentFields({ role, strand, gradeLevel }) {
  if (role !== ROLE_STUDENT) return { strand: '', gradeLevel: '' };
  const normalizedStrand = String(strand || '').trim().toUpperCase();
  const normalizedGradeLevel = String(gradeLevel || FIXED_STUDENT_GRADE_LEVEL).trim();
  if (normalizedStrand && !ALLOWED_STRANDS.includes(normalizedStrand)) {
    const error = new Error(`strand must be one of: ${ALLOWED_STRANDS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  if (!ALLOWED_STUDENT_GRADE_LEVELS.includes(normalizedGradeLevel)) {
    const error = new Error(`gradeLevel must be one of: ${ALLOWED_STUDENT_GRADE_LEVELS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return { strand: normalizedStrand, gradeLevel: normalizedGradeLevel };
}

function normalizeAdminManagedRole(roleInput) {
  const normalized = String(roleInput || '').trim().toLowerCase();
  if (normalized === 'head_teacher') return ROLE_HEADTEACHER;
  return normalized;
}

async function ensureSingleHeadTeacherPerDepartment({ role, department, excludeUserId = null }) {
  if (role !== ROLE_HEADTEACHER) return;
  const normalizedDepartment = String(department || '').trim();
  if (!normalizedDepartment) return;

  const existingHeadTeacher = await findSupabaseHeadTeacherByDepartment(normalizedDepartment);
  if (existingHeadTeacher && String(existingHeadTeacher._id) !== String(excludeUserId || '')) {
    const error = new Error('This department already has a Head Teacher assigned');
    error.statusCode = 409;
    throw error;
  }
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLoginAttemptResponse(entry) {
  return {
    id: String(entry?._id || ''),
    userId: entry?.userId ? String(entry.userId) : '',
    username: String(entry?.username || '').trim(),
    name: String(entry?.name || '').trim(),
    email: String(entry?.email || '').trim(),
    role: String(entry?.role || '').trim(),
    outcome: String(entry?.outcome || 'failed').trim(),
    reason: String(entry?.reason || '').trim(),
    ipAddress: String(entry?.ipAddress || '').trim(),
    userAgent: String(entry?.userAgent || '').trim(),
    createdAt: entry?.createdAt || null,
    updatedAt: entry?.updatedAt || null,
  };
}

function normalizeAuditLogResponse(entry) {
  return {
    id: String(entry?._id || ''),
    actorUserId: entry?.actorUserId ? String(entry.actorUserId) : '',
    actorName: String(entry?.actorName || '').trim(),
    actorEmail: String(entry?.actorEmail || '').trim(),
    actorRole: String(entry?.actorRole || '').trim(),
    actorIdentifier: String(entry?.actorIdentifier || '').trim(),
    category: String(entry?.category || 'System').trim(),
    actionLabel: String(entry?.actionLabel || '').trim(),
    method: String(entry?.method || '').trim(),
    endpoint: String(entry?.endpoint || '').trim(),
    routePath: String(entry?.routePath || '').trim(),
    targetId: String(entry?.targetId || '').trim(),
    targetLabel: String(entry?.targetLabel || '').trim(),
    succeeded: entry?.succeeded === true,
    statusCode: Number(entry?.statusCode || 0),
    ipAddress: String(entry?.ipAddress || '').trim(),
    userAgent: String(entry?.userAgent || '').trim(),
    durationMs: Number(entry?.durationMs || 0),
    metadata: entry?.metadata || {},
    createdAt: entry?.createdAt || null,
    updatedAt: entry?.updatedAt || null,
  };
}

const getLoginAttempts = asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const normalizedOutcome = String(req.query.status || '').trim().toLowerCase();
  const normalizedRole = String(req.query.role || '').trim().toLowerCase();
  const requestedPage = Number.parseInt(req.query.page, 10);
  const limit = 50;
  const allowedRoles = new Set([ROLE_ADMIN, ROLE_SECRETARY, ROLE_HEADTEACHER, ROLE_TEACHER, ROLE_STUDENT]);
  const outcome = normalizedOutcome === 'success' || normalizedOutcome === 'failed' ? normalizedOutcome : '';
  const role = allowedRoles.has(normalizedRole) ? normalizedRole : '';
  const result = await listLoginAttempts({
    search,
    outcome,
    role,
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
    pageSize: limit,
  });

  return sendSuccess(res, 200, 'Login attempts fetched successfully', {
    attempts: result.attempts.map((entry) => normalizeLoginAttemptResponse(entry)),
    summary: result.summary,
    filters: {
      search,
      status: normalizedOutcome || 'all',
      role: normalizedRole || 'all',
      page: result.pagination.page,
      pageSize: limit,
    },
    pagination: result.pagination,
  });
});

const getAuditLogs = asyncHandler(async (req, res) => {
  const search = String(req.query.search || '').trim();
  const category = String(req.query.category || '').trim();
  const role = String(req.query.role || '').trim().toLowerCase();
  const method = String(req.query.method || '').trim().toUpperCase();
  const result = String(req.query.result || '').trim().toLowerCase();
  const requestedPage = Number.parseInt(req.query.page, 10);
  const limit = 50;
  const succeeded = result === 'success' ? true : (result === 'failed' ? false : null);
  const auditResult = await listAuditLogs({
    search,
    category: category && category.toLowerCase() !== 'all' ? category : '',
    role: role && role !== 'all' ? role : '',
    method: method && method !== 'ALL' ? method : '',
    succeeded,
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
    pageSize: limit,
  });

  return sendSuccess(res, 200, 'Audit logs fetched successfully', {
    logs: auditResult.logs.map((entry) => normalizeAuditLogResponse(entry)),
    summary: auditResult.summary,
    categories: auditResult.categories
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
    filters: {
      search,
      category: category || 'all',
      role: role || 'all',
      method: method || 'ALL',
      result: result || 'all',
      page: auditResult.pagination.page,
      pageSize: limit,
    },
    pagination: auditResult.pagination,
  });
});

const createAndInviteUser = asyncHandler(async (req, res) => {
  const { name, email, username, role, contactNumber, department, subject, strand, gradeLevel } = req.body || {};

  if (!name || !email || !username || !role) {
    const error = new Error('name, email, username, and role are required');
    error.statusCode = 400;
    throw error;
  }

  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedUsername = String(username).trim();
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

  const normalizedRole = normalizeAdminManagedRole(role);
  ensureAdminManagedRole(normalizedRole);
  ensureUserManagementPermission(req, normalizedRole);
  const normalizedContactNumber = normalizeContactNumber(contactNumber);
  const scopedFields = applyRoleScopedFields({ role: normalizedRole, department, subject });
  const studentFields = normalizeStudentFields({ role: normalizedRole, strand, gradeLevel });
  await ensureSingleHeadTeacherPerDepartment({
    role: normalizedRole,
    department: scopedFields.department,
  });

  const created = await createSupabaseAccount({
    name: String(name).trim(),
    email: normalizedEmail,
    username: normalizedUsername,
    role: normalizedRole,
    status: 'active',
    strand: studentFields.strand,
    subject: scopedFields.subject,
    department: scopedFields.department,
    gradeLevel: studentFields.gradeLevel,
    managedBy: req.user._id,
    contactNumber: normalizedContactNumber,
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

  return sendSuccess(res, 201, 'User created and onboarding email sent successfully', {
    user: {
      id: created._id,
      name: created.name,
      email: created.email,
      username: created.username || '',
      role: created.role,
      status: created.status,
      department: created.department || '',
      contactNumber: created.contactNumber || '',
      inviteExpiresAt: inviteResult.inviteExpiresAt || null,
      inviteSentAt: inviteResult.inviteSentAt || null,
      createdAt: created.createdAt || null,
    },
    invite: inviteResult,
  });
});

const createUser = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    username,
    role,
    status,
    contactNumber,
    department,
    subject,
    strand,
    gradeLevel,
  } = req.body;

  if (!name || !email || !username || !role) {
    const error = new Error('name, email, username, and role are required');
    error.statusCode = 400;
    throw error;
  }

  const existing = await findSupabaseAccountByEmail(String(email).toLowerCase().trim());
  if (existing) {
    const error = new Error('Email already exists');
    error.statusCode = 409;
    throw error;
  }

  const normalizedRole = normalizeAdminManagedRole(role);
  ensureAdminManagedRole(normalizedRole);
  ensureUserManagementPermission(req, normalizedRole);
  const normalizedUsername = String(username).trim();
  const normalizedContactNumber = normalizeContactNumber(contactNumber);
  const scopedFields = applyRoleScopedFields({ role: normalizedRole, department, subject });
  const studentFields = normalizeStudentFields({ role: normalizedRole, strand, gradeLevel });
  await ensureSingleHeadTeacherPerDepartment({
    role: normalizedRole,
    department: scopedFields.department,
  });
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedUsername.length > 50) {
    const error = new Error('username must be 50 characters or fewer');
    error.statusCode = 400;
    throw error;
  }
  if (normalizedStatus && !ALLOWED_ACCOUNT_STATUSES.includes(normalizedStatus)) {
    const error = new Error(`status must be one of: ${ALLOWED_ACCOUNT_STATUSES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  const resolvedStatus = normalizedStatus || 'active';

  let created;
  try {
    created = await createSupabaseAccount({
      name,
      email,
      username: normalizedUsername,
      role: normalizedRole,
      status: resolvedStatus,
      strand: studentFields.strand,
      subject: scopedFields.subject,
      department: scopedFields.department,
      gradeLevel: studentFields.gradeLevel,
      managedBy: req.user._id,
      contactNumber: normalizedContactNumber,
      invite: {
        tokenHash: '',
        expiresAt: null,
        sentAt: null,
        usedAt: null,
      },
    });
  } catch (saveError) {
    console.error('[createUser] save failed:', {
      message: saveError.message,
      name: saveError.name,
      code: saveError.code,
      errors: saveError.errors,
      stack: saveError.stack,
    });
    throw saveError;
  }

  const inviteResult = await issueInviteForUser({
    user: created,
    req,
  });

  return sendSuccess(res, 201, 'User created successfully', {
    user: {
      id: created._id,
      name: created.name,
      email: created.email,
      username: created.username || '',
      role: created.role,
      status: created.status,
      department: created.department || '',
      subject: created.subject || '',
      strand: created.strand || '',
      gradeLevel: created.gradeLevel || '',
      contactNumber: created.contactNumber || '',
      inviteExpiresAt: created?.invite?.expiresAt || null,
      inviteSentAt: created?.invite?.sentAt || null,
      inviteUsedAt: created?.invite?.usedAt || null,
      createdAt: created.createdAt,
    },
    invite: inviteResult,
  });
});

const sendUserInvite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { expiresInHours } = req.body || {};

  const user = await findSupabaseAccount('id', id);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }
  ensureUserManagementPermission(req, normalizeAdminManagedRole(user.role));
  const inviteResult = await issueInviteForUser({
    user,
    req,
  });

  return sendSuccess(res, 200, 'Onboarding email sent successfully', {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      inviteExpiresAt: user?.invite?.expiresAt || null,
      inviteSentAt: user?.invite?.sentAt || null,
      inviteUsedAt: user?.invite?.usedAt || null,
    },
    invite: inviteResult,
  });
});

const getUsers = asyncHandler(async (req, res) => {
  const users = await listSupabaseAccounts();
  const dedupedUsers = uniqueBy(users, (user) => String(user?._id || '').trim() || String(user?.email || '').trim().toLowerCase());

  return sendSuccess(res, 200, 'Users fetched successfully', {
    users: dedupedUsers.map((user) => {
      const mapped = mapUserResponse(user, req);
      if (String(user?.role || '') === ROLE_TEACHER) {
        mapped.lessonsCreated = 0;
      }
      if (String(user?.role || '') === ROLE_STUDENT) {
        const progress = user?.enrollment?.progress || {};
        mapped.progress = {
          masteryProgress: Number(progress?.masteryProgress || 0),
          averageScore: Number(progress?.averageScore || 0),
          completedAssessments: Number(progress?.completedAssessments || 0),
          lastCalculatedAt: progress?.lastCalculatedAt || null,
        };
        mapped.completionRate = Number(progress?.masteryProgress || 0);
        mapped.lessonsCompleted = Number(progress?.completedAssessments || 0);
      }
      return mapped;
    }),
  });
});

const getUserById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await findSupabaseAccount('id', id);

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  if (user.managedBy) {
    const manager = await findSupabaseAccount('id', user.managedBy);
    if (manager) user.managedBy = { _id: manager._id, name: manager.name, email: manager.email };
  }
  const responseUser = mapUserResponse(user, req);

  if (user.role === 'teacher') {
    const approvedEnrollmentStatuses = ['approved', 'accepted'];
    const [lessons, accounts] = await Promise.all([
      readProfileRows('lessons', 'created_by', user._id), listSupabaseAccounts(),
    ]);
    const lessonsCreated = lessons.length;
    const students = accounts.filter((account) => account.role === 'student'
      && String(account.enrollment?.teacherId || '') === String(user._id)
      && approvedEnrollmentStatuses.includes(account.enrollment?.status)).length;

    responseUser.lessonsCreated = lessonsCreated;
    responseUser.students = students;
  }

  if (user.role === ROLE_STUDENT) {
    const learningInsights = await buildStudentLearningInsights(user);
    responseUser.progress = {
      masteryProgress: Number(learningInsights.progressSummary.masteryProgress || 0),
      averageScore: Number(learningInsights.progressSummary.averageScore || 0),
      completedAssessments: Number(learningInsights.progressSummary.completedAssessments || 0),
      lastCalculatedAt: learningInsights.progressSummary.lastCalculatedAt || null,
    };
    responseUser.progressSummary = learningInsights.progressSummary;
    responseUser.enrolledCourses = Number(learningInsights.progressSummary.enrolledSubjects || 0);
    responseUser.coursesCompleted = Number(learningInsights.progressSummary.completedSubjects || 0);
    responseUser.lessonsCompleted = Number(learningInsights.progressSummary.completedAssessments || 0);
    responseUser.completionRate = Number(learningInsights.progressSummary.completionRate || 0);
    responseUser.courses = learningInsights.courses;
    responseUser.recentSubmissions = learningInsights.recentSubmissions;
    responseUser.learningSnapshot = learningInsights.learningSnapshot;
  }

  return sendSuccess(res, 200, 'User fetched successfully', { user: responseUser });
});

const updateUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, username, password, role, status, subject, contactNumber, department, strand, gradeLevel } = req.body;

  const user = await findSupabaseAccount('id', id);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }
  ensureUserManagementPermission(req, normalizeAdminManagedRole(user.role));

  if (email && String(email).toLowerCase().trim() !== user.email) {
    const emailExists = await findSupabaseAccountByEmail(email);
    if (emailExists && String(emailExists._id) !== String(id)) {
      const error = new Error('Email already exists');
      error.statusCode = 409;
      throw error;
    }
  }
  const emailChanged = email !== undefined && String(email).toLowerCase().trim() !== user.email;

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = String(email).toLowerCase().trim();
  if (username !== undefined) {
    const normalizedUsername = String(username).trim();
    if (!normalizedUsername || normalizedUsername.length > 50) {
      const error = new Error('Username must be between 1 and 50 characters');
      error.statusCode = 400;
      throw error;
    }
    const usernameExists = await findSupabaseAccountByUsername(normalizedUsername);
    if (usernameExists && String(usernameExists._id) !== String(id)) {
      const error = new Error('Username already exists');
      error.statusCode = 409;
      throw error;
    }
    user.username = normalizedUsername;
  }
  if (password !== undefined && String(password).trim()) {
    const normalizedPassword = String(password).trim();
    assertPasswordMeetsPolicy(normalizedPassword);
    user.password = normalizedPassword;
    user.forcePasswordChange = false;
    user.temporaryPasswordIssuedAt = null;
  }
  if (role !== undefined) {
    const normalizedRole = normalizeAdminManagedRole(role);
    ensureAdminManagedRole(normalizedRole);
    ensureUserManagementPermission(req, normalizedRole);
    user.role = normalizedRole;
  }
  if (status !== undefined) user.status = status;
  if (contactNumber !== undefined) user.contactNumber = normalizeContactNumber(contactNumber);
  if (department !== undefined || role !== undefined || subject !== undefined) {
    const scopedFields = applyRoleScopedFields({
      role: user.role,
      department: department !== undefined ? department : user.department,
      subject: subject !== undefined ? subject : user.subject,
    });
    await ensureSingleHeadTeacherPerDepartment({
      role: user.role,
      department: scopedFields.department,
      excludeUserId: user._id,
    });
    user.department = scopedFields.department;
    user.subject = scopedFields.subject;
  }
  if (strand !== undefined || gradeLevel !== undefined || role !== undefined) {
    const studentFields = normalizeStudentFields({
      role: user.role,
      strand: strand !== undefined ? strand : user.strand,
      gradeLevel: gradeLevel !== undefined ? gradeLevel : user.gradeLevel,
    });
    user.strand = studentFields.strand;
    user.gradeLevel = studentFields.gradeLevel;
  }

  if (req.file) {
    const uploadedProfile = await uploadFile({
      file: req.file,
      folder: `profile-images/admin-managed/${String(user?._id || 'unknown')}`,
    });
    user.profileImage = uploadedProfile.storedPath;
  }

  if (emailChanged && user?.invite?.tokenHash) {
    user.invite.tokenHash = '';
    user.invite.expiresAt = null;
    user.invite.sentAt = null;
    user.invite.usedAt = null;
  }

  await user.save();

  return sendSuccess(res, 200, 'User updated successfully', {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      username: user.username || '',
      role: user.role,
      status: user.status,
      strand: user.strand,
      subject: user.subject || '',
      department: user.department || '',
      gradeLevel: user.gradeLevel || '',
      contactNumber: user.contactNumber || '',
      profileImage: normalizeProfileImageUrl(user, req),
      avatar: normalizeProfileImageUrl(user, req),
      updatedAt: user.updatedAt,
    },
  });
});

const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const currentPassword = String(req.body?.currentPassword || '').trim();

  if (!currentPassword) {
    const error = new Error('Current password is required to delete a user');
    error.statusCode = 400;
    throw error;
  }

  const actingUser = await findSupabaseAccount('id', req.user._id);
  if (!actingUser) {
    const error = new Error('Acting account not found');
    error.statusCode = 401;
    throw error;
  }

  const passwordMatched = await actingUser.comparePassword(currentPassword);
  if (!passwordMatched) {
    const error = new Error('Incorrect current password');
    error.statusCode = 401;
    throw error;
  }

  const user = await findSupabaseAccount('id', id);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }
  ensureUserManagementPermission(req, normalizeAdminManagedRole(user.role));

  if (String(user._id) === String(req.user._id)) {
    const error = new Error('You cannot delete your own account');
    error.statusCode = 400;
    throw error;
  }

  await deleteSupabaseAccount(user._id);
  return sendSuccess(res, 200, 'User deleted successfully');
});

const getSecuritySettings = asyncHandler(async (_req, res) => {
  const settings = await getAppSettings();
  const systemSettings = systemSettingsResponse(settings);

  return sendSuccess(res, 200, 'Security settings fetched successfully', {
    settings: systemSettings.security,
    updatedAt: systemSettings.updatedAt,
  });
});

const saveSecuritySettings = asyncHandler(async (req, res) => {
  const { sessionTimeoutMinutes, maxLoginAttempts, accountLockoutDurationMinutes } = req.body || {};

  const parsedSessionTimeoutMinutes = parseBoundedInteger(sessionTimeoutMinutes, {
    min: MIN_SESSION_TIMEOUT_MINUTES,
    max: MAX_SESSION_TIMEOUT_MINUTES,
    fieldName: 'sessionTimeoutMinutes',
  });
  const parsedMaxLoginAttempts = parseBoundedInteger(maxLoginAttempts, {
    min: MIN_MAX_LOGIN_ATTEMPTS,
    max: MAX_MAX_LOGIN_ATTEMPTS,
    fieldName: 'maxLoginAttempts',
  });
  const parsedAccountLockoutDurationMinutes = parseBoundedInteger(accountLockoutDurationMinutes, {
    min: MIN_ACCOUNT_LOCKOUT_DURATION_MINUTES,
    max: MAX_ACCOUNT_LOCKOUT_DURATION_MINUTES,
    fieldName: 'accountLockoutDurationMinutes',
  });

  const settings = await saveAppSettings({
    security: {
      sessionTimeoutMinutes: parsedSessionTimeoutMinutes,
      maxLoginAttempts: parsedMaxLoginAttempts,
      accountLockoutDurationMinutes: parsedAccountLockoutDurationMinutes,
    },
  }, req.user._id);

  return sendSuccess(res, 200, 'Security settings saved successfully', {
    settings: {
      sessionTimeoutMinutes: settings.security.sessionTimeoutMinutes,
      maxLoginAttempts: settings.security.maxLoginAttempts,
      accountLockoutDurationMinutes: settings.security.accountLockoutDurationMinutes,
      updatedAt: settings.updatedAt,
    },
  });
});

const getSystemSettings = asyncHandler(async (_req, res) => {
  const settings = await getAppSettings();

  return sendSuccess(res, 200, 'System settings fetched successfully', {
    settings: systemSettingsResponse(settings),
  });
});

const saveSystemSettings = asyncHandler(async (req, res) => {
  const normalizedSettings = normalizeSystemSettings(req.body || {});
  const settings = await saveAppSettings(normalizedSettings, req.user._id);

  let sessionsInvalidated = 0;
  if (normalizedSettings.maintenance.maintenanceModeEnabled) {
    sessionsInvalidated = await revokeNonAdminSessions('System maintenance');
  }

  return sendSuccess(res, 200, 'System settings saved successfully', {
    settings: systemSettingsResponse(settings),
    maintenance: {
      sessionsInvalidated,
    },
  });
});

const clearSystemCache = asyncHandler(async (req, res) => {
  const cacheDirectories = [
    path.resolve(__dirname, '..', 'cache'),
    path.resolve(__dirname, '..', 'temp'),
    path.resolve(__dirname, '..', 'tmp'),
  ];

  const clearedEntries = await Promise.all(cacheDirectories.map((dirPath) => clearDirectoryContents(dirPath)));
  const sessionsInvalidated = await revokeNonAdminSessions('System cache cleared');
  const clearedAt = new Date();

  await saveAppSettings({ maintenance: { lastCacheClearedAt: clearedAt.toISOString() } }, req.user._id);

  return sendSuccess(res, 200, 'System cache cleared successfully', {
    cache: {
      clearedAt,
      directoriesChecked: cacheDirectories.length,
      filesRemoved: clearedEntries.reduce((sum, count) => sum + count, 0),
      sessionsInvalidated,
    },
  });
});

const getRawSettingsDebug = asyncHandler(async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('This debug endpoint is disabled in production');
    error.statusCode = 403;
    throw error;
  }

  const settings = await getAppSettings();

  return sendSuccess(res, 200, 'Raw settings fetched (debug)', {
    settings: settings || null,
  });
});

const getLegacyMongoAnalytics = asyncHandler(async (_req, res) => {
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - 30);
  const previousPeriodStart = new Date(periodStart);
  previousPeriodStart.setDate(previousPeriodStart.getDate() - 30);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  const previousWeekStart = new Date(weekStart);
  previousWeekStart.setDate(previousWeekStart.getDate() - 7);
  const trendBuckets = buildRecentDayBuckets(30);
  const trendStart = trendBuckets[0]?.date || periodStart;
  const activeAccountFilter = { status: 'active' };
  const inactiveAccountFilter = { status: 'inactive' };

  const [
    totalUsers,
    totalStudents,
    totalTeachers,
    totalHeadTeachers,
    totalSecretaries,
    totalLessons,
    totalAssessments,
    totalSubmissions,
    totalSubjects,
    totalEnrollments,
    trackGroups,
    currentStudentsActivated,
    currentStudentsDeactivated,
    previousStudentsActivated,
    previousStudentsDeactivated,
    currentTeachersActivated,
    currentTeachersDeactivated,
    previousTeachersActivated,
    previousTeachersDeactivated,
    currentHeadTeachersActivated,
    currentHeadTeachersDeactivated,
    previousHeadTeachersActivated,
    previousHeadTeachersDeactivated,
    currentSecretariesActivated,
    currentSecretariesDeactivated,
    previousSecretariesActivated,
    previousSecretariesDeactivated,
    currentUsersActivated,
    currentUsersDeactivated,
    previousUsersActivated,
    previousUsersDeactivated,
    currentLessons,
    previousLessons,
    currentAssessments,
    currentSubmissions,
    previousSubmissions,
    pendingApplications,
    pendingEnrollmentRequests,
    examTypeAggregation,
    difficultyAggregation,
    roleTrendAggregation,
    trackPerformanceAggregation,
    subjectLessonAggregation,
    subjectSubmissionAggregation,
    aiDifficultyPerformanceAggregation,
    attemptedAssessmentIds,
    studentUsers,
    teacherUsers,
    headTeacherUsers,
    secretaryUsers,
    lessonDetails,
    assessmentDetails,
    recentActivities,
  ] = await Promise.all([
    User.countDocuments(activeAccountFilter),
    User.countDocuments({ role: ROLE_STUDENT, ...activeAccountFilter }),
    User.countDocuments({ role: ROLE_TEACHER, ...activeAccountFilter }),
    User.countDocuments({ role: ROLE_HEADTEACHER, ...activeAccountFilter }),
    User.countDocuments({ role: ROLE_SECRETARY, ...activeAccountFilter }),
    Lesson.countDocuments(),
    Assessment.countDocuments(),
    Submission.countDocuments(),
    Subject.countDocuments({ isActive: true }),
    SubjectEnrollment.countDocuments({ status: 'approved' }),
    Lesson.aggregate([
      {
        $project: {
          trackValue: '$track',
        },
      },
      { $match: { trackValue: { $exists: true, $ne: '' } } },
      { $group: { _id: '$trackValue' } },
    ]),
    User.countDocuments({ role: ROLE_STUDENT, ...activeAccountFilter, createdAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_STUDENT, ...inactiveAccountFilter, updatedAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_STUDENT, ...activeAccountFilter, createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_STUDENT, ...inactiveAccountFilter, updatedAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_TEACHER, ...activeAccountFilter, createdAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_TEACHER, ...inactiveAccountFilter, updatedAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_TEACHER, ...activeAccountFilter, createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_TEACHER, ...inactiveAccountFilter, updatedAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_HEADTEACHER, ...activeAccountFilter, createdAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_HEADTEACHER, ...inactiveAccountFilter, updatedAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_HEADTEACHER, ...activeAccountFilter, createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_HEADTEACHER, ...inactiveAccountFilter, updatedAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_SECRETARY, ...activeAccountFilter, createdAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_SECRETARY, ...inactiveAccountFilter, updatedAt: { $gte: periodStart } }),
    User.countDocuments({ role: ROLE_SECRETARY, ...activeAccountFilter, createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ role: ROLE_SECRETARY, ...inactiveAccountFilter, updatedAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ ...activeAccountFilter, createdAt: { $gte: periodStart } }),
    User.countDocuments({ ...inactiveAccountFilter, updatedAt: { $gte: periodStart } }),
    User.countDocuments({ ...activeAccountFilter, createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    User.countDocuments({ ...inactiveAccountFilter, updatedAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    Lesson.countDocuments({ createdAt: { $gte: periodStart } }),
    Lesson.countDocuments({ createdAt: { $gte: previousPeriodStart, $lt: periodStart } }),
    Assessment.countDocuments({ createdAt: { $gte: periodStart } }),
    Submission.countDocuments({ createdAt: { $gte: weekStart } }),
    Submission.countDocuments({ createdAt: { $gte: previousWeekStart, $lt: weekStart } }),
    User.countDocuments({ status: 'pending' }),
    SubjectEnrollment.countDocuments({ status: 'pending' }),
    Assessment.aggregate([
      { $group: { _id: '$examType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Assessment.aggregate([
      { $group: { _id: '$difficulty', count: { $sum: 1 } } },
    ]),
    User.aggregate([
      {
        $match: {
          createdAt: { $gte: trendStart },
          role: { $in: [ROLE_STUDENT, ROLE_TEACHER, ROLE_HEADTEACHER, ROLE_SECRETARY] },
        },
      },
      {
        $project: {
          role: '$role',
          dateKey: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$createdAt',
            },
          },
        },
      },
      {
        $group: {
          _id: {
            role: '$role',
            dateKey: '$dateKey',
          },
          count: { $sum: 1 },
        },
      },
    ]),
    Assessment.aggregate([
      {
        $lookup: {
          from: 'lessons',
          localField: 'lessonId',
          foreignField: '_id',
          as: 'lesson',
        },
      },
      {
        $unwind: {
          path: '$lesson',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'submissions',
          localField: '_id',
          foreignField: 'assessmentId',
          as: 'submissionDocs',
        },
      },
      {
        $addFields: {
          trackValue: { $ifNull: ['$lesson.track', 'Unassigned'] },
          submissionCount: { $size: '$submissionDocs' },
          averageScore: {
            $cond: [
              { $gt: [{ $size: '$submissionDocs' }, 0] },
              { $avg: '$submissionDocs.score' },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: '$trackValue',
          assessmentCount: { $sum: 1 },
          submissionCount: { $sum: '$submissionCount' },
          averageScore: { $avg: '$averageScore' },
        },
      },
      { $sort: { submissionCount: -1, averageScore: -1 } },
    ]),
    Lesson.aggregate([
      {
        $group: {
          _id: {
            subject: '$subject',
            track: '$track',
          },
          lessonCount: { $sum: 1 },
          lastContentAt: { $max: '$createdAt' },
        },
      },
    ]),
    Assessment.aggregate([
      {
        $lookup: {
          from: 'lessons',
          localField: 'lessonId',
          foreignField: '_id',
          as: 'lesson',
        },
      },
      {
        $unwind: {
          path: '$lesson',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'submissions',
          localField: '_id',
          foreignField: 'assessmentId',
          as: 'submissionDocs',
        },
      },
      {
        $addFields: {
          trackValue: { $ifNull: ['$lesson.track', 'Unassigned'] },
          submissionCount: { $size: '$submissionDocs' },
          averageScore: {
            $cond: [
              { $gt: [{ $size: '$submissionDocs' }, 0] },
              { $avg: '$submissionDocs.score' },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: {
            subject: '$subject',
            track: '$trackValue',
          },
          assessmentCount: { $sum: 1 },
          submissionCount: { $sum: '$submissionCount' },
          averageScore: { $avg: '$averageScore' },
        },
      },
      { $sort: { submissionCount: -1, averageScore: -1 } },
    ]),
    Submission.aggregate([
      {
        $lookup: {
          from: 'assessments',
          localField: 'assessmentId',
          foreignField: '_id',
          as: 'assessment',
        },
      },
      {
        $unwind: {
          path: '$assessment',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: '$assessment.difficulty',
          attemptCount: { $sum: 1 },
          averageScore: { $avg: '$score' },
        },
      },
      { $sort: { averageScore: -1, attemptCount: -1 } },
    ]),
    Submission.distinct('assessmentId'),
    User.find({ role: ROLE_STUDENT })
      .select('name email status createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    User.find({ role: ROLE_TEACHER })
      .select('name email status createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    User.find({ role: ROLE_HEADTEACHER })
      .select('name email status createdAt department createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    User.find({ role: ROLE_SECRETARY })
      .select('name email status createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    Lesson.find()
      .select('title subject track createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    Assessment.find()
      .select('title subject difficulty examType createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    getRecentActivities(10),
  ]);

  const difficultyData = { easy: 0, medium: 0, hard: 0 };
  difficultyAggregation.forEach((row) => {
    const key = String(row._id || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(difficultyData, key)) {
      difficultyData[key] = row.count;
    }
  });

  const examTypes = examTypeAggregation
    .filter((row) => row._id)
    .map((row) => ({ name: row._id, count: row.count }));

  const roleSeriesMap = {
    [ROLE_STUDENT]: { label: 'Students', data: [] },
    [ROLE_TEACHER]: { label: 'Teachers', data: [] },
    [ROLE_HEADTEACHER]: { label: 'Head Teachers', data: [] },
    [ROLE_SECRETARY]: { label: 'Secretaries', data: [] },
  };
  const roleTrendCountMap = new Map(
    roleTrendAggregation.map((row) => [`${row?._id?.role || ''}::${row?._id?.dateKey || ''}`, row.count || 0])
  );

  trendBuckets.forEach((bucket) => {
    Object.entries(roleSeriesMap).forEach(([role, series]) => {
      series.data.push(roleTrendCountMap.get(`${role}::${bucket.key}`) || 0);
    });
  });

  const subjectMetricsMap = new Map();
  subjectLessonAggregation.forEach((row) => {
    const subjectName = String(row?._id?.subject || '').trim();
    const trackName = String(row?._id?.track || '').trim() || 'Unassigned';
    if (!subjectName) return;

    subjectMetricsMap.set(`${trackName}::${subjectName}`, {
      subject: subjectName,
      track: trackName,
      lessonCount: Number(row.lessonCount || 0),
      assessmentCount: 0,
      submissionCount: 0,
      averageScore: 0,
      lastContentAt: row.lastContentAt || null,
    });
  });

  subjectSubmissionAggregation.forEach((row) => {
    const subjectName = String(row?._id?.subject || '').trim();
    const trackName = String(row?._id?.track || '').trim() || 'Unassigned';
    if (!subjectName) return;

    const key = `${trackName}::${subjectName}`;
    const existing = subjectMetricsMap.get(key) || {
      subject: subjectName,
      track: trackName,
      lessonCount: 0,
      assessmentCount: 0,
      submissionCount: 0,
      averageScore: 0,
      lastContentAt: null,
    };

    existing.assessmentCount = Number(row.assessmentCount || 0);
    existing.submissionCount = Number(row.submissionCount || 0);
    existing.averageScore = roundToOneDecimal(row.averageScore || 0);
    subjectMetricsMap.set(key, existing);
  });

  const subjectPerformance = Array.from(subjectMetricsMap.values());
  const topSubjects = [...subjectPerformance]
    .sort((left, right) => (
      right.submissionCount - left.submissionCount ||
      right.averageScore - left.averageScore ||
      right.lessonCount - left.lessonCount
    ))
    .slice(0, 5);

  const atRiskSubjects = [...subjectPerformance]
    .filter((item) => item.lessonCount > 0)
    .filter((item) => item.submissionCount <= 2 || !item.lastContentAt || item.lastContentAt < periodStart)
    .sort((left, right) => {
      const leftTime = left.lastContentAt ? new Date(left.lastContentAt).getTime() : 0;
      const rightTime = right.lastContentAt ? new Date(right.lastContentAt).getTime() : 0;
      return left.submissionCount - right.submissionCount || leftTime - rightTime;
    })
    .slice(0, 5);

  const topTracks = trackPerformanceAggregation
    .filter((row) => row._id)
    .map((row) => ({
      track: row._id,
      assessmentCount: Number(row.assessmentCount || 0),
      submissionCount: Number(row.submissionCount || 0),
      averageScore: roundToOneDecimal(row.averageScore || 0),
    }))
    .slice(0, 5);

  const attemptedExams = Array.isArray(attemptedAssessmentIds) ? attemptedAssessmentIds.length : 0;
  const unattemptedExams = Math.max(totalAssessments - attemptedExams, 0);
  const mostEffectiveDifficulty = aiDifficultyPerformanceAggregation
    .filter((row) => row._id)
    .map((row) => ({
      difficulty: row._id,
      attemptCount: Number(row.attemptCount || 0),
      averageScore: roundToOneDecimal(row.averageScore || 0),
    }))[0] || null;

  const courseCompletion = totalAssessments
    ? roundToOneDecimal((totalSubmissions / totalAssessments) * 100)
    : 0;
  const aiCompletionRate = totalAssessments
    ? roundToOneDecimal((attemptedExams / totalAssessments) * 100)
    : 0;
  const currentStudents = currentStudentsActivated - currentStudentsDeactivated;
  const previousStudents = previousStudentsActivated - previousStudentsDeactivated;
  const studentNetChange = currentStudents - previousStudents;
  const currentTeachers = currentTeachersActivated - currentTeachersDeactivated;
  const previousTeachers = previousTeachersActivated - previousTeachersDeactivated;
  const teacherNetChange = currentTeachers - previousTeachers;
  const currentHeadTeachers = currentHeadTeachersActivated - currentHeadTeachersDeactivated;
  const previousHeadTeachers = previousHeadTeachersActivated - previousHeadTeachersDeactivated;
  const headTeacherNetChange = currentHeadTeachers - previousHeadTeachers;
  const currentSecretaries = currentSecretariesActivated - currentSecretariesDeactivated;
  const previousSecretaries = previousSecretariesActivated - previousSecretariesDeactivated;
  const secretaryNetChange = currentSecretaries - previousSecretaries;
  const currentUsers = currentUsersActivated - currentUsersDeactivated;
  const previousUsers = previousUsersActivated - previousUsersDeactivated;
  const totalUserNetChange = currentUsers - previousUsers;

  return sendSuccess(res, 200, 'Analytics fetched successfully', {
    analytics: {
      totalUsers,
      totalStudents,
      totalTeachers,
      totalHeadTeachers,
      totalSecretaries,
      totalCourses: totalLessons,
      totalTracks: trackGroups.length,
      totalSubjects,
      totalEnrollments,
      totalLessons,
      totalAssessments,
      totalSubmissions,
      totalActivities: totalAssessments,
      studentGrowth: pctGrowth(currentStudents, previousStudents),
      studentNetChange,
      teacherGrowth: pctGrowth(currentTeachers, previousTeachers),
      teacherNetChange,
      headTeacherGrowth: pctGrowth(currentHeadTeachers, previousHeadTeachers),
      headTeacherNetChange,
      secretaryGrowth: pctGrowth(currentSecretaries, previousSecretaries),
      secretaryNetChange,
      totalUserGrowth: pctGrowth(currentUsers, previousUsers),
      totalUserNetChange,
      courseGrowth: pctGrowth(currentLessons, previousLessons),
      newStudents: currentStudents,
      pendingApplications,
      pendingCourses: pendingEnrollmentRequests,
      pendingEnrollments: pendingEnrollmentRequests,
      approvalWorkload: {
        pendingApplications,
        pendingEnrollments: pendingEnrollmentRequests,
        totalPending: pendingApplications + pendingEnrollmentRequests,
      },
      avgSession: 'N/A',
      courseCompletion,
      weeklyCompletionGrowth: pctGrowth(currentSubmissions, previousSubmissions),
      roleTrends: {
        labels: trendBuckets.map((bucket) => bucket.label),
        series: Object.values(roleSeriesMap),
      },
      learningFunnel: {
        labels: ['Lessons', 'Assessments', 'Submissions'],
        values: [totalLessons, totalAssessments, totalSubmissions],
      },
      detailTables: {
        students: studentUsers.map((user) => ({
          id: String(user._id),
          name: user.name || 'Unnamed user',
          email: user.email || '-',
          status: user.status || '-',
          createdAt: user.createdAt || null,
        })),
        teachers: teacherUsers.map((user) => ({
          id: String(user._id),
          name: user.name || 'Unnamed user',
          email: user.email || '-',
          status: user.status || '-',
          createdAt: user.createdAt || null,
        })),
        headTeachers: headTeacherUsers.map((user) => ({
          id: String(user._id),
          name: user.name || 'Unnamed user',
          email: user.email || '-',
          department: user.department || '-',
          status: user.status || '-',
          createdAt: user.createdAt || null,
        })),
        secretaries: secretaryUsers.map((user) => ({
          id: String(user._id),
          name: user.name || 'Unnamed user',
          email: user.email || '-',
          status: user.status || '-',
          createdAt: user.createdAt || null,
        })),
        lessons: lessonDetails.map((lesson) => ({
          id: String(lesson._id),
          title: lesson.title || 'Untitled lesson',
          subject: lesson.subject || '-',
          track: lesson.track || '-',
          createdAt: lesson.createdAt || null,
        })),
        assessments: assessmentDetails.map((assessment) => ({
          id: String(assessment._id),
          title: assessment.title || 'Untitled assessment',
          subject: assessment.subject || '-',
          difficulty: assessment.difficulty || '-',
          examType: assessment.examType || '-',
          createdAt: assessment.createdAt || null,
        })),
      },
      topSubjects,
      topTracks,
      atRiskSubjects,
    },
    aiAnalytics: {
      totalGeneratedExams: totalAssessments,
      totalAiChallenges: totalAssessments,
      recentChallenges: currentAssessments,
      topExamType: examTypes[0]?.name || '',
      examTypes,
      difficultyData,
      attemptedExams,
      unattemptedExams,
      completionRate: aiCompletionRate,
      mostEffectiveDifficulty,
      usageDistribution: {
        labels: ['Attempted', 'Not Yet Attempted'],
        values: [attemptedExams, unattemptedExams],
      },
    },
    recentActivities,
  });
});

const getAnalytics = asyncHandler(async (_req, res) => {
  const payload = await getSupabaseAnalytics();
  return sendSuccess(res, 200, 'Analytics fetched successfully', payload);
});

const sendUserMessage = asyncHandler(async (req, res) => {
  const recipientId = String(req.params.id || '').trim();
  if (!recipientId) {
    const error = new Error('Invalid recipient id');
    error.statusCode = 400;
    throw error;
  }

  const subject = String(req.body?.subject || '').trim();
  const content = String(req.body?.content || '').trim();
  const urgent = req.body?.urgent === true;

  if (!subject) {
    const error = new Error('Message subject is required');
    error.statusCode = 400;
    throw error;
  }

  if (!content) {
    const error = new Error('Message content is required');
    error.statusCode = 400;
    throw error;
  }

  const recipient = await findSupabaseAccount('id', recipientId);
  if (!recipient) {
    const error = new Error('Recipient not found');
    error.statusCode = 404;
    throw error;
  }
  ensureUserManagementPermission(req, normalizeAdminManagedRole(recipient.role));

  const recipientRole = String(recipient.role || '').trim().toLowerCase();
  if (!['student', 'teacher'].includes(recipientRole)) {
    const error = new Error('Admin messages can only be sent to students or teachers');
    error.statusCode = 400;
    throw error;
  }

  if (String(recipient.status || '').trim().toLowerCase() !== 'active') {
    const error = new Error('Recipient must be active to receive messages');
    error.statusCode = 400;
    throw error;
  }

  const { messageRecord, notificationRecord } = await createAdminMessageNotification({
    sender: req.user,
    recipient,
    subject,
    content,
    urgent,
  });

  const unreadCount = await countUnreadNotifications({
    recipientId: recipient._id,
    recipientRole,
  });

  return sendSuccess(res, 201, 'Message sent successfully', {
    messageRecord: {
      id: messageRecord._id,
      recipientId: messageRecord.recipientId,
      recipientRole: messageRecord.recipientRole,
      subject: messageRecord.subject,
      preview: messageRecord.preview,
      urgent: messageRecord.urgent === true,
      createdAt: messageRecord.createdAt || null,
    },
    notification: {
      id: notificationRecord._id,
      recipientId: notificationRecord.recipientId,
      recipientRole: notificationRecord.recipientRole,
      subject: notificationRecord.subject,
      preview: notificationRecord.preview,
      senderName: notificationRecord.senderName,
      urgent: notificationRecord.urgent === true,
      createdAt: notificationRecord.createdAt || null,
    },
    unreadCount,
  });
});

const getArchivedPdfExportRequests = asyncHandler(async (req, res) => {
  const requestedLimit = Number(req.query?.limit || 12);
  const limit = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 12));
  const exportRequests = await listExportApprovalRequests({
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
    limit,
  });

  for (const exportRequest of exportRequests) {
    await expireExportApprovalRequestIfNeeded(exportRequest);
  }

  const statusPriority = new Map([
    [EXPORT_APPROVAL_STATUS_PENDING, 0],
    [EXPORT_APPROVAL_STATUS_APPROVED, 1],
    [EXPORT_APPROVAL_STATUS_REJECTED, 2],
    ['fulfilled', 3],
    ['expired', 4],
  ]);

  const sortedRequests = [...exportRequests].sort((left, right) => {
    const leftPriority = statusPriority.get(String(left.status || '').trim().toLowerCase()) ?? 99;
    const rightPriority = statusPriority.get(String(right.status || '').trim().toLowerCase()) ?? 99;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
  });

  const pendingCount = await countExportApprovalRequests({
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
    status: EXPORT_APPROVAL_STATUS_PENDING,
  });

  return sendSuccess(res, 200, 'Archived PDF export requests fetched successfully.', {
    requests: sortedRequests.map(normalizeExportApprovalRequest),
    summary: {
      pendingCount,
      totalShown: sortedRequests.length,
      approvalExpiresInMinutes: APPROVED_EXPORT_REQUEST_TTL_MINUTES,
    },
  });
});

const reviewArchivedPdfExportRequest = asyncHandler(async (req, res) => {
  const requestId = String(req.params.id || '').trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    const error = new Error('Invalid export approval request id.');
    error.statusCode = 400;
    throw error;
  }

  const decision = String(req.body?.decision || '').trim().toLowerCase();
  const reviewNote = String(req.body?.note || '').trim();
  if (!['approved', 'rejected'].includes(decision)) {
    const error = new Error('Decision must be either approved or rejected.');
    error.statusCode = 400;
    throw error;
  }

  const exportRequest = await findExportApprovalRequest({
    id: requestId,
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
  });

  if (!exportRequest) {
    const error = new Error('Archived PDF export request not found.');
    error.statusCode = 404;
    throw error;
  }

  await expireExportApprovalRequestIfNeeded(exportRequest);

  if (exportRequest.status !== EXPORT_APPROVAL_STATUS_PENDING) {
    const error = new Error('This archived PDF export request has already been reviewed.');
    error.statusCode = 409;
    throw error;
  }

  const now = new Date();
  exportRequest.status = decision === 'approved' ? EXPORT_APPROVAL_STATUS_APPROVED : EXPORT_APPROVAL_STATUS_REJECTED;
  exportRequest.reviewerId = req.user?._id || null;
  exportRequest.reviewerName = String(req.user?.name || req.user?.username || 'Admin').trim() || 'Admin';
  exportRequest.reviewNote = reviewNote;
  exportRequest.reviewedAt = now;
  exportRequest.approvedAt = decision === 'approved' ? now : null;
  exportRequest.rejectedAt = decision === 'rejected' ? now : null;
  exportRequest.expiresAt = decision === 'approved' ? getApprovedExportRequestExpiryDate(now) : null;
  await exportRequest.save();

  return sendSuccess(
    res,
    200,
    decision === 'approved'
      ? 'Archived PDF export request approved successfully.'
      : 'Archived PDF export request rejected successfully.',
    {
      request: normalizeExportApprovalRequest(exportRequest),
    }
  );
});

module.exports = {
  createUser,
  createAndInviteUser,
  sendUserMessage,
  getAuditLogs,
  getLoginAttempts,
  getArchivedPdfExportRequests,
  reviewArchivedPdfExportRequest,
  sendUserInvite,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  saveSecuritySettings,
  getSecuritySettings,
  getSystemSettings,
  saveSystemSettings,
  clearSystemCache,
  getRawSettingsDebug,
  getAnalytics,
};
