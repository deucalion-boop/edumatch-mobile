const {
  listActiveSessions,
  revokeSession: revokePersistedSession,
} = require('../services/supabaseAuthPersistenceService');
const { sendSuccess } = require('../utils/responseHelper');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await listActiveSessions(req.user._id);
  return sendSuccess(res, 200, 'Active sessions fetched', {
    sessions: sessions.map((session) => ({
      id: session._id,
      current: String(session.tokenId) === String(req.session?.tokenId || ''),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      remember: session.remember,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    })),
  });
});

const revokeSession = asyncHandler(async (req, res) => {
  const session = await revokePersistedSession(req.user._id, req.params.id, 'Revoked by user');
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  return sendSuccess(res, 200, 'Session revoked');
});

const logout = asyncHandler(async (req, res) => {
  if (req.session?._id) {
    await revokePersistedSession(req.user._id, req.session._id, 'Logout');
  }
  return sendSuccess(res, 200, 'Logged out successfully');
});

module.exports = { listSessions, logout, revokeSession };
