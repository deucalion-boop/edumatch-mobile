const { getSupabaseStorageClient } = require('./supabaseStorageService');

const DEFAULT_STUDENT_SETTINGS = Object.freeze({
  notifications: {
    announcements: true,
    lessons: true,
    deadlines: true,
    results: true,
    enrollment: true,
    inApp: true,
  },
  learning: { deadlineReminder: 'one-day' },
  appearance: { theme: 'system', textSize: 'normal', highContrast: false, reduceMotion: false },
});

const BOOLEAN_NOTIFICATION_KEYS = Object.keys(DEFAULT_STUDENT_SETTINGS.notifications);
const DEADLINE_REMINDERS = new Set(['none', 'same-day', 'one-day', 'three-days']);
const THEMES = new Set(['system', 'light', 'dark']);
const TEXT_SIZES = new Set(['normal', 'large', 'larger']);

function settingsError(error, fallback) {
  const normalized = new Error(String(error?.message || fallback));
  normalized.code = error?.code;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function normalizeSettings(value = {}) {
  const sourceNotifications = value.notifications || value.notification_preferences || {};
  const sourceLearning = value.learning || value.learning_preferences || {};
  const sourceAppearance = value.appearance || {};
  const notifications = { ...DEFAULT_STUDENT_SETTINGS.notifications };
  BOOLEAN_NOTIFICATION_KEYS.forEach((key) => {
    if (typeof sourceNotifications[key] === 'boolean') notifications[key] = sourceNotifications[key];
  });
  return {
    notifications,
    learning: {
      deadlineReminder: DEADLINE_REMINDERS.has(sourceLearning.deadlineReminder)
        ? sourceLearning.deadlineReminder
        : DEFAULT_STUDENT_SETTINGS.learning.deadlineReminder,
    },
    appearance: {
      theme: THEMES.has(sourceAppearance.theme) ? sourceAppearance.theme : DEFAULT_STUDENT_SETTINGS.appearance.theme,
      textSize: TEXT_SIZES.has(sourceAppearance.textSize) ? sourceAppearance.textSize : DEFAULT_STUDENT_SETTINGS.appearance.textSize,
      highContrast: sourceAppearance.highContrast === true,
      reduceMotion: sourceAppearance.reduceMotion === true,
    },
  };
}

function mapSettingsRow(row) {
  const settings = normalizeSettings(row);
  return { ...settings, updatedAt: row?.updated_at || null };
}

async function getStudentSettings(studentId) {
  const id = String(studentId || '').trim();
  if (!id) throw Object.assign(new Error('Student ID is required'), { statusCode: 400 });
  const { data, error } = await getSupabaseStorageClient().from('student_settings')
    .select('*').eq('student_id', id).maybeSingle();
  if (error) throw settingsError(error, 'Failed to load student settings');
  return data ? mapSettingsRow(data) : { ...normalizeSettings(), updatedAt: null };
}

async function saveStudentSettings(studentId, payload) {
  const id = String(studentId || '').trim();
  if (!id) throw Object.assign(new Error('Student ID is required'), { statusCode: 400 });
  const normalized = normalizeSettings(payload);
  const row = {
    student_id: id,
    notification_preferences: normalized.notifications,
    learning_preferences: normalized.learning,
    appearance: normalized.appearance,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseStorageClient().from('student_settings')
    .upsert(row, { onConflict: 'student_id' }).select('*').single();
  if (error) throw settingsError(error, 'Failed to save student settings');
  return mapSettingsRow(data);
}

function mapAccountRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    studentEmail: row.student_email,
    action: row.action,
    reason: row.reason,
    status: row.status,
    reviewerId: row.reviewer_id,
    reviewerNote: row.reviewer_note,
    reviewedAt: row.reviewed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getLatestAccountRequest(studentId) {
  const { data, error } = await getSupabaseStorageClient().from('student_account_requests')
    .select('*').eq('student_id', String(studentId)).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw settingsError(error, 'Failed to load account request');
  return mapAccountRequest(data);
}

async function getAccountRequestById(requestId) {
  const { data, error } = await getSupabaseStorageClient().from('student_account_requests')
    .select('*').eq('id', String(requestId)).maybeSingle();
  if (error) throw settingsError(error, 'Failed to load account request');
  return mapAccountRequest(data);
}

async function createAccountRequest({ student, action, reason }) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['deactivate', 'delete'].includes(normalizedAction)) {
    throw Object.assign(new Error('Choose a valid account action'), { statusCode: 400 });
  }
  const normalizedReason = String(reason || '').trim();
  if (normalizedReason.length < 10) {
    throw Object.assign(new Error('Please provide a reason of at least 10 characters'), { statusCode: 400 });
  }
  const row = {
    student_id: String(student?._id || student?.id),
    student_name: String(student?.name || student?.username || 'Student').trim(),
    student_email: String(student?.email || '').trim(),
    action: normalizedAction,
    reason: normalizedReason.slice(0, 1000),
  };
  const { data, error } = await getSupabaseStorageClient().from('student_account_requests').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') throw Object.assign(new Error('You already have an account request awaiting review'), { statusCode: 409 });
    throw settingsError(error, 'Failed to submit account request');
  }
  return mapAccountRequest(data);
}

async function listAccountRequests(limit = 100) {
  const { data, error } = await getSupabaseStorageClient().from('student_account_requests')
    .select('*').order('created_at', { ascending: false }).limit(Math.min(200, Math.max(1, Number(limit) || 100)));
  if (error) throw settingsError(error, 'Failed to list student account requests');
  return (data || []).map(mapAccountRequest);
}

async function reviewAccountRequest({ requestId, reviewerId, decision, note = '' }) {
  const status = String(decision || '').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(status)) throw Object.assign(new Error('Invalid review decision'), { statusCode: 400 });
  const client = getSupabaseStorageClient();
  const now = new Date().toISOString();
  const { data, error } = await client.from('student_account_requests').update({
    status,
    reviewer_id: String(reviewerId),
    reviewer_note: String(note || '').trim().slice(0, 1000),
    reviewed_at: now,
    updated_at: now,
  }).eq('id', String(requestId)).eq('status', 'pending').select('*').maybeSingle();
  if (error) throw settingsError(error, 'Failed to review account request');
  if (!data) throw Object.assign(new Error('Pending account request not found'), { statusCode: 404 });
  return mapAccountRequest(data);
}

async function completeAccountRequest(requestId) {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseStorageClient().from('student_account_requests').update({
    status: 'completed', completed_at: now, updated_at: now,
  }).eq('id', String(requestId)).eq('status', 'approved').select('*').maybeSingle();
  if (error) throw settingsError(error, 'Failed to complete account request');
  return mapAccountRequest(data);
}

module.exports = {
  DEFAULT_STUDENT_SETTINGS,
  completeAccountRequest,
  createAccountRequest,
  getAccountRequestById,
  getLatestAccountRequest,
  getStudentSettings,
  listAccountRequests,
  normalizeSettings,
  reviewAccountRequest,
  saveStudentSettings,
};
