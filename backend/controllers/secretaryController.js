const { sendSuccess } = require('../utils/responseHelper');
const { ROLE_HEADTEACHER, ROLE_SECRETARY, ROLE_STUDENT, ROLE_TEACHER } = require('../constants/userRoles');
const { mapUserResponse } = require('../services/userManagementService');
const { formatRecommendationPayload } = require('../services/recommendationService');
const { listSupabaseAccounts } = require('../services/supabaseAccountService');
const { readProfileRows } = require('../services/supabaseUserProfileService');
const {
  buildDefaultSchoolYearLabel,
  isArchivedStudent,
  normalizeSchoolYearLabel,
} = require('../utils/studentArchive');
const {
  EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
  EXPORT_APPROVAL_STATUS_PENDING,
  EXPORT_APPROVAL_STATUS_APPROVED,
  EXPORT_APPROVAL_STATUS_EXPIRED,
  EXPORT_APPROVAL_STATUS_FULFILLED,
  EXPORT_APPROVAL_STATUS_REJECTED,
  normalizeArchivedPdfExportFilters,
  buildArchivedPdfRequestSignature,
  expireExportApprovalRequestIfNeeded,
  normalizeExportApprovalRequest,
} = require('../services/exportApprovalService');
const {
  createExportApprovalRequest,
  findExportApprovalRequest,
  findLatestExportApprovalRequest,
} = require('../services/supabaseExportApprovalService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function assertSecretaryAccess(req, message) {
  if (String(req.user?.role || '') !== ROLE_SECRETARY) {
    const error = new Error(message);
    error.statusCode = 403;
    throw error;
  }
}

function accountId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function mapSecretaryUserResponse(user, req) {
  const { password: _password, ...safeUser } = mapUserResponse(user, req);
  return safeUser;
}

function compareStudentRecords(left, right, archived) {
  if (archived) {
    const schoolYearComparison = String(right?.archive?.schoolYear || '')
      .localeCompare(String(left?.archive?.schoolYear || ''));
    if (schoolYearComparison) return schoolYearComparison;
    const archivedAtComparison = String(right?.archive?.archivedAt || '')
      .localeCompare(String(left?.archive?.archivedAt || ''));
    if (archivedAtComparison) return archivedAtComparison;
  }

  return String(left?.department || '').localeCompare(String(right?.department || ''))
    || String(left?.gradeLevel || '').localeCompare(String(right?.gradeLevel || ''))
    || String(left?.name || '').localeCompare(String(right?.name || ''));
}

async function buildStudentRecordPayload(req, { archived = false, schoolYear = '' } = {}) {
  const accounts = await listSupabaseAccounts();
  const students = accounts
    .filter((account) => String(account?.role || '').trim() === ROLE_STUDENT)
    .filter((student) => isArchivedStudent(student) === archived)
    .filter((student) => !schoolYear || String(student?.archive?.schoolYear || '').trim() === schoolYear)
    .sort((left, right) => compareStudentRecords(left, right, archived));

  const studentIds = students
    .map(accountId)
    .filter(Boolean);
  const recommendationRows = studentIds.length > 0
    ? await readProfileRows('recommendations', 'student_id', studentIds)
    : [];
  const recommendationsByStudentId = new Map(
    recommendationRows.map((row) => [String(row?.studentId || '').trim(), formatRecommendationPayload(row)])
  );

  const sectionIds = [...new Set(students.map((student) => accountId(student?.sectionId)).filter(Boolean))];
  const sections = sectionIds.length > 0
    ? await readProfileRows('sections', 'id', sectionIds)
    : [];
  const sectionById = new Map(sections.map((section) => [accountId(section), section]));
  const accountsById = new Map(accounts.map((account) => [accountId(account), account]));
  const advisers = accounts.filter((account) => String(account?.role || '').trim() === ROLE_TEACHER);
  const adviserBySectionId = new Map(
    advisers.map((teacher) => [accountId(teacher?.advisorySectionId), teacher]).filter(([sectionId]) => Boolean(sectionId))
  );

  return students.map((student) => {
    const studentId = accountId(student);
    const sectionId = accountId(student?.sectionId);
    const section = sectionById.get(sectionId) || null;
    const adviserId = accountId(student?.enrollment?.teacherId || student?.managedBy);
    const adviser = adviserBySectionId.get(sectionId) || accountsById.get(adviserId) || null;
    const archivedById = accountId(student?.archive?.archivedBy);
    const mapped = mapSecretaryUserResponse({
      ...student,
      sectionId: section || student?.sectionId,
      archive: {
        ...(student?.archive || {}),
        archivedBy: accountsById.get(archivedById) || student?.archive?.archivedBy || null,
      },
    }, req);
    const recommendation = recommendationsByStudentId.get(studentId) || formatRecommendationPayload({
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
      ...mapped,
      gradeLevel: String(student?.gradeLevel || '').trim(),
      section: section
        ? {
          id: accountId(section),
          name: String(section.name || '').trim(),
        }
        : null,
      adviser: adviser ? {
        id: String(adviser?._id || adviser?.id || ''),
        name: String(adviser?.name || '').trim(),
        email: String(adviser?.email || '').trim(),
        subject: String(adviser?.subject || adviser?.department || '').trim(),
        department: String(adviser?.department || '').trim(),
      } : null,
      progress: {
        masteryProgress: Number(student?.enrollment?.progress?.masteryProgress || 0),
        averageScore: Number(student?.enrollment?.progress?.averageScore || 0),
        completedAssessments: Number(student?.enrollment?.progress?.completedAssessments || 0),
        lastCalculatedAt: student?.enrollment?.progress?.lastCalculatedAt || null,
      },
      recommendation: {
        recommendedStrand: recommendation.recommendedStrand,
        recommendationProgressPercent: Number(recommendation.recommendationProgressPercent || 0),
        recommendationStatus: String(recommendation.recommendationStatus || 'not_started').trim(),
        isRecommendationReady: Boolean(recommendation.isRecommendationReady),
        completedGradingPeriods: Array.isArray(recommendation.completedGradingPeriods) ? recommendation.completedGradingPeriods : [],
        requiredGradingPeriods: Array.isArray(recommendation.requiredGradingPeriods) ? recommendation.requiredGradingPeriods : [],
        recommendationExplanation: String(recommendation.recommendationExplanation || '').trim(),
        updatedAt: recommendation.updatedAt || null,
      },
    };
  });
}

function matchesArchivedPdfExportFilters(student, filters = {}) {
  const normalizedFilters = normalizeArchivedPdfExportFilters(filters);
  const query = String(normalizedFilters.searchTerm || '').trim().toLowerCase();
  const schoolYear = String(student?.archive?.schoolYear || '').trim();
  const department = String(student?.department || '').trim();
  const gradeLevel = String(student?.gradeLevel || '').trim();
  const haystack = [
    student?.name,
    student?.email,
    schoolYear,
    student?.section?.name,
    department,
    gradeLevel,
    student?.adviser?.name,
    student?.archive?.archivedBy?.name,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .join(' ');

  const matchesSchoolYear = normalizedFilters.schoolYear === 'all' || schoolYear === normalizedFilters.schoolYear;
  const matchesDepartment = normalizedFilters.department === 'all' || department === normalizedFilters.department;
  const matchesGradeLevel = normalizedFilters.gradeLevel === 'all' || gradeLevel === normalizedFilters.gradeLevel;
  const matchesSearch = !query || haystack.includes(query);

  return matchesSchoolYear && matchesDepartment && matchesGradeLevel && matchesSearch;
}

async function buildArchivedPdfExportSelection(req, rawFilters = {}) {
  const filters = normalizeArchivedPdfExportFilters(rawFilters);
  const schoolYear = filters.schoolYear === 'all' ? '' : filters.schoolYear;
  const students = await buildStudentRecordPayload(req, { archived: true, schoolYear });
  const filteredStudents = students.filter((student) => matchesArchivedPdfExportFilters(student, filters));
  const studentIds = filteredStudents
    .map((student) => String(student?.id || student?._id || '').trim())
    .filter(Boolean);

  return {
    filters,
    students: filteredStudents,
    studentIds,
    studentCount: studentIds.length,
    requestSignature: buildArchivedPdfRequestSignature({ filters, studentIds }),
  };
}

async function findLatestArchivedPdfExportRequest(requesterId, requestSignature) {
  if (!requesterId || !requestSignature) return null;

  const exportRequest = await findLatestExportApprovalRequest({
    requesterId,
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
    requestSignature,
  });

  if (!exportRequest) return null;

  await expireExportApprovalRequestIfNeeded(exportRequest);
  return exportRequest;
}

const getDirectory = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can access this directory');

  const users = (await listSupabaseAccounts())
    .filter((user) => [ROLE_HEADTEACHER, ROLE_TEACHER].includes(String(user?.role || '').trim()))
    .sort((left, right) => (
      String(left?.role || '').localeCompare(String(right?.role || ''))
      || String(left?.department || '').localeCompare(String(right?.department || ''))
      || String(left?.name || '').localeCompare(String(right?.name || ''))
    ));

  return sendSuccess(res, 200, 'Directory fetched successfully', {
    users: users.map((user) => mapSecretaryUserResponse(user, req)),
  });
});

const getStudentRecords = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can access student records');

  const students = await buildStudentRecordPayload(req);

  return sendSuccess(res, 200, 'Student records fetched successfully', {
    students,
    summary: {
      totalStudents: students.length,
      currentSchoolYear: buildDefaultSchoolYearLabel(),
    },
  });
});

const getArchivedStudentRecords = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can access archived student records');

  const requestedSchoolYear = String(req.query?.schoolYear || '').trim();
  const schoolYear = requestedSchoolYear
    ? normalizeSchoolYearLabel(requestedSchoolYear)
    : '';

  const students = await buildStudentRecordPayload(req, { archived: true, schoolYear });

  const schoolYears = Array.from(
    new Set(
      students
        .map((student) => String(student?.archive?.schoolYear || '').trim())
        .filter(Boolean)
    )
  ).sort((left, right) => right.localeCompare(left));

  return sendSuccess(res, 200, 'Archived student records fetched successfully', {
    students,
    summary: {
      totalArchived: students.length,
      schoolYears,
      schoolYear: schoolYear || '',
      currentSchoolYear: buildDefaultSchoolYearLabel(),
    },
  });
});

const getArchivedPdfExportRequestStatus = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can check archived PDF export approval status');

  const exportSelection = await buildArchivedPdfExportSelection(req, req.query || {});
  const exportRequest = await findLatestArchivedPdfExportRequest(req.user?._id, exportSelection.requestSignature);

  return sendSuccess(res, 200, 'Archived PDF export approval status fetched successfully', {
    request: normalizeExportApprovalRequest(exportRequest),
    exportContext: {
      studentCount: exportSelection.studentCount,
      filters: exportSelection.filters,
    },
  });
});

const requestArchivedPdfExport = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can request archived PDF exports');

  const exportSelection = await buildArchivedPdfExportSelection(req, req.body || {});
  if (exportSelection.studentCount <= 0) {
    const error = new Error('No archived student records match the selected filters for PDF export.');
    error.statusCode = 400;
    throw error;
  }

  const existingRequest = await findLatestArchivedPdfExportRequest(req.user?._id, exportSelection.requestSignature);
  if (existingRequest && existingRequest.status === EXPORT_APPROVAL_STATUS_PENDING) {
    return sendSuccess(res, 200, 'Your archived PDF export request is already pending admin approval.', {
      request: normalizeExportApprovalRequest(existingRequest),
      exportContext: {
        studentCount: exportSelection.studentCount,
        filters: exportSelection.filters,
      },
    });
  }

  if (existingRequest && existingRequest.status === EXPORT_APPROVAL_STATUS_APPROVED) {
    return sendSuccess(res, 200, 'Your archived PDF export request is already approved and ready to use.', {
      request: normalizeExportApprovalRequest(existingRequest),
      exportContext: {
        studentCount: exportSelection.studentCount,
        filters: exportSelection.filters,
      },
    });
  }

  const createdRequest = await createExportApprovalRequest({
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
    requestSignature: exportSelection.requestSignature,
    requesterId: req.user?._id,
    requesterRole: String(req.user?.role || '').trim().toLowerCase(),
    requesterName: String(req.user?.name || req.user?.username || 'Secretary').trim() || 'Secretary',
    format: 'pdf',
    filters: exportSelection.filters,
    studentIds: exportSelection.studentIds,
    studentCount: exportSelection.studentCount,
    status: EXPORT_APPROVAL_STATUS_PENDING,
  });

  return sendSuccess(res, 201, 'Archived PDF export request submitted to admin successfully.', {
    request: normalizeExportApprovalRequest(createdRequest),
    exportContext: {
      studentCount: exportSelection.studentCount,
      filters: exportSelection.filters,
    },
  });
});

const consumeArchivedPdfExportApproval = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can use archived PDF export approvals');

  const requestId = String(req.params.id || '').trim();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    const error = new Error('Invalid archived PDF export approval request id.');
    error.statusCode = 400;
    throw error;
  }

  const exportRequest = await findExportApprovalRequest({
    id: requestId,
    requesterId: req.user?._id,
    requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
  });

  if (!exportRequest) {
    const error = new Error('Archived PDF export approval request not found.');
    error.statusCode = 404;
    throw error;
  }

  await expireExportApprovalRequestIfNeeded(exportRequest);

  if (exportRequest.status === EXPORT_APPROVAL_STATUS_PENDING) {
    const error = new Error('This archived PDF export request is still waiting for admin approval.');
    error.statusCode = 409;
    throw error;
  }

  if (exportRequest.status === EXPORT_APPROVAL_STATUS_REJECTED) {
    const error = new Error('This archived PDF export request was rejected. Please submit a new request.');
    error.statusCode = 409;
    throw error;
  }

  if (exportRequest.status === EXPORT_APPROVAL_STATUS_EXPIRED) {
    const error = new Error('This archived PDF export approval has expired. Please submit a new request.');
    error.statusCode = 409;
    throw error;
  }

  if (exportRequest.status === EXPORT_APPROVAL_STATUS_FULFILLED) {
    const error = new Error('This archived PDF export approval was already used. Please submit a new request.');
    error.statusCode = 409;
    throw error;
  }

  if (exportRequest.status !== EXPORT_APPROVAL_STATUS_APPROVED) {
    const error = new Error('This archived PDF export request is not available for use.');
    error.statusCode = 409;
    throw error;
  }

  const exportSelection = await buildArchivedPdfExportSelection(req, exportRequest.filters || {});
  if (exportSelection.studentCount <= 0 || exportSelection.requestSignature !== String(exportRequest.requestSignature || '').trim()) {
    exportRequest.status = EXPORT_APPROVAL_STATUS_EXPIRED;
    exportRequest.reviewedAt = exportRequest.reviewedAt || new Date();
    await exportRequest.save();

    const error = new Error('Archived records changed after approval. Please submit a new export request.');
    error.statusCode = 409;
    throw error;
  }

  exportRequest.status = EXPORT_APPROVAL_STATUS_FULFILLED;
  exportRequest.fulfilledAt = new Date();
  await exportRequest.save();

  return sendSuccess(res, 200, 'Archived PDF export approval validated successfully.', {
    request: normalizeExportApprovalRequest(exportRequest),
    exportContext: {
      studentCount: exportSelection.studentCount,
      filters: exportSelection.filters,
    },
  });
});

const endSchoolYearArchiveStudents = asyncHandler(async (req, res) => {
  assertSecretaryAccess(req, 'Only Secretaries can archive student records');

  const schoolYear = normalizeSchoolYearLabel(req.body?.schoolYear, buildDefaultSchoolYearLabel());
  const now = new Date();
  const candidates = (await listSupabaseAccounts())
    .filter((account) => String(account?.role || '').trim() === ROLE_STUDENT)
    .filter((student) => String(student?.status || '').trim().toLowerCase() === 'inactive')
    .filter((student) => !isArchivedStudent(student))
    .sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || '')));

  if (candidates.length === 0) {
    return sendSuccess(res, 200, 'No inactive student records were available to archive', {
      archivedCount: 0,
      schoolYear,
      archivedAt: now,
      archivedStudents: [],
    });
  }

  await Promise.all(candidates.map(async (student) => {
    student.archive = {
      ...(student.archive || {}),
      isArchived: true,
      schoolYear,
      archivedAt: now.toISOString(),
      archivedBy: accountId(req.user),
      reason: 'inactive',
    };
    await student.save();
  }));

  return sendSuccess(res, 200, 'Inactive student records archived successfully', {
    archivedCount: candidates.length,
    schoolYear,
    archivedAt: now,
    archivedStudents: candidates.map((student) => ({
      id: String(student?._id || ''),
      name: String(student?.name || '').trim(),
      email: String(student?.email || '').trim(),
      status: String(student?.status || '').trim().toLowerCase(),
      gradeLevel: String(student?.gradeLevel || '').trim(),
      department: String(student?.department || '').trim(),
    })),
  });
});

module.exports = {
  getDirectory,
  getStudentRecords,
  getArchivedStudentRecords,
  getArchivedPdfExportRequestStatus,
  requestArchivedPdfExport,
  consumeArchivedPdfExportApproval,
  endSchoolYearArchiveStudents,
};
