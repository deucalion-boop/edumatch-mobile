const { getSupabaseStorageClient } = require('./supabaseStorageService');

function normalizeError(error, message) {
  const normalized = new Error(String(error?.message || message));
  normalized.code = error?.code;
  normalized.statusCode = 500;
  return normalized;
}

function mapSession(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    tokenId: row.token_id,
    ipAddress: row.ip_address || '',
    userAgent: row.user_agent || '',
    remember: row.remember === true,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
    revokedReason: row.revoked_reason || '',
    createdAt: row.created_at,
  };
}

async function createSession(payload) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('sessions').insert({
    user_id: String(payload.userId), token_id: payload.tokenId,
    ip_address: payload.ipAddress || '', user_agent: payload.userAgent || '',
    remember: payload.remember === true, last_seen_at: new Date().toISOString(),
    expires_at: new Date(payload.expiresAt).toISOString(),
  }).select('*').single();
  if (error) throw normalizeError(error, 'Failed to create session');
  return mapSession(data);
}

async function sessionExists(userId, userAgent) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('sessions').select('id')
    .eq('user_id', String(userId)).eq('user_agent', String(userAgent || '')).limit(1).maybeSingle();
  if (error) throw normalizeError(error, 'Failed to check session');
  return Boolean(data);
}

async function findActiveSession(userId, tokenId) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('sessions').select('*')
    .eq('user_id', String(userId)).eq('token_id', tokenId).is('revoked_at', null)
    .gt('expires_at', new Date().toISOString()).limit(1).maybeSingle();
  if (error) throw normalizeError(error, 'Failed to read session');
  return mapSession(data);
}

async function listActiveSessions(userId) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('sessions').select('*')
    .eq('user_id', String(userId)).is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('last_seen_at', { ascending: false });
  if (error) throw normalizeError(error, 'Failed to list sessions');
  return (data || []).map(mapSession);
}

async function revokeSession(userId, sessionId, reason) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('sessions').update({
    revoked_at: new Date().toISOString(), revoked_reason: String(reason || ''),
  }).eq('id', String(sessionId)).eq('user_id', String(userId)).is('revoked_at', null)
    .select('*').maybeSingle();
  // Invalid UUIDs are unknown sessions, just like well-formed IDs with no match.
  if (error?.code === '22P02') return null;
  if (error) throw normalizeError(error, 'Failed to revoke session');
  return mapSession(data);
}

async function touchSession(id, lastSeenAt = new Date()) {
  const client = getSupabaseStorageClient();
  const { error } = await client.from('sessions').update({ last_seen_at: new Date(lastSeenAt).toISOString() }).eq('id', String(id));
  if (error) throw normalizeError(error, 'Failed to update session');
}

async function revokeUserSessions(userId, reason) {
  const client = getSupabaseStorageClient();
  const { error } = await client.from('sessions').update({
    revoked_at: new Date().toISOString(), revoked_reason: String(reason || ''),
  }).eq('user_id', String(userId)).is('revoked_at', null);
  if (error) throw normalizeError(error, 'Failed to revoke sessions');
}

async function revokeNonAdminSessions(reason) {
  const client = getSupabaseStorageClient();
  const revokedAt = new Date().toISOString();
  const pageSize = 500;
  let revokedCount = 0;
  for (let offset = 0; ; offset += pageSize) {
    const { data: users, error: usersError } = await client.from('users').select('id')
      .neq('role', 'admin').order('id').range(offset, offset + pageSize - 1);
    if (usersError) throw normalizeError(usersError, 'Failed to read accounts for session revocation');
    for (let index = 0; index < (users || []).length; index += 100) {
      const userIds = users.slice(index, index + 100).map((user) => user.id);
      const { count, error } = await client.from('sessions').update({
        revoked_at: revokedAt, revoked_reason: String(reason || ''),
      }, { count: 'exact' }).in('user_id', userIds).is('revoked_at', null);
      if (error) throw normalizeError(error, 'Failed to revoke non-administrator sessions');
      revokedCount += Number(count || 0);
    }
    if ((users || []).length < pageSize) return revokedCount;
  }
}

function hydrateChallenge(data) {
  if (!data) return null;
  const challenge = {
    _id: data.id, userId: data.user_id, challengeTokenHash: data.challenge_token_hash,
    otpHash: data.otp_hash, remember: data.remember === true,
    failedAttempts: Number(data.failed_attempts || 0), expiresAt: data.expires_at,
    createdAt: data.created_at,
    consumedAt: data.consumed_at || null, ipAddress: data.ip_address, userAgent: data.user_agent,
  };
  Object.defineProperty(challenge, 'save', { enumerable: false, value: () => saveChallenge(challenge) });
  return challenge;
}

async function consumeOpenChallenges(userId, exceptTokenHash = '') {
  const client = getSupabaseStorageClient();
  let query = client.from('otp_challenges').update({ consumed_at: new Date().toISOString() })
    .eq('user_id', String(userId)).is('consumed_at', null);
  if (exceptTokenHash) query = query.neq('challenge_token_hash', exceptTokenHash);
  const { error } = await query;
  if (error) throw normalizeError(error, 'Failed to expire OTP challenges');
}

async function createChallenge(payload) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('otp_challenges').insert({
    user_id: String(payload.userId), challenge_token_hash: payload.challengeTokenHash,
    otp_hash: payload.otpHash, remember: payload.remember === true,
    ip_address: payload.ipAddress || '', user_agent: payload.userAgent || '',
    expires_at: new Date(payload.expiresAt).toISOString(),
  }).select('*').single();
  if (error) throw normalizeError(error, 'Failed to create OTP challenge');
  return hydrateChallenge(data);
}

async function findActiveChallenge(tokenHash) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('otp_challenges').select('*')
    .eq('challenge_token_hash', tokenHash).is('consumed_at', null)
    .gt('expires_at', new Date().toISOString()).limit(1).maybeSingle();
  if (error) throw normalizeError(error, 'Failed to read OTP challenge');
  return hydrateChallenge(data);
}

async function findOpenChallenge(tokenHash) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('otp_challenges').select('*')
    .eq('challenge_token_hash', tokenHash).is('consumed_at', null).limit(1).maybeSingle();
  if (error) throw normalizeError(error, 'Failed to read OTP challenge');
  return hydrateChallenge(data);
}

async function saveChallenge(challenge) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('otp_challenges').update({
    failed_attempts: Number(challenge.failedAttempts || 0),
    consumed_at: challenge.consumedAt ? new Date(challenge.consumedAt).toISOString() : null,
  }).eq('id', String(challenge._id)).select('*').single();
  if (error) throw normalizeError(error, 'Failed to update OTP challenge');
  Object.assign(challenge, hydrateChallenge(data));
  return challenge;
}

async function deleteChallenge(tokenHash) {
  const client = getSupabaseStorageClient();
  const { error } = await client.from('otp_challenges').delete().eq('challenge_token_hash', tokenHash);
  if (error) throw normalizeError(error, 'Failed to delete OTP challenge');
}

async function recordLoginAttempt(row) {
  const client = getSupabaseStorageClient();
  const { error } = await client.from('login_attempts').insert({
    user_id: row.userId ? String(row.userId) : null, username: row.username || '', name: row.name || '',
    email: row.email || '', role: row.role || '', outcome: row.outcome,
    reason: row.reason || '', ip_address: row.ipAddress || '', user_agent: row.userAgent || '',
  });
  if (error) throw normalizeError(error, 'Failed to record login attempt');
}

function applyLoginAttemptFilters(query, { search = '', outcome = '', role = '', createdSince = null } = {}) {
  let filtered = query;
  if (outcome === 'success' || outcome === 'failed') filtered = filtered.eq('outcome', outcome);
  if (role) filtered = filtered.eq('role', role);
  if (createdSince) filtered = filtered.gte('created_at', new Date(createdSince).toISOString());

  const normalizedSearch = String(search || '')
    .trim()
    .slice(0, 100)
    .replace(/[,().%_]/g, ' ')
    .replace(/\s+/g, ' ');
  if (normalizedSearch) {
    const pattern = `*${normalizedSearch}*`;
    filtered = filtered.or([
      `username.ilike.${pattern}`,
      `name.ilike.${pattern}`,
      `email.ilike.${pattern}`,
      `ip_address.ilike.${pattern}`,
      `reason.ilike.${pattern}`,
    ].join(','));
  }
  return filtered;
}

function mapLoginAttempt(row) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id || null,
    username: row.username || '',
    name: row.name || '',
    email: row.email || '',
    role: row.role || '',
    outcome: row.outcome || 'failed',
    reason: row.reason || '',
    ipAddress: row.ip_address || '',
    userAgent: row.user_agent || '',
    createdAt: row.created_at || null,
    updatedAt: row.created_at || null,
  };
}

async function countLoginAttempts(filters = {}) {
  const query = applyLoginAttemptFilters(
    getSupabaseStorageClient().from('login_attempts').select('id', { count: 'exact', head: true }),
    filters
  );
  const { count, error } = await query;
  if (error) throw normalizeError(error, 'Failed to count login attempts');
  return Number(count || 0);
}

async function listLoginAttempts({ search = '', outcome = '', role = '', page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const baseFilters = { search, outcome, role };
  const last24Hours = new Date(Date.now() - (24 * 60 * 60 * 1000));

  const [total, successCount, failedCount, recentAttempts] = await Promise.all([
    countLoginAttempts(baseFilters),
    countLoginAttempts({ ...baseFilters, outcome: 'success' }),
    countLoginAttempts({ ...baseFilters, outcome: 'failed' }),
    countLoginAttempts({ ...baseFilters, createdSince: last24Hours }),
  ]);
  const totalPages = Math.max(Math.ceil(total / safePageSize), 1);
  const resolvedPage = Math.min(safePage, totalPages);
  const offset = (resolvedPage - 1) * safePageSize;
  const query = applyLoginAttemptFilters(
    getSupabaseStorageClient().from('login_attempts').select('*'),
    baseFilters
  ).order('created_at', { ascending: false })
    .range(offset, offset + safePageSize - 1);
  const { data, error } = await query;
  if (error) throw normalizeError(error, 'Failed to read login attempts');

  return {
    attempts: (data || []).map(mapLoginAttempt),
    summary: { total, successCount, failedCount, recentAttempts },
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

module.exports = {
  consumeOpenChallenges, createChallenge, createSession, deleteChallenge, findActiveChallenge, findOpenChallenge,
  findActiveSession, listActiveSessions, listLoginAttempts, recordLoginAttempt, revokeSession,
  revokeNonAdminSessions, revokeUserSessions, saveChallenge, sessionExists, touchSession,
};
