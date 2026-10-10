const { getSupabaseStorageClient } = require('./supabaseStorageService');

function notificationError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseNotificationError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim() || null;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clean(value, fallback = '') {
  return String(value || '').trim() || fallback;
}

function mapNotification(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    recipientId: row.recipient_id,
    recipientRole: row.recipient_role,
    senderId: row.sender_id || null,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    type: row.type,
    title: row.title,
    message: row.message,
    subject: row.subject,
    preview: row.preview,
    urgent: row.urgent === true,
    isViewed: row.is_viewed === true,
    isCleared: row.is_cleared === true,
    viewedAt: row.viewed_at || null,
    messageId: row.message_id || null,
    eventKey: row.event_key,
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapAdminMessage(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    senderId: row.sender_id || null,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    recipientId: row.recipient_id,
    recipientRole: row.recipient_role,
    subject: row.subject,
    content: row.content,
    preview: row.preview,
    urgent: row.urgent === true,
    readAt: row.read_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function notificationRow(payload) {
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const eventKey = clean(payload.eventKey || meta.eventKey);
  if (!eventKey) throw notificationError(null, 'Notification event key is required');
  return {
    recipient_id: referenceId(payload.recipientId),
    recipient_role: clean(payload.recipientRole).toLowerCase(),
    sender_id: referenceId(payload.senderId),
    sender_role: clean(payload.senderRole, 'system').toLowerCase(),
    sender_name: clean(payload.senderName, 'EduMatch').slice(0, 120),
    type: clean(payload.type, 'user_update').toLowerCase(),
    title: clean(payload.title).slice(0, 220),
    message: clean(payload.message || payload.subject || payload.title).slice(0, 400),
    subject: clean(payload.subject || payload.title).slice(0, 200),
    preview: clean(payload.preview || payload.message || payload.subject || payload.title).slice(0, 220),
    urgent: payload.urgent === true,
    is_viewed: payload.isViewed === true,
    is_cleared: payload.isCleared === true,
    viewed_at: toIso(payload.viewedAt),
    message_id: referenceId(payload.messageId),
    event_key: eventKey,
    meta: { ...meta, eventKey },
    updated_at: new Date().toISOString(),
  };
}

async function createAdminMessage(payload) {
  const row = {
    sender_id: referenceId(payload.senderId),
    sender_role: clean(payload.senderRole, 'admin').toLowerCase(),
    sender_name: clean(payload.senderName, 'Admin'),
    recipient_id: referenceId(payload.recipientId),
    recipient_role: clean(payload.recipientRole).toLowerCase(),
    subject: clean(payload.subject).slice(0, 200),
    content: clean(payload.content).slice(0, 5000),
    preview: clean(payload.preview).slice(0, 220),
    urgent: payload.urgent === true,
    read_at: toIso(payload.readAt),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await getSupabaseStorageClient().from('admin_messages').insert(row).select('*').single();
  if (error) throw notificationError(error, 'Failed to save message in Supabase');
  return mapAdminMessage(data);
}

async function createNotification(payload) {
  const row = notificationRow(payload);
  const { data, error } = await getSupabaseStorageClient().from('notifications').insert(row).select('*').single();
  if (error) throw notificationError(error, 'Failed to save notification in Supabase');
  return mapNotification(data);
}

async function upsertNotification(payload) {
  const row = notificationRow(payload);
  const client = getSupabaseStorageClient();
  const { data, error } = await client.from('notifications').upsert(row, {
    onConflict: 'recipient_id,recipient_role,type,event_key',
    ignoreDuplicates: true,
  }).select('*');
  if (error) throw notificationError(error, 'Failed to save notification in Supabase');
  if (data?.[0]) return mapNotification(data[0]);

  const { data: existing, error: lookupError } = await client.from('notifications').select('*')
    .eq('recipient_id', row.recipient_id)
    .eq('recipient_role', row.recipient_role)
    .eq('type', row.type)
    .eq('event_key', row.event_key)
    .limit(1)
    .maybeSingle();
  if (lookupError) throw notificationError(lookupError, 'Failed to read notification from Supabase');
  return mapNotification(existing);
}

async function upsertNotifications(payloads) {
  const rows = (payloads || []).map(notificationRow);
  if (rows.length === 0) return 0;
  const { data, error } = await getSupabaseStorageClient().from('notifications').upsert(rows, {
    onConflict: 'recipient_id,recipient_role,type,event_key',
    ignoreDuplicates: true,
  }).select('id');
  if (error) throw notificationError(error, 'Failed to save notifications in Supabase');
  return Number(data?.length || 0);
}

function applyExcludedTypes(query, excludedTypes = []) {
  const safeTypes = [...new Set((excludedTypes || []).map((value) => clean(value).toLowerCase()).filter((value) => /^[a-z0-9_]+$/.test(value)))];
  return safeTypes.length ? query.not('type', 'in', `(${safeTypes.join(',')})`) : query;
}

async function listNotifications({ recipientId, recipientRole, limit = 10, excludedTypes = [] }) {
  let query = getSupabaseStorageClient().from('notifications').select('*')
    .eq('recipient_id', referenceId(recipientId))
    .eq('recipient_role', clean(recipientRole).toLowerCase())
    .eq('is_cleared', false);
  query = applyExcludedTypes(query, excludedTypes)
    .order('urgent', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  const { data, error } = await query;
  if (error) throw notificationError(error, 'Failed to read notifications from Supabase');
  return (data || []).map(mapNotification);
}

async function countUnreadNotifications({ recipientId, recipientRole, excludedTypes = [] }) {
  let query = getSupabaseStorageClient().from('notifications').select('id', { count: 'exact', head: true })
    .eq('recipient_id', referenceId(recipientId))
    .eq('recipient_role', clean(recipientRole).toLowerCase())
    .eq('is_viewed', false)
    .eq('is_cleared', false);
  query = applyExcludedTypes(query, excludedTypes);
  const { count, error } = await query;
  if (error) throw notificationError(error, 'Failed to count notifications in Supabase');
  return Number(count || 0);
}

async function markAllNotificationsViewed({ recipientId, recipientRole }) {
  const { error } = await getSupabaseStorageClient().from('notifications').update({
    is_viewed: true,
    viewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('recipient_id', referenceId(recipientId))
    .eq('recipient_role', clean(recipientRole).toLowerCase())
    .eq('is_viewed', false)
    .eq('is_cleared', false);
  if (error) throw notificationError(error, 'Failed to update notifications in Supabase');
}

async function markNotificationViewed({ id, recipientId, recipientRole }) {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseStorageClient().from('notifications').update({
    is_viewed: true,
    viewed_at: now,
    updated_at: now,
  }).eq('id', referenceId(id))
    .eq('recipient_id', referenceId(recipientId))
    .eq('recipient_role', clean(recipientRole).toLowerCase())
    .select('*')
    .maybeSingle();
  if (error) throw notificationError(error, 'Failed to update notification in Supabase');
  return mapNotification(data);
}

async function clearNotifications({ recipientId, recipientRole }) {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseStorageClient().from('notifications').update({
    is_cleared: true,
    is_viewed: true,
    viewed_at: now,
    updated_at: now,
  }).eq('recipient_id', referenceId(recipientId))
    .eq('recipient_role', clean(recipientRole).toLowerCase())
    .eq('is_cleared', false)
    .select('id');
  if (error) throw notificationError(error, 'Failed to clear notifications in Supabase');
  return Number(data?.length || 0);
}

module.exports = {
  clearNotifications,
  countUnreadNotifications,
  createAdminMessage,
  createNotification,
  listNotifications,
  markAllNotificationsViewed,
  markNotificationViewed,
  upsertNotification,
  upsertNotifications,
};
