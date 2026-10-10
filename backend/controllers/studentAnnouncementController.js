const { createHash } = require('node:crypto');
const { requireTeacherSubject } = require('../services/supabaseTeacherStudentsService');
const { approvedStudentsForSubject, createStudentNotifications } = require('../services/studentNotificationService');
const { getSupabaseStorageClient } = require('../services/supabaseStorageService');
const { sendSuccess } = require('../utils/responseHelper');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

exports.publishAnnouncement = wrap(async (req, res) => {
  const subject = await requireTeacherSubject(req.user._id, req.params.subjectId);
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  const requestId = typeof req.body.requestId === 'string' ? req.body.requestId.trim() : '';
  if (!title || title.length > 200 || !content || content.length > 5000 || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) {
    throw fail('A title (1-200 characters), message (1-5000 characters), and valid request ID are required.', 400);
  }
  // A retry has the same event key; distinct posts get new request IDs.
  const eventKey = 'announcement:' + createHash('sha256').update(JSON.stringify([req.user._id, subject.id, requestId, title, content])).digest('hex');
  const recipientIds = await approvedStudentsForSubject(subject.id, req.user._id);
  if (recipientIds.length === 0) {
    throw fail('This subject has no approved students to receive the announcement.', 409);
  }
  await createStudentNotifications({ recipientIds, sender: req.user, type: 'announcement_published', title,
    subject: subject.name, preview: 'A new Announcement has been posted in ' + subject.name + '.', message: content, eventKey,
    meta: { contentType: 'Announcement', content, subjectId: subject.id, route: '/student/announcements?event=' + encodeURIComponent(eventKey) } });
  return sendSuccess(res, 201, 'Announcement posted', { recipientCount: recipientIds.length });
});

function mapAnnouncement(data) {
  return {
    id: data.id,
    eventKey: data.event_key,
    title: data.title,
    content: data.meta?.content || data.message,
    subject: data.subject,
    teacher: data.sender_name,
    createdAt: data.created_at,
  };
}

exports.listAnnouncements = wrap(async (req, res) => {
  if (req.user.role !== 'student') throw fail('Student access required', 403);
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const { data, error } = await getSupabaseStorageClient().from('notifications').select('*')
    .eq('recipient_id', String(req.user._id)).eq('recipient_role', 'student')
    .eq('type', 'announcement_published')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw fail('Unable to load announcements', 500);
  return sendSuccess(res, 200, 'Announcements loaded', {
    announcements: (data || []).map(mapAnnouncement),
  });
});

exports.getAnnouncement = wrap(async (req, res) => {
  if (req.user.role !== 'student') throw fail('Student access required', 403);
  const eventKey = typeof req.query.event === 'string' ? req.query.event : '';
  if (!/^announcement:[a-f0-9]{64}$/.test(eventKey)) throw fail('Invalid announcement ID', 400);
  const { data, error } = await getSupabaseStorageClient().from('notifications').select('*')
    .eq('recipient_id', String(req.user._id)).eq('recipient_role', 'student')
    .eq('type', 'announcement_published').eq('event_key', eventKey).maybeSingle();
  if (error) throw fail('Unable to load announcement', 500);
  if (!data) throw fail('Announcement not found', 404);
  return sendSuccess(res, 200, 'Announcement loaded', { announcement: mapAnnouncement(data) });
});
