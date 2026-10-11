const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { getAppSettings, saveAppSettings } = require('../services/supabaseSettingsService');
const { sendSuccess } = require('../utils/responseHelper');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function assertActiveAdmin(user) {
  if (!user?._id || user.role !== 'admin' || user.status !== 'active') {
    throw Object.assign(new Error('An active administrator account is required'), { statusCode: 403 });
  }
}

function recaptchaEnabled(settings) {
  return settings.security?.recaptchaEnabled !== false;
}

const getLoginSecuritySettings = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const settings = await getAppSettings();
  return sendSuccess(res, 200, 'Sign-in security settings fetched successfully', {
    settings: { recaptchaEnabled: recaptchaEnabled(settings) },
  });
});

const getRecaptchaSettings = asyncHandler(async (req, res) => {
  assertActiveAdmin(req.user);
  res.set('Cache-Control', 'no-store');
  const settings = await getAppSettings();
  return sendSuccess(res, 200, 'School reCAPTCHA settings fetched successfully', {
    settings: { enabled: recaptchaEnabled(settings), scope: 'school' },
  });
});

const saveRecaptchaSettings = asyncHandler(async (req, res) => {
  assertActiveAdmin(req.user);
  const { enabled, currentPassword } = req.body || {};
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('reCAPTCHA setting must be on or off'), { statusCode: 400 });
  }
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw Object.assign(new Error('Current password is required to change reCAPTCHA settings'), { statusCode: 400 });
  }
  const account = await findSupabaseAccount('id', req.user._id);
  assertActiveAdmin(account);
  if (account.role !== req.user.role) {
    throw Object.assign(new Error('Your account changed while saving. Please try again.'), { statusCode: 403 });
  }
  if (!await account.comparePassword(currentPassword)) {
    throw Object.assign(new Error('Current password is incorrect'), { statusCode: 400 });
  }
  const settings = await saveAppSettings({ security: { recaptchaEnabled: enabled } }, account._id);
  const saved = recaptchaEnabled(settings);
  req.auditLogContext = {
    ...req.auditLogContext,
    actionLabel: saved ? 'School sign-in reCAPTCHA enabled' : 'School sign-in reCAPTCHA disabled',
    targetId: 'global',
    targetLabel: 'School sign-in security',
  };
  return sendSuccess(res, 200, 'School reCAPTCHA settings saved successfully', {
    settings: { enabled: saved, scope: 'school' },
  });
});

module.exports = { getLoginSecuritySettings, getRecaptchaSettings, saveRecaptchaSettings };
