const { getSupabaseStorageClient } = require('./supabaseStorageService');

const DEFAULT_MAINTENANCE_MESSAGE = 'The system is currently under maintenance. Please check back later.';

function settingsError(error, message) {
  const normalized = new Error(message);
  normalized.statusCode = 503;
  normalized.cause = error;
  return normalized;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function hydrateSettings(row) {
  const value = row?.value || {};
  return {
    key: 'global',
    user: { emailVerificationRequired: true },
    security: {
      sessionTimeoutMinutes: boundedInteger(value.security?.sessionTimeoutMinutes, 120, 5, 1440),
      maxLoginAttempts: boundedInteger(value.security?.maxLoginAttempts, 5, 3, 10),
      accountLockoutDurationMinutes: boundedInteger(value.security?.accountLockoutDurationMinutes, 30, 1, 1440),
    },
    maintenance: {
      maintenanceModeEnabled: value.maintenance?.maintenanceModeEnabled === true,
      maintenanceMessage: String(value.maintenance?.maintenanceMessage || DEFAULT_MAINTENANCE_MESSAGE).trim()
        || DEFAULT_MAINTENANCE_MESSAGE,
      systemVersion: String(value.maintenance?.systemVersion || 'v1.0.0'),
      lastBackupAt: value.maintenance?.lastBackupAt || null,
      lastBackupFileName: String(value.maintenance?.lastBackupFileName || ''),
      backupHistory: Array.isArray(value.maintenance?.backupHistory) ? value.maintenance.backupHistory : [],
      lastCacheClearedAt: value.maintenance?.lastCacheClearedAt || null,
    },
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at || null,
  };
}

async function readSettingsRow() {
  const { data, error } = await getSupabaseStorageClient().from('app_settings')
    .select('*').eq('key', 'global').maybeSingle();
  if (error) throw settingsError(error, 'Security settings are unavailable. Please try again later.');
  return data;
}

async function getAppSettings() {
  // Read the shared database on each request so maintenance and policy changes
  // apply to every backend instance, without a stale process-local cache.
  return hydrateSettings(await readSettingsRow());
}

async function saveAppSettings(patch, updatedBy) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await readSettingsRow();
    const current = hydrateSettings(previous);
    const value = { ...(previous?.value || {}) };
    for (const section of ['user', 'security', 'maintenance']) {
      value[section] = { ...current[section], ...(patch[section] || {}) };
    }
    value.user.emailVerificationRequired = true;
    const row = {
      key: 'global', value, updated_by: String(updatedBy || '') || null,
      updated_at: new Date(Math.max(Date.now(), Date.parse(previous?.updated_at || '') + 1 || 0)).toISOString(),
    };
    const table = getSupabaseStorageClient().from('app_settings');
    // Compare the revision before merging a partial settings update. A cache
    // clear must not overwrite a maintenance setting saved concurrently.
    const { data, error } = previous
      ? await table.update(row).eq('key', 'global').eq('updated_at', previous.updated_at).select('*').maybeSingle()
      : await table.insert(row).select('*').single();
    if (error && (!previous && error.code === '23505')) continue;
    if (error) throw settingsError(error, 'Unable to save system settings. Please try again later.');
    if (data) return hydrateSettings(data);
  }
  const error = new Error('Settings changed while saving. Please try again.');
  error.statusCode = 409;
  throw error;
}

module.exports = { getAppSettings, saveAppSettings };
