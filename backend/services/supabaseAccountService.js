const { assertGmailEmail } = require('../utils/emailPolicy');
const { revokeUserSessions, consumeOpenChallenges } = require('./supabaseAuthPersistenceService');
const bcrypt = require('bcryptjs');
const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { USER_ROLES } = require('../constants/userRoles');
const { assertPasswordMeetsPolicy } = require('../utils/passwordPolicy');

const ACCOUNT_STATUSES = ['pending', 'active', 'inactive', 'suspended'];

function accountError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function toIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim() || null;
}

function toRow(account, passwordHash) {
  const role = String(account.role || '').trim().toLowerCase();
  const status = String(account.status || 'active').trim().toLowerCase();
  if (!USER_ROLES.includes(role)) throw accountError(null, 'Invalid user role');
  if (!ACCOUNT_STATUSES.includes(status)) throw accountError(null, 'Invalid account status');

  return {
    ...(account._id || account.id ? { id: String(account._id || account.id) } : {}),
    name: String(account.name || '').trim(),
    email: assertGmailEmail(account.email),
    username: String(account.username || '').trim(),
    password_hash: passwordHash || null,
    role,
    status,
    strand: String(account.strand || ''),
    subject: String(account.subject || ''),
    department: String(account.department || ''),
    grade_level: String(account.gradeLevel || ''),
    contact_number: String(account.contactNumber || ''),
    profile_image: String(account.profileImage || ''),
    section_id: referenceId(account.sectionId),
    advisory_section_id: referenceId(account.advisorySectionId),
    managed_by: referenceId(account.managedBy),
    force_password_change: account.forcePasswordChange === true,
    temporary_password_issued_at: toIso(account.temporaryPasswordIssuedAt),
    has_completed_teacher_tour: account.hasCompletedTeacherTour === true,
    has_completed_student_tour: account.hasCompletedStudentTour === true,
    failed_login_attempts: Number(account.failedLoginAttempts || 0),
    lock_until: toIso(account.lockUntil),
    last_login_at: toIso(account.lastLoginAt),
    last_activity_at: toIso(account.lastActivityAt),
    token_version: Number(account.tokenVersion || 0),
    invite: account.invite || {},
    reset_password: account.resetPassword || {},
    enrollment: account.enrollment || {},
    archive: account.archive || { isArchived: false },
    updated_at: new Date().toISOString(),
  };
}

function fromRow(row) {
  if (!row) return null;
  const account = {
    _id: row.id,
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    password: row.password_hash || '',
    role: row.role,
    status: row.status,
    strand: row.strand || '',
    subject: row.subject || '',
    department: row.department || '',
    gradeLevel: row.grade_level || '',
    contactNumber: row.contact_number || '',
    profileImage: row.profile_image || '',
    sectionId: row.section_id || undefined,
    advisorySectionId: row.advisory_section_id || undefined,
    managedBy: row.managed_by || null,
    forcePasswordChange: row.force_password_change === true,
    temporaryPasswordIssuedAt: row.temporary_password_issued_at || null,
    hasCompletedTeacherTour: row.has_completed_teacher_tour === true,
    hasCompletedStudentTour: row.has_completed_student_tour === true,
    failedLoginAttempts: Number(row.failed_login_attempts || 0),
    lockUntil: row.lock_until || null,
    lastLoginAt: row.last_login_at || null,
    lastActivityAt: row.last_activity_at || null,
    tokenVersion: Number(row.token_version || 0),
    invite: row.invite || {},
    resetPassword: row.reset_password || {},
    enrollment: row.enrollment || {},
    archive: row.archive || { isArchived: false },
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };

  Object.defineProperty(account, 'save', {
    enumerable: false,
    value: async () => saveSupabaseAccount(account),
  });
  Object.defineProperty(account, 'comparePassword', {
    enumerable: false,
    value: (plainPassword) => bcrypt.compare(String(plainPassword || ''), String(account.password || '')),
  });
  return account;
}

async function saveSupabaseAccount(account) {
  let passwordHash = String(account.password || '').trim();
  if (passwordHash && !/^\$2[aby]\$\d{2}\$/.test(passwordHash)) {
    passwordHash = await bcrypt.hash(passwordHash, 10);
  }
  const row = toRow(account, passwordHash);
  const existing = row.id ? await findSupabaseAccount('id', row.id) : null;
  if (existing && existing.email !== row.email) {
    row.token_version = Math.max(row.token_version, existing.tokenVersion) + 1;
    await Promise.all([revokeUserSessions(row.id, 'Email address changed; verification required'), consumeOpenChallenges(row.id)]);
  }
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('users').upsert(row, { onConflict: 'id' }).select('*').single();
  if (error) throw accountError(error, 'Failed to save account in Supabase');
  Object.assign(account, fromRow(data));
  return account;
}

async function createSupabaseAccount(payload) {
  const account = { ...payload };
  let passwordHash = String(payload.password || '').trim();
  if (passwordHash) passwordHash = await bcrypt.hash(passwordHash, 10);
  const row = toRow(account, passwordHash);
  delete row.id;
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('users').insert(row).select('*').single();
  if (error) throw accountError(error, 'Failed to create account in Supabase');
  return fromRow(data);
}

async function touchSupabaseAccountActivity(userId, lastActivityAt = new Date()) {
  const client = getSupabaseStorageClient();
  const { error } = await client.from('users').update({
    last_activity_at: new Date(lastActivityAt).toISOString(),
  }).eq('id', String(userId));
  if (error) throw accountError(error, 'Failed to update account activity in Supabase');
}

async function findSupabaseAccount(field, value) {
  const allowedFields = new Set(['id', 'email', 'username', 'role', 'department']);
  if (!allowedFields.has(field)) throw accountError(null, 'Unsupported account lookup');
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const client = getSupabaseStorageClient();
  const query = client.from('users').select('*').eq(field, field === 'email' ? normalized.toLowerCase() : normalized).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw accountError(error, 'Failed to read account from Supabase');
  return fromRow(data);
}

const findSupabaseAccountByEmail = (email) => findSupabaseAccount('email', email);
const findSupabaseAccountByUsername = (username) => findSupabaseAccount('username', username);

async function findSupabaseHeadTeacherByDepartment(department) {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('users').select('*')
    .eq('role', 'headteacher').eq('department', String(department || '').trim()).limit(1).maybeSingle();
  if (error) throw accountError(error, 'Failed to check department assignment');
  return fromRow(data);
}

async function listSupabaseAccounts() {
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('users').select('*').order('created_at', { ascending: false });
  if (error) throw accountError(error, 'Failed to list accounts from Supabase');
  const accounts = (data || []).map(fromRow);
  const accountsById = new Map(accounts.map((account) => [String(account._id), account]));
  return accounts.map((account) => {
    const manager = account.managedBy ? accountsById.get(String(account.managedBy)) : null;
    if (manager) {
      account.managedBy = { _id: manager._id, id: manager._id, name: manager.name, email: manager.email };
    }
    return account;
  });
}

async function findSupabaseAccountByJsonToken(column, tokenHash) {
  const allowedColumns = new Set(['invite', 'reset_password']);
  if (!allowedColumns.has(column)) throw accountError(null, 'Unsupported token lookup');
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('users').select('*')
    .eq(`${column}->>tokenHash`, String(tokenHash || '')).limit(1).maybeSingle();
  if (error) throw accountError(error, 'Failed to read account token from Supabase');
  return fromRow(data);
}

async function ensureDefaultSupabaseAdmin({ name, email, username, password }) {
  const existingAdmin = await findSupabaseAccount('role', 'admin');
  if (existingAdmin) return existingAdmin;

  const initialPassword = String(password || '').trim();
  if (!initialPassword) {
    throw accountError(null, 'ADMIN_PASSWORD must be explicitly configured to create the first administrator');
  }
  assertPasswordMeetsPolicy(initialPassword);

  const [emailAccount, usernameAccount] = await Promise.all([
    findSupabaseAccountByEmail(email),
    findSupabaseAccountByUsername(username),
  ]);
  if (emailAccount || usernameAccount) {
    throw accountError({ code: '23505' }, 'Administrator bootstrap email or username is already assigned to an existing account');
  }

  try {
    return await createSupabaseAccount({
      name, email, username, password: initialPassword,
      role: 'admin', status: 'active', forcePasswordChange: true,
    });
  } catch (error) {
    // Concurrent server starts can race to insert the same initial account.
    if (error.code === '23505') {
      const concurrentAdmin = await findSupabaseAccount('role', 'admin');
      if (concurrentAdmin) return concurrentAdmin;
    }
    throw error;
  }
}

async function deleteSupabaseAccount(id) {
  const { error } = await getSupabaseStorageClient().from('users').delete().eq('id', String(id));
  if (error) throw accountError(error, 'Failed to delete account from Supabase');
}

module.exports = {
  deleteSupabaseAccount,
  createSupabaseAccount,
  ensureDefaultSupabaseAdmin,
  findSupabaseAccount,
  findSupabaseAccountByEmail,
  findSupabaseAccountByUsername,
  findSupabaseHeadTeacherByDepartment,
  findSupabaseAccountByJsonToken,
  listSupabaseAccounts,
  saveSupabaseAccount,
  touchSupabaseAccountActivity,
};
