const { getSupabaseStorageClient } = require('./supabaseStorageService');

function exportRequestError(error, fallback) {
  const normalized = new Error(String(error?.message || fallback));
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toRow(request) {
  return {
    ...(request._id || request.id ? { id: String(request._id || request.id) } : {}),
    request_type: String(request.requestType || '').trim().toLowerCase(),
    request_signature: String(request.requestSignature || '').trim(),
    requester_id: String(request.requesterId?._id || request.requesterId || '').trim() || null,
    requester_role: String(request.requesterRole || '').trim().toLowerCase(),
    requester_name: String(request.requesterName || '').trim(),
    format: String(request.format || 'pdf').trim().toLowerCase(),
    status: String(request.status || 'pending').trim().toLowerCase(),
    filters: request.filters && typeof request.filters === 'object' ? request.filters : {},
    student_ids: Array.isArray(request.studentIds) ? request.studentIds.map(String) : [],
    student_count: Math.max(0, Number(request.studentCount || 0)),
    reviewer_id: String(request.reviewerId?._id || request.reviewerId || '').trim() || null,
    reviewer_name: String(request.reviewerName || '').trim(),
    review_note: String(request.reviewNote || '').trim(),
    reviewed_at: toIso(request.reviewedAt),
    approved_at: toIso(request.approvedAt),
    rejected_at: toIso(request.rejectedAt),
    fulfilled_at: toIso(request.fulfilledAt),
    expires_at: toIso(request.expiresAt),
    updated_at: new Date().toISOString(),
  };
}

function fromRow(row) {
  if (!row) return null;
  const request = {
    _id: row.id,
    id: row.id,
    requestType: row.request_type,
    requestSignature: row.request_signature,
    requesterId: row.requester_id,
    requesterRole: row.requester_role,
    requesterName: row.requester_name,
    format: row.format,
    status: row.status,
    filters: row.filters || {},
    studentIds: row.student_ids || [],
    studentCount: Number(row.student_count || 0),
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    fulfilledAt: row.fulfilled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(request, 'save', { enumerable: false, value: async () => saveExportApprovalRequest(request) });
  return request;
}

async function saveExportApprovalRequest(request) {
  const row = toRow(request);
  const { data, error } = await getSupabaseStorageClient().from('export_approval_requests')
    .upsert(row, { onConflict: 'id' }).select('*').single();
  if (error) throw exportRequestError(error, 'Failed to save export approval request');
  Object.assign(request, fromRow(data));
  return request;
}

async function createExportApprovalRequest(payload) {
  const row = toRow(payload);
  delete row.id;
  const { data, error } = await getSupabaseStorageClient().from('export_approval_requests').insert(row).select('*').single();
  if (error) throw exportRequestError(error, 'Failed to create export approval request');
  return fromRow(data);
}

async function findLatestExportApprovalRequest({ requesterId, requestType, requestSignature }) {
  const { data, error } = await getSupabaseStorageClient().from('export_approval_requests').select('*')
    .eq('requester_id', String(requesterId)).eq('request_type', String(requestType))
    .eq('request_signature', String(requestSignature)).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw exportRequestError(error, 'Failed to read export approval request');
  return fromRow(data);
}

async function findExportApprovalRequest({ id, requestType, requesterId }) {
  let query = getSupabaseStorageClient().from('export_approval_requests').select('*').eq('id', String(id));
  if (requestType) query = query.eq('request_type', String(requestType));
  if (requesterId) query = query.eq('requester_id', String(requesterId));
  const { data, error } = await query.maybeSingle();
  if (error) throw exportRequestError(error, 'Failed to read export approval request');
  return fromRow(data);
}

async function listExportApprovalRequests({ requestType, limit = 12 }) {
  let query = getSupabaseStorageClient().from('export_approval_requests').select('*');
  if (requestType) query = query.eq('request_type', String(requestType));
  const { data, error } = await query.order('created_at', { ascending: false }).limit(Math.min(50, Math.max(1, Number(limit) || 12)));
  if (error) throw exportRequestError(error, 'Failed to list export approval requests');
  return (data || []).map(fromRow);
}

async function countExportApprovalRequests({ requestType, status }) {
  let query = getSupabaseStorageClient().from('export_approval_requests').select('id', { count: 'exact', head: true });
  if (requestType) query = query.eq('request_type', String(requestType));
  if (status) query = query.eq('status', String(status));
  const { count, error } = await query;
  if (error) throw exportRequestError(error, 'Failed to count export approval requests');
  return Number(count || 0);
}

module.exports = {
  countExportApprovalRequests,
  createExportApprovalRequest,
  findExportApprovalRequest,
  findLatestExportApprovalRequest,
  listExportApprovalRequests,
  saveExportApprovalRequest,
};
