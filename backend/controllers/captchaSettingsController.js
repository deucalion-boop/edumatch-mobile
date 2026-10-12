const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { getAppSettings, saveAppSettings } = require('../services/supabaseSettingsService');
const { sendSuccess } = require('../utils/responseHelper');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function assertActiveAdmin(user) {
  if (!user?._id || user.role !== 'admin' || user.status !== 'active') {
    throw Object.assign(new Error('An active administrator account is required'), { statusCode: 403 });
  }
}

function captchaSettings() {
  return { enabled: true, captchaEnabled: true, required: true, scope: 'school' };
}

const getLoginSecuritySettings = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  await getAppSettings();
  return sendSuccess(res, 200, 'Sign-in security settings fetched successfully', {
    settings: { captchaEnabled: true, recaptchaEnabled: true },
  });
});

const getCaptchaSettings = asyncHandler(async (req, res) => {
  assertActiveAdmin(req.user);
  res.set('Cache-Control', 'no-store');
  await getAppSettings();
  return sendSuccess(res, 200, 'School math CAPTCHA settings fetched successfully', {
    settings: captchaSettings(),
  });
});

const saveCaptchaSettings = asyncHandler(async (req, res) => {
  assertActiveAdmin(req.user);
  const { enabled, currentPassword } = req.body || {};
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('CAPTCHA setting must be a boolean'), { statusCode: 400 });
  }
  if (!enabled) {
    throw Object.assign(new Error('Math CAPTCHA is required and cannot be disabled'), { statusCode: 400 });
  }
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw Object.assign(new Error('Current password is required to confirm CAPTCHA settings'), { statusCode: 400 });
  }
  const account = await findSupabaseAccount('id', req.user._id);
  assertActiveAdmin(account);
  if (account.role !== req.user.role) {
    throw Object.assign(new Error('Your account changed while saving. Please try again.'), { statusCode: 403 });
  }
  if (!await account.comparePassword(currentPassword)) {
    throw Object.assign(new Error('Current password is incorrect'), { statusCode: 400 });
  }
  await saveAppSettings({ security: { captchaEnabled: true } }, account._id);
  req.auditLogContext = {
    ...req.auditLogContext,
    actionLabel: 'Required school math CAPTCHA policy confirmed',
    targetId: 'global',
    targetLabel: 'School sign-in security',
  };
  return sendSuccess(res, 200, 'Required school math CAPTCHA settings confirmed', {
    settings: captchaSettings(),
  });
});

module.exports = { getLoginSecuritySettings, getCaptchaSettings, saveCaptchaSettings };
