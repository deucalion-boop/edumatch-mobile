const { sendSuccess } = require('../utils/responseHelper');
const {
  clearNotifications,
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsViewed: markAllViewedInSupabase,
  markNotificationViewed: markViewedInSupabase,
} = require('../services/supabaseNotificationService');
const { getStudentSettings } = require('../services/studentSettingsService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const NOTIFICATION_TYPES_BY_PREFERENCE = {
  announcements: ['announcement_published'],
  lessons: ['lesson_published', 'activity_assigned', 'assessment_assigned', 'activity_submitted', 'assessment_submitted'],
  deadlines: ['deadline_upcoming'],
  results: ['grade_released', 'grade_updated', 'teacher_feedback', 'recommendation_ready', 'recommendation_progress'],
  enrollment: ['enrollment_approved', 'enrollment_rejected', 'enrollment_updated'],
};

async function getNotificationVisibility(recipientId, recipientRole) {
  if (recipientRole !== 'student') return { enabled: true, excludedTypes: [] };
  const settings = await getStudentSettings(recipientId);
  const excludedTypes = Object.entries(NOTIFICATION_TYPES_BY_PREFERENCE)
    .filter(([key]) => settings.notifications[key] === false)
    .flatMap(([, types]) => types);
  return { enabled: settings.notifications.inApp !== false, excludedTypes };
}

function normalizeNotification(notification) {
  return {
    id: notification._id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    subject: notification.subject,
    preview: notification.preview,
    senderName: notification.senderName,
    senderRole: notification.senderRole,
    urgent: notification.urgent === true,
    isViewed: notification.isViewed === true,
    viewedAt: notification.viewedAt || null,
    createdAt: notification.createdAt || null,
    messageId: notification.messageId || null,
    meta: notification.meta && typeof notification.meta === 'object' ? notification.meta : {},
  };
}

const getMyNotifications = asyncHandler(async (req, res) => {
  const requestedLimit = Number(req.query.limit || 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 10));
  const recipientId = req.user._id;
  const recipientRole = String(req.user.role || '').trim().toLowerCase();
  const visibility = await getNotificationVisibility(recipientId, recipientRole);

  if (!visibility.enabled) {
    return sendSuccess(res, 200, 'In-app notifications are disabled', { notifications: [], unreadCount: 0 });
  }

  const [notifications, unreadCount] = await Promise.all([
    listNotifications({ recipientId, recipientRole, limit, excludedTypes: visibility.excludedTypes }),
    countUnreadNotifications({ recipientId, recipientRole, excludedTypes: visibility.excludedTypes }),
  ]);

  return sendSuccess(res, 200, 'Notifications fetched successfully', {
    notifications: notifications.map(normalizeNotification),
    unreadCount,
  });
});

const markAllNotificationsViewed = asyncHandler(async (req, res) => {
  const recipientId = req.user._id;
  const recipientRole = String(req.user.role || '').trim().toLowerCase();
  const visibility = await getNotificationVisibility(recipientId, recipientRole);
  await markAllViewedInSupabase({ recipientId, recipientRole });

  return sendSuccess(res, 200, 'Notifications marked as viewed', {
    unreadCount: visibility.enabled
      ? await countUnreadNotifications({ recipientId, recipientRole, excludedTypes: visibility.excludedTypes })
      : 0,
  });
});

const markNotificationViewed = asyncHandler(async (req, res) => {
  const recipientRole = String(req.user.role || '').trim().toLowerCase();
  const visibility = await getNotificationVisibility(req.user._id, recipientRole);
  const notification = await markViewedInSupabase({
    id: req.params.id,
    recipientId: req.user._id,
    recipientRole,
  });

  if (!notification) {
    const error = new Error('Notification not found');
    error.statusCode = 404;
    throw error;
  }

  return sendSuccess(res, 200, 'Notification marked as viewed', {
    notification: normalizeNotification(notification),
    unreadCount: visibility.enabled
      ? await countUnreadNotifications({ recipientId: req.user._id, recipientRole, excludedTypes: visibility.excludedTypes })
      : 0,
  });
});

const clearAllNotifications = asyncHandler(async (req, res) => {
  const recipientId = req.user._id;
  const recipientRole = String(req.user.role || '').trim().toLowerCase();

  const deletedCount = await clearNotifications({ recipientId, recipientRole });

  return sendSuccess(res, 200, 'Notifications cleared successfully', {
    deletedCount,
    unreadCount: 0,
  });
});

module.exports = {
  getMyNotifications,
  markAllNotificationsViewed,
  markNotificationViewed,
  clearAllNotifications,
};
