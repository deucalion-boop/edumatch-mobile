const { createAuditLog } = require('../services/supabaseAuditLogService');

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CATEGORY_LABELS = {
  auth: 'Authentication',
  admin: 'Admin',
  teacher: 'Teacher',
  student: 'Student',
  headteacher: 'Head Teacher',
  secretary: 'Secretary',
  recommendation: 'Recommendation',
  notifications: 'Notifications',
  users: 'Users',
  storage: 'Storage',
};

const ACTION_LABELS = {
  'POST /api/auth/login': 'User login',
  'POST /api/auth/change-password': 'Password changed',
  'POST /api/auth/invite/:token/complete': 'Invite completed',
  'POST /api/auth/forgot-password': 'Password reset requested',
  'POST /api/auth/reset/:token/complete': 'Password reset completed',
  'POST /api/admin/users': 'User created',
  'PUT /api/admin/users/:id': 'User updated',
  'DELETE /api/admin/users/:id': 'User deleted',
  'POST /api/admin/users/:id/messages': 'Admin message sent',
  'POST /api/admin/users/:id/send-invite': 'User invite sent',
  'POST /api/secretary/users': 'User created',
  'PUT /api/secretary/users/:id': 'User updated',
  'DELETE /api/secretary/users/:id': 'User deleted',
  'POST /api/secretary/users/:id/messages': 'Secretary message sent',
  'POST /api/secretary/users/:id/send-invite': 'User invite sent',
  'PATCH /api/admin/export-requests/:id/review': 'Export request reviewed',
  'PATCH /api/admin/student-account-requests/:id/review': 'Student account request reviewed',
  'PUT /api/admin/settings/security': 'Security settings updated',
  'PUT /api/admin/settings/system': 'System settings updated',
  'POST /api/admin/settings/system/clear-cache': 'System cache cleared',
  'POST /api/teacher/lessons': 'Lesson created',
  'POST /api/teacher/subjects': 'Subject created',
  'PATCH /api/teacher/subjects/:subjectId': 'Subject updated',
  'DELETE /api/teacher/subjects/:subjectId': 'Subject deleted',
  'POST /api/teacher/assessments': 'Assessment created',
  'PUT /api/teacher/assessments/:id/questions': 'Assessment updated',
  'POST /api/teacher/students': 'Student invite created',
  'DELETE /api/teacher/subjects/:subjectId/students/:studentId': 'Student removed from subject',
  'PATCH /api/teacher/enrollment-requests/:studentId/accept': 'Enrollment request approved',
  'PATCH /api/teacher/enrollment-requests/:studentId/reject': 'Enrollment request rejected',
  'POST /api/teacher/attendance': 'Attendance saved',
  'PATCH /api/teacher/attendance/:id/lock': 'Attendance locked',
  'PUT /api/teacher/profile': 'Teacher profile updated',
  'PATCH /api/teacher/tour-preference': 'Teacher tour preference updated',
  'POST /api/teacher/assessments/ai-generate': 'AI assessment generated',
  'PUT /api/student/profile': 'Student profile updated',
  'PATCH /api/student/tour-preference': 'Student tour preference updated',
  'PUT /api/student/settings': 'Student settings updated',
  'POST /api/student/account-requests': 'Student account request submitted',
  'POST /api/student/subjects/join': 'Subject join requested',
  'POST /api/student/assessments/:id/start': 'Assessment started',
  'PATCH /api/student/assessments/:id/progress': 'Assessment progress saved',
  'POST /api/student/assessments/:id/activity': 'Assessment activity logged',
  'POST /api/student/assessments/:id/submissions': 'Assessment submitted',
  'POST /api/student/assessments/:id/activity-response/draft': 'Activity draft saved',
  'POST /api/student/assessments/:id/activity-response/submit': 'Activity submitted',
  'POST /api/student/assessments/:id/activity-response/unsubmit': 'Activity unsubmitted',
  'POST /api/headteacher/lessons': 'Managed lesson created',
  'POST /api/headteacher/assessments': 'Managed assessment created',
  'PUT /api/headteacher/assessments/:id': 'Managed assessment updated',
  'POST /api/headteacher/assessments/ai-generate': 'Managed AI assessment generated',
  'POST /api/headteacher/teachers': 'Teacher account created',
  'POST /api/headteacher/students': 'Student account created',
  'PUT /api/headteacher/teachers/:id': 'Managed teacher updated',
  'POST /api/secretary/students/archived/export-requests': 'Archived PDF export requested',
  'POST /api/secretary/students/archived/export-requests/:id/consume': 'Archived PDF approval consumed',
  'POST /api/secretary/students/end-school-year': 'School year archive completed',
  'POST /api/recommendation/recompute/:studentId': 'Recommendation recomputed',
  'DELETE /api/notifications': 'Notifications cleared',
  'PATCH /api/notifications/view-all': 'Notifications marked viewed',
  'PATCH /api/notifications/:id/view': 'Notification viewed',
  'POST /api/users/create-and-invite': 'User created and invited',
};

function truncate(value, maxLength = 200) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeClientIpAddress(req) {
  return truncate(String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, ''), 120);
}

function normalizeRoutePath(req) {
  if (typeof req.route?.path === 'string') return req.route.path;
  return String(req.path || req.originalUrl || '')
    .split('?')[0]
    .trim();
}

function normalizeEndpoint(req) {
  const baseUrl = String(req.baseUrl || '').trim();
  const routePath = normalizeRoutePath(req);
  const normalizedPath = `${baseUrl}${routePath}`.trim();
  if (normalizedPath) return normalizedPath;
  return String(req.originalUrl || '').split('?')[0].trim();
}

function normalizeCategory(endpoint) {
  const topLevelSegment = String(endpoint || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)[1] || '';
  return CATEGORY_LABELS[topLevelSegment] || 'System';
}

function humanizeSegment(value = '') {
  const normalized = String(value || '').replace(/[-_]/g, ' ').trim();
  if (!normalized) return 'System action';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildFallbackActionLabel(method, endpoint) {
  const segments = String(endpoint || '')
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean)
    .filter((segment) => !segment.startsWith(':'));

  const resource = humanizeSegment(segments.slice(1).join(' '));
  if (method === 'POST') return `${resource} created`;
  if (method === 'PUT') return `${resource} updated`;
  if (method === 'PATCH') return `${resource} modified`;
  if (method === 'DELETE') return `${resource} deleted`;
  return resource;
}

function buildActionLabel(req, endpoint) {
  if (req.auditLogContext?.actionLabel) {
    return truncate(req.auditLogContext.actionLabel, 200);
  }

  const lookupKey = `${String(req.method || '').toUpperCase()} ${endpoint}`;
  return ACTION_LABELS[lookupKey] || buildFallbackActionLabel(String(req.method || '').toUpperCase(), endpoint);
}

function sanitizeObjectEntries(value, maxEntries = 12) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, maxEntries)
      .map(([key, itemValue]) => [truncate(key, 80), truncate(itemValue, 120)])
  );
}

function buildMetadata(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const bodyKeys = Object.keys(body)
    .filter((key) => !['password', 'newPassword', 'currentPassword', 'confirmPassword', 'captchaToken', 'token'].includes(key))
    .slice(0, 20)
    .map((key) => truncate(key, 80));

  const fileCount = Array.isArray(req.files)
    ? req.files.length
    : req.file
      ? 1
      : req.files && typeof req.files === 'object'
        ? Object.values(req.files).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0)
        : 0;

  return {
    params: sanitizeObjectEntries(req.params),
    query: sanitizeObjectEntries(req.query),
    bodyKeys,
    fileCount,
  };
}

function buildActorSnapshot(req) {
  const override = req.auditLogContext || {};
  const actorUserId = override.actorUserId || req.user?._id || null;
  const actorName = truncate(override.actorName || req.user?.name || '', 200);
  const actorEmail = truncate(override.actorEmail || req.user?.email || req.body?.email || '', 200).toLowerCase();
  const actorRole = truncate(override.actorRole || req.user?.role || '', 50).toLowerCase();
  const actorIdentifier = truncate(
    override.actorIdentifier ||
      req.user?.username ||
      req.body?.username ||
      req.body?.email ||
      actorEmail ||
      actorName,
    200
  );

  return {
    actorUserId,
    actorName,
    actorEmail,
    actorRole,
    actorIdentifier,
  };
}

function buildTargetSnapshot(req) {
  const override = req.auditLogContext || {};
  const targetId = truncate(
    override.targetId ||
      req.params?.id ||
      req.params?.studentId ||
      req.params?.subjectId ||
      req.params?.assessmentId ||
      req.params?.attachmentId ||
      '',
    160
  );
  const targetLabel = truncate(
    override.targetLabel ||
      req.body?.name ||
      req.body?.title ||
      req.body?.username ||
      req.body?.email ||
      req.body?.className ||
      req.body?.subject ||
      targetId,
    220
  );

  return {
    targetId,
    targetLabel,
  };
}

function shouldAuditRequest(req) {
  if (req.auditLogSkip === true) return false;
  if (!AUDITED_METHODS.has(String(req.method || '').toUpperCase())) return false;
  const originalPath = String(req.originalUrl || '').split('?')[0];
  if (!originalPath.startsWith('/api/')) return false;
  if (originalPath === '/api/health') return false;
  return true;
}

function auditLogMiddleware(req, res, next) {
  const startedAt = Date.now();

  res.on('finish', () => {
    if (!shouldAuditRequest(req)) return;

    const endpoint = normalizeEndpoint(req);
    const actor = buildActorSnapshot(req);
    const target = buildTargetSnapshot(req);

    const payload = {
      ...actor,
      category: normalizeCategory(endpoint),
      actionLabel: buildActionLabel(req, endpoint),
      method: truncate(String(req.method || '').toUpperCase(), 10),
      endpoint: truncate(endpoint, 220),
      routePath: truncate(normalizeRoutePath(req), 220),
      ...target,
      succeeded: Number(res.statusCode || 0) < 400,
      statusCode: Number(res.statusCode || 0),
      ipAddress: normalizeClientIpAddress(req),
      userAgent: truncate(req.headers['user-agent'], 500),
      durationMs: Math.max(Date.now() - startedAt, 0),
      metadata: buildMetadata(req),
    };

    setImmediate(() => {
      createAuditLog(payload).catch((error) => {
        console.error('[auditLogMiddleware] Failed to record audit log:', error);
      });
    });
  });

  next();
}

module.exports = auditLogMiddleware;
