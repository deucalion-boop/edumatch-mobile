const crypto = require('crypto');
const { normalizeSchoolYearLabel } = require('../utils/studentArchive');

const EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF = 'archived_student_records_pdf';
const EXPORT_APPROVAL_STATUS_PENDING = 'pending';
const EXPORT_APPROVAL_STATUS_APPROVED = 'approved';
const EXPORT_APPROVAL_STATUS_REJECTED = 'rejected';
const EXPORT_APPROVAL_STATUS_FULFILLED = 'fulfilled';
const EXPORT_APPROVAL_STATUS_EXPIRED = 'expired';
const APPROVED_EXPORT_REQUEST_TTL_MINUTES = 30;

function normalizeExportFilterOption(value, fallback = 'all') {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  return normalized.toLowerCase() === 'all' ? 'all' : normalized;
}

function normalizeArchivedPdfExportFilters(rawFilters = {}) {
  const schoolYear = normalizeExportFilterOption(rawFilters?.schoolYear);
  const department = normalizeExportFilterOption(rawFilters?.department);
  const gradeLevel = normalizeExportFilterOption(rawFilters?.gradeLevel);
  const searchTerm = String(rawFilters?.searchTerm || '')
    .trim()
    .replace(/\s+/g, ' ');

  return {
    schoolYear: schoolYear === 'all' ? 'all' : normalizeSchoolYearLabel(schoolYear),
    department,
    gradeLevel,
    searchTerm,
  };
}

function buildArchivedPdfRequestSignature({ filters = {}, studentIds = [] } = {}) {
  const normalizedFilters = normalizeArchivedPdfExportFilters(filters);
  const normalizedStudentIds = Array.from(
    new Set(
      (Array.isArray(studentIds) ? studentIds : [])
        .map((studentId) => String(studentId || '').trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      requestType: EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
      filters: normalizedFilters,
      studentIds: normalizedStudentIds,
    }))
    .digest('hex');
}

function getApprovedExportRequestExpiryDate(baseDate = new Date()) {
  return new Date(baseDate.getTime() + APPROVED_EXPORT_REQUEST_TTL_MINUTES * 60 * 1000);
}

function isExportApprovalRequestExpired(request, referenceDate = new Date()) {
  if (!request) return false;
  if (String(request.status || '').trim().toLowerCase() !== EXPORT_APPROVAL_STATUS_APPROVED) return false;
  if (!request.expiresAt) return false;

  const expiresAt = new Date(request.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= referenceDate.getTime();
}

async function expireExportApprovalRequestIfNeeded(request, referenceDate = new Date()) {
  if (!isExportApprovalRequestExpired(request, referenceDate)) {
    return request;
  }

  request.status = EXPORT_APPROVAL_STATUS_EXPIRED;
  request.reviewedAt = request.reviewedAt || referenceDate;

  if (typeof request.save === 'function') {
    await request.save();
  }

  return request;
}

function normalizeExportApprovalRequest(request) {
  if (!request) return null;

  const isExpired = isExportApprovalRequestExpired(request);
  const resolvedStatus = isExpired
    ? EXPORT_APPROVAL_STATUS_EXPIRED
    : String(request.status || '').trim().toLowerCase();

  return {
    id: String(request._id || request.id || '').trim(),
    requestType: String(request.requestType || '').trim(),
    format: String(request.format || 'pdf').trim(),
    status: resolvedStatus || EXPORT_APPROVAL_STATUS_PENDING,
    filters: {
      schoolYear: String(request.filters?.schoolYear || 'all').trim() || 'all',
      department: String(request.filters?.department || 'all').trim() || 'all',
      gradeLevel: String(request.filters?.gradeLevel || 'all').trim() || 'all',
      searchTerm: String(request.filters?.searchTerm || '').trim(),
    },
    studentCount: Number(request.studentCount || 0),
    requester: {
      id: String(request.requesterId?._id || request.requesterId || '').trim(),
      role: String(request.requesterRole || '').trim(),
      name: String(request.requesterName || '').trim(),
    },
    reviewer: {
      id: String(request.reviewerId?._id || request.reviewerId || '').trim(),
      name: String(request.reviewerName || '').trim(),
      note: String(request.reviewNote || '').trim(),
    },
    createdAt: request.createdAt || null,
    reviewedAt: request.reviewedAt || null,
    approvedAt: request.approvedAt || null,
    rejectedAt: request.rejectedAt || null,
    fulfilledAt: request.fulfilledAt || null,
    expiresAt: request.expiresAt || null,
    isExpired,
  };
}

module.exports = {
  APPROVED_EXPORT_REQUEST_TTL_MINUTES,
  EXPORT_APPROVAL_REQUEST_TYPE_ARCHIVED_PDF,
  EXPORT_APPROVAL_STATUS_PENDING,
  EXPORT_APPROVAL_STATUS_APPROVED,
  EXPORT_APPROVAL_STATUS_REJECTED,
  EXPORT_APPROVAL_STATUS_FULFILLED,
  EXPORT_APPROVAL_STATUS_EXPIRED,
  normalizeArchivedPdfExportFilters,
  buildArchivedPdfRequestSignature,
  getApprovedExportRequestExpiryDate,
  isExportApprovalRequestExpired,
  expireExportApprovalRequestIfNeeded,
  normalizeExportApprovalRequest,
};
