const {
  createAdminMessage,
  createNotification,
} = require('./supabaseNotificationService');

function buildMessagePreview(content, maxLength = 120) {
  const normalized = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

async function createAdminMessageNotification({
  sender,
  recipient,
  subject,
  content,
  urgent = false,
}) {
  const preview = buildMessagePreview(content);
  const senderName = String(sender?.name || sender?.username || 'Admin').trim() || 'Admin';
  const senderRole = String(sender?.role || 'admin').trim().toLowerCase();
  const senderLabel = senderRole === 'headteacher'
    ? 'Head Teacher'
    : (senderRole === 'secretary' ? 'Secretary' : 'Admin');

  const messageRecord = await createAdminMessage({
    senderId: sender?._id,
    senderRole,
    senderName,
    recipientId: recipient?._id,
    recipientRole: String(recipient?.role || '').trim().toLowerCase(),
    subject: String(subject || '').trim(),
    content: String(content || '').trim(),
    preview,
    urgent: urgent === true,
  });

  const notificationRecord = await createNotification({
    recipientId: recipient?._id,
    recipientRole: String(recipient?.role || '').trim().toLowerCase(),
    senderId: sender?._id || null,
    senderRole,
    senderName,
    type: senderRole === 'headteacher' ? 'management_message' : 'admin_message',
    title: urgent ? `Urgent message from ${senderLabel}` : `New message from ${senderLabel}`,
    message: `${senderName}: ${String(subject || '').trim()}`,
    subject: String(subject || '').trim(),
    preview,
    urgent: urgent === true,
    isViewed: false,
    viewedAt: null,
    messageId: messageRecord._id,
    eventKey: `admin-message:${messageRecord._id}`,
    meta: {
      source: senderRole === 'headteacher' ? 'headteacher_announcement' : 'admin_messaging_modal',
    },
  });

  return {
    messageRecord,
    notificationRecord,
  };
}

module.exports = {
  buildMessagePreview,
  createAdminMessageNotification,
};
