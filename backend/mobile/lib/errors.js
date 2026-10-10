'use strict';

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertRole(user, ...roles) {
  if (!user?._id && !user?.id) throw fail('Authentication required', 401);
  if (!roles.includes(user.role)) throw fail('Insufficient permissions', 403);
}

function userId(user) { return String(user?._id || user?.id || ''); }

function databaseResult(result) {
  if (result.error) {
    const code = result.error.code;
    const statuses = { '42501': 403, P0002: 404, '23505': 409, '55000': 409, '22023': 400, '22007': 400, '22008': 400 };
    const statusCode = statuses[code] || 500;
    // Service/key/schema details remain in server logs, never client responses.
    if (statusCode === 500) console.error('[mobile.database]', result.error.message);
    throw fail(statusCode === 500 ? 'Unable to complete this request' : result.error.message, statusCode);
  }
  return result.data;
}

module.exports = { fail, assertRole, userId, databaseResult };
