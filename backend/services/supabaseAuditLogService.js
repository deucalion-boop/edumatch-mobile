const { getSupabaseStorageClient } = require('./supabaseStorageService');

function auditLogError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseAuditLogError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = 500;
  return normalized;
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim() || null;
}

function clean(value, maxLength = 0) {
  const normalized = String(value || '').trim();
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function mapAuditLog(row) {
  return {
    _id: row.id,
    id: row.id,
    actorUserId: row.actor_user_id || null,
    actorName: row.actor_name || '',
    actorEmail: row.actor_email || '',
    actorRole: row.actor_role || '',
    actorIdentifier: row.actor_identifier || '',
    category: row.category || 'System',
    actionLabel: row.action_label || '',
    method: row.method || '',
    endpoint: row.endpoint || '',
    routePath: row.route_path || '',
    targetId: row.target_id || '',
    targetLabel: row.target_label || '',
    succeeded: row.succeeded === true,
    statusCode: Number(row.status_code || 0),
    ipAddress: row.ip_address || '',
    userAgent: row.user_agent || '',
    durationMs: Number(row.duration_ms || 0),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.created_at || null,
  };
}

async function createAuditLog(payload) {
  const row = {
    actor_user_id: referenceId(payload.actorUserId),
    actor_name: clean(payload.actorName, 200),
    actor_email: clean(payload.actorEmail, 200).toLowerCase(),
    actor_role: clean(payload.actorRole, 50).toLowerCase(),
    actor_identifier: clean(payload.actorIdentifier, 200),
    category: clean(payload.category, 80) || 'System',
    action_label: clean(payload.actionLabel, 200),
    method: clean(payload.method, 10).toUpperCase(),
    endpoint: clean(payload.endpoint, 220),
    route_path: clean(payload.routePath, 220),
    target_id: clean(payload.targetId, 160),
    target_label: clean(payload.targetLabel, 220),
    succeeded: payload.succeeded === true,
    status_code: Number(payload.statusCode || 0),
    ip_address: clean(payload.ipAddress, 120),
    user_agent: clean(payload.userAgent, 500),
    duration_ms: Math.max(0, Number(payload.durationMs || 0)),
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
  const { data, error } = await getSupabaseStorageClient().from('audit_logs').insert(row).select('*').single();
  if (error) throw auditLogError(error, 'Failed to record audit log in Supabase');
  return mapAuditLog(data);
}

function applyFilters(query, { search = '', category = '', role = '', method = '', succeeded = null, createdSince = null } = {}) {
  let filtered = query;
  if (category) filtered = filtered.eq('category', category);
  if (role) filtered = filtered.eq('actor_role', role);
  if (method) filtered = filtered.eq('method', method);
  if (typeof succeeded === 'boolean') filtered = filtered.eq('succeeded', succeeded);
  if (createdSince) filtered = filtered.gte('created_at', new Date(createdSince).toISOString());

  const normalizedSearch = clean(search, 100)
    .replace(/[,().%_]/g, ' ')
    .replace(/\s+/g, ' ');
  if (normalizedSearch) {
    const pattern = `*${normalizedSearch}*`;
    filtered = filtered.or([
      `actor_name.ilike.${pattern}`,
      `actor_email.ilike.${pattern}`,
      `actor_identifier.ilike.${pattern}`,
      `action_label.ilike.${pattern}`,
      `endpoint.ilike.${pattern}`,
      `target_label.ilike.${pattern}`,
      `ip_address.ilike.${pattern}`,
    ].join(','));
  }
  return filtered;
}

async function countAuditLogs(filters) {
  const { count, error } = await applyFilters(
    getSupabaseStorageClient().from('audit_logs').select('id', { count: 'exact', head: true }),
    filters
  );
  if (error) throw auditLogError(error, 'Failed to count audit logs in Supabase');
  return Number(count || 0);
}

async function listAuditLogs({ search = '', category = '', role = '', method = '', succeeded = null, page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const filters = { search, category, role, method, succeeded };
  const last24Hours = new Date(Date.now() - (24 * 60 * 60 * 1000));
  const client = getSupabaseStorageClient();
  const [total, successCount, failedCount, recentLogs, categoryResult] = await Promise.all([
    countAuditLogs(filters),
    countAuditLogs({ ...filters, succeeded: true }),
    countAuditLogs({ ...filters, succeeded: false }),
    countAuditLogs({ ...filters, createdSince: last24Hours }),
    client.from('audit_logs').select('category').order('category', { ascending: true }).limit(1000),
  ]);
  if (categoryResult.error) throw auditLogError(categoryResult.error, 'Failed to read audit log categories from Supabase');

  const totalPages = Math.max(Math.ceil(total / safePageSize), 1);
  const resolvedPage = Math.min(safePage, totalPages);
  const offset = (resolvedPage - 1) * safePageSize;
  const { data, error } = await applyFilters(client.from('audit_logs').select('*'), filters)
    .order('created_at', { ascending: false })
    .range(offset, offset + safePageSize - 1);
  if (error) throw auditLogError(error, 'Failed to read audit logs from Supabase');

  return {
    logs: (data || []).map(mapAuditLog),
    summary: { total, successCount, failedCount, recentLogs },
    categories: [...new Set((categoryResult.data || []).map((row) => clean(row.category)).filter(Boolean))],
    pagination: {
      page: resolvedPage,
      pageSize: safePageSize,
      totalItems: total,
      totalPages,
      hasPreviousPage: resolvedPage > 1,
      hasNextPage: resolvedPage < totalPages,
    },
  };
}

module.exports = { createAuditLog, listAuditLogs };
