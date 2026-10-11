'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { runInNewContext } = require('node:vm');

const backendRoot = join(__dirname, '../../backend');
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadBackend(relativePath, mocks, globals = {}) {
  const filename = join(backendRoot, relativePath);
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      return require(name.startsWith('.') ? join(dirname(filename), name) : name);
    },
    ...globals,
  });
  return module.exports;
}

async function invoke(controller, req = {}) {
  const response = {
    statusCode: null, body: null, headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let failure;
  await controller(req, response, (error) => { failure = error; });
  return { response, failure };
}

function settingsFixture(initialRows = []) {
  const state = {
    rows: new Map(initialRows.map((row) => [row.key, structuredClone(row)])),
    error: null, writeError: null, conflict: null,
  };
  const client = { from(table) {
    assert.equal(table, 'app_settings');
    let operation = 'read';
    let payload;
    const filters = {};
    const query = {
      select() { return query; },
      eq(key, value) { filters[key] = value; return query; },
      insert(row) { operation = 'insert'; payload = plain(row); return query; },
      update(row) { operation = 'update'; payload = plain(row); return query; },
      async maybeSingle() { return execute(); },
      async single() { return execute(); },
    };
    function execute() {
      if (state.error) return { data: null, error: state.error };
      if (operation === 'read') return { data: structuredClone(state.rows.get(filters.key) || null), error: null };
      if (state.writeError) return { data: null, error: state.writeError };
      if (state.conflict) {
        state.rows.set(state.conflict.key, structuredClone(state.conflict));
        state.conflict = null;
      }
      const previous = state.rows.get(payload.key);
      if (operation === 'insert' && previous) return { data: null, error: { code: '23505' } };
      if (operation === 'update' && previous?.updated_at !== filters.updated_at) return { data: null, error: null };
      state.rows.set(payload.key, structuredClone(payload));
      return { data: structuredClone(payload), error: null };
    }
    return query;
  } };
  const service = loadBackend('services/supabaseSettingsService.js', {
    './supabaseStorageService': { getSupabaseStorageClient: () => client },
  });
  return { state, service };
}

function globalRow(value) {
  return { key: 'global', value, updated_at: '2026-10-12T01:00:00.000Z' };
}

test('shared reCAPTCHA policy defaults on and only a stored boolean false disables it', async () => {
  assert.equal((await settingsFixture().service.getAppSettings()).security.recaptchaEnabled, true);
  for (const value of [undefined, null, 0, '', 'false', {}, []]) {
    const fixture = settingsFixture([globalRow({ security: { recaptchaEnabled: value } })]);
    assert.equal((await fixture.service.getAppSettings()).security.recaptchaEnabled, true);
  }
  const fixture = settingsFixture([globalRow({ security: { recaptchaEnabled: false } })]);
  assert.equal((await fixture.service.getAppSettings()).security.recaptchaEnabled, false);
});

test('shared reCAPTCHA saves preserve other policies, account OTP choices and concurrent settings', async () => {
  const personal = { key: 'admin-security:admin-2', value: { loginOtpEnabled: false } };
  const fixture = settingsFixture([personal, globalRow({
    security: { recaptchaEnabled: true, maxLoginAttempts: 4, customPolicy: 'preserve' },
    maintenance: { maintenanceModeEnabled: false, systemVersion: 'v2.0' },
  })]);
  fixture.state.conflict = { ...globalRow({
    security: { recaptchaEnabled: true, maxLoginAttempts: 6, customPolicy: 'preserve' },
    maintenance: { maintenanceModeEnabled: true, systemVersion: 'v2.1' },
  }), updated_at: '2026-10-12T02:00:00.000Z' };
  await fixture.service.saveAppSettings({ security: { recaptchaEnabled: false } }, 'admin-1');
  const settings = await fixture.service.getAppSettings();
  assert.equal(settings.security.recaptchaEnabled, false);
  assert.equal(settings.security.maxLoginAttempts, 6);
  assert.equal(settings.maintenance.maintenanceModeEnabled, true);
  assert.equal(settings.maintenance.systemVersion, 'v2.1');
  assert.equal(settings.user.emailVerificationRequired, true);
  assert.equal(fixture.state.rows.get('global').value.security.customPolicy, 'preserve');
  assert.equal(fixture.state.rows.get('global').updated_by, 'admin-1');
  assert.deepEqual(fixture.state.rows.get(personal.key), personal);
  await fixture.service.saveAppSettings({ maintenance: { systemVersion: 'v2.2' } }, 'admin-1');
  assert.equal((await fixture.service.getAppSettings()).security.recaptchaEnabled, false);
  await fixture.service.saveAppSettings({ security: {
    sessionTimeoutMinutes: 90, maxLoginAttempts: 5, accountLockoutDurationMinutes: 15,
  } }, 'admin-1');
  assert.equal((await fixture.service.getAppSettings()).security.recaptchaEnabled, false);
  assert.equal((await fixture.service.getAppSettings()).security.sessionTimeoutMinutes, 90);
});

function controllerFixture() {
  const fixture = settingsFixture();
  const events = [];
  const account = {
    _id: 'admin-1', name: 'Administrator', role: 'admin', status: 'active',
    async comparePassword(value) { events.push(['password', value]); return value === ' correct password '; },
  };
  const controller = loadBackend('controllers/recaptchaSettingsController.js', {
    '../services/supabaseSettingsService': fixture.service,
    '../services/supabaseAccountService': { async findSupabaseAccount(field, id) { events.push(['account', field, id]); return account; } },
  });
  const request = (body = {}) => ({ user: { ...account }, body });
  return { ...fixture, events, account, controller, request };
}

test('public sign-in policy exposes one boolean without account or school security details and is not cached', async () => {
  const fixture = controllerFixture();
  fixture.state.rows.set('global', globalRow({
    security: { recaptchaEnabled: false, maxLoginAttempts: 3 },
    maintenance: { maintenanceModeEnabled: true, maintenanceMessage: 'private message' },
  }));
  const result = await invoke(fixture.controller.getLoginSecuritySettings);
  assert.equal(result.failure, undefined);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(plain(result.response.body.settings), { recaptchaEnabled: false });
  assert.equal(fixture.events.length, 0);
  assert.equal(JSON.stringify(result.response.body).includes('private message'), false);
  fixture.state.error = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.getLoginSecuritySettings)).failure.statusCode, 503);
});

test('active administrator can fetch and toggle school policy using only their own current password', async () => {
  const fixture = controllerFixture();
  const initial = await invoke(fixture.controller.getRecaptchaSettings, fixture.request());
  assert.deepEqual(plain(initial.response.body.settings), { enabled: true, scope: 'school' });
  const req = fixture.request({ enabled: false, currentPassword: ' correct password ', userId: 'admin-2' });
  const saved = await invoke(fixture.controller.saveRecaptchaSettings, req);
  assert.equal(saved.failure, undefined);
  assert.deepEqual(plain(saved.response.body.settings), { enabled: false, scope: 'school' });
  assert.deepEqual(fixture.events, [['account', 'id', 'admin-1'], ['password', ' correct password ']]);
  assert.deepEqual([...fixture.state.rows.keys()], ['global']);
  assert.equal(req.auditLogContext.targetId, 'global');
  assert.equal(JSON.stringify(req.auditLogContext).includes('correct password'), false);
  const enabled = await invoke(fixture.controller.saveRecaptchaSettings, fixture.request({ enabled: true, currentPassword: ' correct password ' }));
  assert.deepEqual(plain(enabled.response.body.settings), { enabled: true, scope: 'school' });
});

test('reCAPTCHA updates reject nonbooleans, missing or incorrect passwords, other roles and unavailable administrators', async () => {
  const fixture = controllerFixture();
  for (const body of [
    { enabled: false }, { enabled: false, currentPassword: '' },
    { enabled: false, currentPassword: 'wrong' }, { enabled: 'false', currentPassword: ' correct password ' },
    { currentPassword: ' correct password ' },
  ]) {
    assert.equal((await invoke(fixture.controller.saveRecaptchaSettings, fixture.request(body))).failure.statusCode, 400);
  }
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    const req = { user: { ...fixture.account, role }, body: { enabled: false, currentPassword: ' correct password ' } };
    assert.equal((await invoke(fixture.controller.getRecaptchaSettings, req)).failure.statusCode, 403);
    assert.equal((await invoke(fixture.controller.saveRecaptchaSettings, req)).failure.statusCode, 403);
  }
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.account.status = status;
    assert.equal((await invoke(fixture.controller.saveRecaptchaSettings, {
      user: { ...fixture.account, status: 'active' }, body: { enabled: false, currentPassword: ' correct password ' },
    })).failure.statusCode, 403);
  }
  assert.equal(fixture.state.rows.size, 0);
});

test('school reCAPTCHA read and write failures do not silently save or disable verification', async () => {
  const fixture = controllerFixture();
  fixture.state.error = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.getRecaptchaSettings, fixture.request())).failure.statusCode, 503);
  assert.equal((await invoke(fixture.controller.saveRecaptchaSettings, fixture.request({ enabled: false, currentPassword: ' correct password ' }))).failure.statusCode, 503);
  fixture.state.error = null;
  fixture.state.writeError = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.saveRecaptchaSettings, fixture.request({ enabled: false, currentPassword: ' correct password ' }))).failure.statusCode, 503);
  assert.equal(fixture.state.rows.size, 0);
});

function loginFixture() {
  const events = [];
  const state = { captchaValid: true, googleError: false, settingsError: null, otpEnabled: true, challengeAvailable: true };
  const user = {
    _id: 'user-1', name: 'Account Holder', username: 'account', email: 'account@gmail.com',
    role: 'student', status: 'active', password: 'test-hash', tokenVersion: 3,
    failedLoginAttempts: 0, forcePasswordChange: false,
    async comparePassword(value) { events.push(['password']); return value === 'correct-password'; },
    async save() { events.push(['save']); },
  };
  const settings = {
    user: { emailVerificationRequired: true },
    security: { recaptchaEnabled: true, maxLoginAttempts: 3, accountLockoutDurationMinutes: 2 },
    maintenance: { maintenanceModeEnabled: false, maintenanceMessage: 'Scheduled maintenance' },
  };
  const challenge = {
    userId: user._id, otpHash: 'otp-hash', remember: false, failedAttempts: 0,
    async save() { events.push(['challenge-save']); },
  };
  const env = { RECAPTCHA_SECRET_KEY: 'test-key', RECAPTCHA_ALLOWED_HOSTNAMES: 'localhost', JWT_SECRET: 'test-secret' };
  const controller = loadBackend('controllers/authController.js', {
    jsonwebtoken: { sign() { events.push(['token']); return 'test-session-token'; } },
    bcryptjs: { hash: async () => 'otp-hash', compare: async (value) => value === '123456' },
    '../services/gmailService': { async sendEmailViaGmail() { events.push(['email']); return { sent: true }; } },
    '../services/supabaseSettingsService': { async getAppSettings() { if (state.settingsError) throw state.settingsError; return settings; } },
    '../services/adminSecurityService': { async getAdminLoginOtpEnabled() { events.push(['otp-preference']); return state.otpEnabled; } },
    '../services/supabaseAccountService': {
      async findSupabaseAccountByUsername() { events.push(['lookup']); return user; },
      async findSupabaseAccountByEmail() { events.push(['lookup']); return user; },
      findSupabaseAccount: async () => user,
    },
    '../services/supabaseAuthPersistenceService': {
      consumeOpenChallenges: async () => { events.push(['consume']); },
      createChallenge: async () => { events.push(['challenge']); },
      createSession: async () => { events.push(['session']); },
      sessionExists: async () => true,
      recordLoginAttempt: async () => { events.push(['attempt']); },
      findActiveChallenge: async () => state.challengeAvailable ? challenge : null,
    },
    '../utils/fileStorage': { resolveStoredFileUrl: (_req, value) => value },
  }, {
    process: { env }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async () => {
      events.push(['google']);
      if (state.googleError) throw new Error('Google unavailable');
      return { ok: true, json: async () => ({ success: state.captchaValid, hostname: 'localhost' }) };
    },
  });
  const request = (overrides = {}) => ({
    body: { username: 'account', password: 'correct-password', captchaToken: 'verified', ...overrides },
    headers: { 'user-agent': 'test-device' }, ip: '127.0.0.1',
  });
  return { controller, events, state, user, settings, challenge, request, env };
}

test('school reCAPTCHA off skips Google for every role while retaining administrator-only OTP preference', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.env.RECAPTCHA_SECRET_KEY = '';
  fixture.state.googleError = true;
  fixture.state.otpEnabled = false;
  for (const role of ['student', 'teacher', 'headteacher', 'secretary', 'admin']) {
    fixture.user.role = role;
    const result = await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }));
    assert.equal(result.failure, undefined);
    assert.equal(result.response.statusCode, role === 'admin' ? 200 : 202);
    assert.equal(result.response.body.requiresOtp, role !== 'admin');
    assert.equal(Boolean(result.response.body.token), role === 'admin');
  }
  assert.equal(fixture.events.some(([event]) => event === 'google'), false);
  assert.equal(fixture.events.filter(([event]) => event === 'otp-preference').length, 1);
  assert.equal(fixture.events.filter(([event]) => event === 'session').length, 1);
});

test('school reCAPTCHA off preserves password lockout, account status and maintenance restrictions', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await invoke(fixture.controller.login, fixture.request({ password: 'wrong', captchaToken: '' }))).failure.statusCode, 401);
  }
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 423);
  fixture.user.lockUntil = null;
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.user.status = status;
    assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 403);
  }
  fixture.user.status = 'active';
  fixture.settings.maintenance.maintenanceModeEnabled = true;
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 503);
  assert.equal(fixture.events.some(([event]) => event === 'session' || event === 'challenge' || event === 'google'), false);
});

test('school reCAPTCHA on rejects client bypass flags and invalid or unavailable Google verification', async () => {
  const fixture = loginFixture();
  fixture.user.role = 'admin';
  fixture.state.otpEnabled = false;
  for (const recaptchaEnabled of [true, undefined, null, 'false', 0]) {
    fixture.settings.security.recaptchaEnabled = recaptchaEnabled;
    const rejected = await invoke(fixture.controller.login, fixture.request({
      captchaToken: '', recaptchaEnabled: false, skipCaptcha: true, enabled: false,
    }));
    assert.equal(rejected.failure.statusCode, 400);
  }
  fixture.settings.security.recaptchaEnabled = true;
  fixture.state.captchaValid = false;
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 400);
  fixture.state.googleError = true;
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 400);
  assert.equal(fixture.events.some(([event]) => ['lookup', 'password', 'otp-preference', 'session', 'challenge'].includes(event)), false);
});

test('school reCAPTCHA changes apply to the next login without restarting the backend', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).response.statusCode, 202);
  fixture.settings.security.recaptchaEnabled = true;
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 400);
  assert.equal((await invoke(fixture.controller.login, fixture.request())).response.statusCode, 202);
  assert.equal(fixture.events.filter(([event]) => event === 'google').length, 1);
});

test('OTP verification retains valid-code, challenge and account checks without reCAPTCHA', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.state.googleError = true;
  const request = fixture.request({ challengeToken: 'a'.repeat(64), captchaToken: '', otpCode: '000000' });
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 401);
  assert.equal(fixture.challenge.failedAttempts, 1);
  fixture.state.challengeAvailable = false;
  request.body.otpCode = '123456';
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 400);
  fixture.state.challengeAvailable = true;
  fixture.user.status = 'inactive';
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 403);
  fixture.user.status = 'active';
  fixture.settings.maintenance.maintenanceModeEnabled = true;
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 503);
  fixture.settings.maintenance.maintenanceModeEnabled = false;
  const verified = await invoke(fixture.controller.verifyLoginOtp, request);
  assert.equal(verified.failure, undefined);
  assert.equal(verified.response.body.token, 'test-session-token');
  assert.equal(fixture.events.some(([event]) => event === 'google'), false);
});

test('every role verifies an OTP without CAPTCHA regardless of school reCAPTCHA policy or Google availability', async () => {
  for (const enabled of [true, false]) {
    for (const role of ['student', 'teacher', 'headteacher', 'secretary', 'admin']) {
      const fixture = loginFixture();
      fixture.settings.security.recaptchaEnabled = enabled;
      fixture.user.role = role;
      fixture.state.googleError = true;
      fixture.env.RECAPTCHA_SECRET_KEY = '';
      const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456' });
      delete request.body.captchaToken;
      const result = await invoke(fixture.controller.verifyLoginOtp, request);
      assert.equal(result.failure, undefined);
      assert.equal(result.response.statusCode, 200);
      assert.equal(result.response.body.token, 'test-session-token');
      assert.equal(fixture.events.filter(([event]) => event === 'session').length, 1);
      assert.equal(fixture.events.some(([event]) => event === 'google'), false);
    }
  }
});

test('re-enabling school reCAPTCHA does not add CAPTCHA to an outstanding OTP challenge', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).response.statusCode, 202);
  fixture.settings.security.recaptchaEnabled = true;
  fixture.state.googleError = true;
  const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456', captchaToken: '', recaptchaEnabled: false });
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).response.statusCode, 200);
  assert.equal(fixture.events.some(([event]) => event === 'google'), false);
});

test('OTP verification rejects malformed input, expired challenges and maximum attempts without CAPTCHA', async () => {
  const fixture = loginFixture();
  const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456', captchaToken: '' });
  for (const body of [
    { ...request.body, challengeToken: '' }, { ...request.body, otpCode: '' },
    { ...request.body, otpCode: '12345' }, { ...request.body, otpCode: '1234567' },
  ]) {
    assert.equal((await invoke(fixture.controller.verifyLoginOtp, { ...request, body })).failure.statusCode, 400);
  }
  fixture.state.challengeAvailable = false;
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 400);
  fixture.state.challengeAvailable = true;
  fixture.challenge.failedAttempts = 5;
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 400);
  fixture.challenge.failedAttempts = 4;
  request.body.otpCode = '000000';
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 401);
  assert.equal(fixture.challenge.failedAttempts, 5);
  assert.ok(fixture.challenge.consumedAt);
  request.body.otpCode = '123456';
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).failure.statusCode, 400);
  assert.equal(fixture.events.some(([event]) => event === 'session' || event === 'google'), false);
});

test('unavailable school settings block both login stages before Google or session issuance', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.state.settingsError = Object.assign(new Error('Unavailable'), { statusCode: 503 });
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 503);
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456', captchaToken: '' }))).failure.statusCode, 503);
  assert.equal(fixture.events.length, 0);
});
