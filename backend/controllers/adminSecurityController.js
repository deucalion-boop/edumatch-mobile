const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { getAdminLoginOtpEnabled, saveAdminLoginOtpEnabled } = require('../services/adminSecurityService');
const { sendSuccess } = require('../utils/responseHelper');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function assertActiveAdmin(user) {
  if (!user?._id || user.role !== 'admin' || user.status !== 'active') {
    throw Object.assign(new Error('An active administrator account is required'), { statusCode: 403 });
  }
}

const getAdminOtpSettings = asyncHandler(async (req, res) => {
    assertActiveAdmin(req.user);
    const enabled = await getAdminLoginOtpEnabled(req.user._id);
    return sendSuccess(res, 200, 'Account OTP settings fetched successfully', {
      settings: { enabled, scope: 'account' },
    });
});

const saveAdminOtpSettings = asyncHandler(async (req, res) => {
    assertActiveAdmin(req.user);
    const { enabled, currentPassword } = req.body || {};
    if (typeof enabled !== 'boolean') {
      throw Object.assign(new Error('OTP setting must be on or off'), { statusCode: 400 });
    }
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      throw Object.assign(new Error('Current password is required to change OTP settings'), { statusCode: 400 });
    }
    const account = await findSupabaseAccount('id', req.user._id);
    assertActiveAdmin(account);
    if (account.role !== req.user.role) {
      throw Object.assign(new Error('Your account changed while saving. Please try again.'), { statusCode: 403 });
    }
    if (!await account.comparePassword(currentPassword)) {
      // This is a rejected settings change, not an expired authenticated session.
      throw Object.assign(new Error('Current password is incorrect'), { statusCode: 400 });
    }
    const saved = await saveAdminLoginOtpEnabled(account._id, enabled);
    req.auditLogContext = {
      ...req.auditLogContext,
      actionLabel: saved ? 'Account login OTP enabled' : 'Account login OTP disabled',
      targetId: account._id,
      targetLabel: account.name || account.username || account.email,
    };
    return sendSuccess(res, 200, 'Account OTP settings saved successfully', {
      settings: { enabled: saved, scope: 'account' },
    });
});

module.exports = { getAdminOtpSettings, saveAdminOtpSettings };
