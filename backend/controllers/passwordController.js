const { passwordLengthError } = require('../utils/teacherValidation');
const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { revokeUserSessions } = require('../services/supabaseAuthPersistenceService');
const { sendSuccess } = require('../utils/responseHelper');
const { assertPasswordMeetsPolicy } = require('../utils/passwordPolicy');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const changePassword = asyncHandler(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmNewPassword = String(req.body?.confirmNewPassword || '');

  if (!currentPassword || !newPassword || !confirmNewPassword) {
    const error = new Error('Current password, new password, and confirmation are required');
    error.statusCode = 400;
    throw error;
  }

  if (newPassword !== confirmNewPassword) {
    const error = new Error('New password and confirmation password do not match');
    error.statusCode = 400;
    throw error;
  }

  if (req.user?.role === 'teacher' && passwordLengthError(currentPassword)) {
    throw Object.assign(new Error('Current password must be 8-17 characters.'), { statusCode: 400 });
  }

  assertPasswordMeetsPolicy(newPassword, req.user?.role === 'teacher' ? 17 : undefined);

  const user = await findSupabaseAccount('id', req.user?._id);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const passwordMatched = await user.comparePassword(currentPassword);
  if (!passwordMatched) {
    const error = new Error('Current password is incorrect');
    error.statusCode = 401;
    throw error;
  }

  user.password = newPassword;
  user.forcePasswordChange = false;
  user.temporaryPasswordIssuedAt = null;
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save();
  await revokeUserSessions(user._id, 'Password changed');

  return sendSuccess(res, 200, 'Password updated successfully', {
    user: {
      id: user._id,
      forcePasswordChange: user.forcePasswordChange,
      temporaryPasswordIssuedAt: user.temporaryPasswordIssuedAt,
    },
  });
});

module.exports = {
  changePassword,
};
