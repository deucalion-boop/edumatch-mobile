const jwt = require('jsonwebtoken');
const { findSupabaseAccount, touchSupabaseAccountActivity } = require('../services/supabaseAccountService');
const { findActiveSession, revokeSession, touchSession } = require('../services/supabaseAuthPersistenceService');
const { getAppSettings } = require('../services/supabaseSettingsService');

async function authMiddleware(req, _res, next) {
  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      const error = new Error('Authorization token is required');
      error.statusCode = 401;
      throw error;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'edumatch-api',
      audience: 'edumatch-web',
    });

    const user = await findSupabaseAccount('id', decoded.id);

    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 401;
      throw error;
    }

    if (!decoded.jti || Number(decoded.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      const error = new Error('Session has been revoked');
      error.statusCode = 401;
      throw error;
    }

    const session = await findActiveSession(user._id, decoded.jti);
    if (!session) {
      const error = new Error('Session has been revoked');
      error.statusCode = 401;
      throw error;
    }

    if (user.status === 'pending' || user.status === 'inactive' || user.status === 'suspended') {
      const error = new Error(
        user.status === 'pending'
          ? 'Your account is pending activation'
          :
        user.status === 'suspended' ? 'Your account is suspended' : 'Your account is inactive'
      );
      error.statusCode = 403;
      throw error;
    }

    const authRoute = String(req.baseUrl || '').replace(/\/+$/, '') === '/api/auth';
    const routePath = String(req.path || '').replace(/\/+$/, '');
    const isPresenceRequest = authRoute && req.method === 'POST' && routePath === '/presence';
    const isAccountSecurityRequest = authRoute && (
      (req.method === 'POST' && ['/change-password', '/logout'].includes(routePath))
      || (req.method === 'GET' && routePath === '/sessions')
      || (req.method === 'DELETE' && /^\/sessions\/[^/]+$/.test(routePath))
    );

    if (user.forcePasswordChange === true && !isAccountSecurityRequest && !isPresenceRequest) {
      const error = new Error('Password change required before continuing');
      error.statusCode = 403;
      throw error;
    }

    const settings = await getAppSettings();
    // Remember-me extends the absolute token lifetime, not the inactivity policy.
    const { sessionTimeoutMinutes } = settings.security;
    const { maintenanceModeEnabled, maintenanceMessage } = settings.maintenance;
    const now = new Date();
    const lastSeenAt = new Date(session.lastSeenAt || session.last_seen_at || session.createdAt || session.created_at);

    if (maintenanceModeEnabled && String(user.role || '').toLowerCase() !== 'admin' && !isAccountSecurityRequest) {
      const error = new Error(maintenanceMessage);
      error.statusCode = 503;
      throw error;
    }

    if (!Number.isFinite(lastSeenAt.getTime()) || now.getTime() - lastSeenAt.getTime() >= sessionTimeoutMinutes * 60 * 1000) {
      await revokeSession(user._id, session._id, 'Inactivity timeout');
      const error = new Error('Session expired due to inactivity. Please sign in again.');
      error.statusCode = 401;
      throw error;
    }

    user.lastActivityAt = now;
    // A background presence heartbeat must not keep an otherwise idle session
    // alive. Updating one presence column also avoids overwriting account changes.
    await Promise.all([
      touchSupabaseAccountActivity(user._id, now),
      ...(isPresenceRequest ? [] : [touchSession(session._id, now)]),
    ]);

    req.user = user;
    req.token = token;
    req.session = session;

    return next();
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 401;
      error.message = 'Invalid or expired token';
    }
    return next(error);
  }
}

module.exports = authMiddleware;
