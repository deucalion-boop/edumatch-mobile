const { getSupabaseStorageClient } = require('./supabaseStorageService');

function settingsError(error, message) {
  return Object.assign(new Error(message), { statusCode: 503, cause: error });
}

const LOGIN_OTP_SETTINGS_KEY = 'admin-security:school-login-otp';

function rowValue(row) {
  const value = row?.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function readSettingsRow(key) {
  const { data, error } = await getSupabaseStorageClient().from('app_settings')
    .select('*').eq('key', key).maybeSingle();
  if (error) throw settingsError(error, 'Account security settings are unavailable. Please try again later.');
  return data;
}

async function getAdminLoginOtpEnabled() {
  const row = await readSettingsRow(LOGIN_OTP_SETTINGS_KEY);
  // A missing or malformed preference keeps the existing email OTP protection.
  return rowValue(row).loginOtpEnabled !== false;
}

async function saveAdminLoginOtpEnabled(userId, enabled) {
  if (typeof enabled !== 'boolean') {
    throw Object.assign(new Error('OTP setting must be on or off'), { statusCode: 400 });
  }
  const id = String(userId || '').trim();
  if (!id) throw Object.assign(new Error('Administrator account is required'), { statusCode: 400 });
  const key = LOGIN_OTP_SETTINGS_KEY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await readSettingsRow(key);
    const row = {
      key,
      value: { ...rowValue(previous), loginOtpEnabled: enabled },
      updated_by: String(userId),
      updated_at: new Date(Math.max(Date.now(), Date.parse(previous?.updated_at || '') + 1 || 0)).toISOString(),
    };
    const table = getSupabaseStorageClient().from('app_settings');
    const { data, error } = previous
      ? await table.update(row).eq('key', key).eq('updated_at', previous.updated_at).select('*').maybeSingle()
      : await table.insert(row).select('*').single();
    if (error && !previous && error.code === '23505') continue;
    if (error) throw settingsError(error, 'Unable to save account security settings. Please try again later.');
    if (data) return rowValue(data).loginOtpEnabled !== false;
  }
  throw Object.assign(new Error('Account security settings changed while saving. Please try again.'), { statusCode: 409 });
}

module.exports = {
  getAdminLoginOtpEnabled,
  saveAdminLoginOtpEnabled,
};
