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

test('math CAPTCHA stays mandatory regardless of legacy or current stored disable flags', async () => {
  assert.equal((await settingsFixture().service.getAppSettings()).security.captchaEnabled, true);
  for (const value of [undefined, null, false, 0, '', 'false', {}, []]) {
    const fixture = settingsFixture([globalRow({ security: { recaptchaEnabled: value, captchaEnabled: value } })]);
    const settings = await fixture.service.getAppSettings();
    assert.equal(settings.security.captchaEnabled, true);
    assert.equal(settings.security.recaptchaEnabled, true);
  }
});

test('required CAPTCHA saves preserve other policies, account OTP choices and concurrent settings', async () => {
  const personal = { key: 'admin-security:admin-2', value: { loginOtpEnabled: false } };
  const fixture = settingsFixture([personal, globalRow({
    security: { recaptchaEnabled: true, maxLoginAttempts: 4, customPolicy: 'preserve' },
    maintenance: { maintenanceModeEnabled: false, systemVersion: 'v2.0' },
  })]);
  fixture.state.conflict = { ...globalRow({
    security: { recaptchaEnabled: true, maxLoginAttempts: 6, customPolicy: 'preserve' },
    maintenance: { maintenanceModeEnabled: true, systemVersion: 'v2.1' },
  }), updated_at: '2026-10-12T02:00:00.000Z' };
  await fixture.service.saveAppSettings({ security: { recaptchaEnabled: false, captchaEnabled: false } }, 'admin-1');
  const settings = await fixture.service.getAppSettings();
  assert.equal(settings.security.captchaEnabled, true);
  assert.equal(settings.security.recaptchaEnabled, true);
  assert.equal(fixture.state.rows.get('global').value.security.recaptchaEnabled, undefined);
  assert.equal(settings.security.maxLoginAttempts, 6);
  assert.equal(settings.maintenance.maintenanceModeEnabled, true);
  assert.equal(settings.maintenance.systemVersion, 'v2.1');
  assert.equal(settings.user.emailVerificationRequired, true);
  assert.equal(fixture.state.rows.get('global').value.security.customPolicy, 'preserve');
  assert.equal(fixture.state.rows.get('global').updated_by, 'admin-1');
  assert.deepEqual(fixture.state.rows.get(personal.key), personal);
  await fixture.service.saveAppSettings({ maintenance: { systemVersion: 'v2.2' } }, 'admin-1');
  assert.equal((await fixture.service.getAppSettings()).security.captchaEnabled, true);
  await fixture.service.saveAppSettings({ security: {
    sessionTimeoutMinutes: 90, maxLoginAttempts: 5, accountLockoutDurationMinutes: 15,
  } }, 'admin-1');
  assert.equal((await fixture.service.getAppSettings()).security.captchaEnabled, true);
  assert.equal((await fixture.service.getAppSettings()).security.sessionTimeoutMinutes, 90);
});

function controllerFixture() {
  const fixture = settingsFixture();
  const events = [];
  const account = {
    _id: 'admin-1', name: 'Administrator', role: 'admin', status: 'active',
    async comparePassword(value) { events.push(['password', value]); return value === ' correct password '; },
  };
  const controller = loadBackend('controllers/captchaSettingsController.js', {
    '../services/supabaseSettingsService': fixture.service,
    '../services/supabaseAccountService': { async findSupabaseAccount(field, id) { events.push(['account', field, id]); return account; } },
  });
  const request = (body = {}) => ({ user: { ...account }, body });
  return { ...fixture, events, account, controller, request };
}

test('public sign-in policy reports required CAPTCHA without account or school details and is not cached', async () => {
  const fixture = controllerFixture();
  fixture.state.rows.set('global', globalRow({
    security: { recaptchaEnabled: false, maxLoginAttempts: 3 },
    maintenance: { maintenanceModeEnabled: true, maintenanceMessage: 'private message' },
  }));
  const result = await invoke(fixture.controller.getLoginSecuritySettings);
  assert.equal(result.failure, undefined);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(plain(result.response.body.settings), { captchaEnabled: true, recaptchaEnabled: true });
  assert.equal(fixture.events.length, 0);
  assert.equal(JSON.stringify(result.response.body).includes('private message'), false);
  fixture.state.error = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.getLoginSecuritySettings)).failure.statusCode, 503);
});

test('active administrator can confirm required school CAPTCHA using only their own current password', async () => {
  const fixture = controllerFixture();
  const initial = await invoke(fixture.controller.getCaptchaSettings, fixture.request());
  assert.deepEqual(plain(initial.response.body.settings), { enabled: true, captchaEnabled: true, required: true, scope: 'school' });
  const req = fixture.request({ enabled: true, currentPassword: ' correct password ', userId: 'admin-2' });
  const saved = await invoke(fixture.controller.saveCaptchaSettings, req);
  assert.equal(saved.failure, undefined);
  assert.deepEqual(plain(saved.response.body.settings), { enabled: true, captchaEnabled: true, required: true, scope: 'school' });
  assert.deepEqual(fixture.events, [['account', 'id', 'admin-1'], ['password', ' correct password ']]);
  assert.deepEqual([...fixture.state.rows.keys()], ['global']);
  assert.equal(req.auditLogContext.targetId, 'global');
  assert.equal(JSON.stringify(req.auditLogContext).includes('correct password'), false);
  const rejected = await invoke(fixture.controller.saveCaptchaSettings, fixture.request({ enabled: false, currentPassword: ' correct password ' }));
  assert.equal(rejected.failure.statusCode, 400);
  assert.match(rejected.failure.message, /cannot be disabled/);
  assert.equal((await fixture.service.getAppSettings()).security.captchaEnabled, true);
});

test('CAPTCHA policy rejects disable requests, nonbooleans, wrong passwords, other roles and unavailable admins', async () => {
  const fixture = controllerFixture();
  for (const body of [
    { enabled: true }, { enabled: true, currentPassword: '' },
    { enabled: true, currentPassword: 'wrong' }, { enabled: 'false', currentPassword: ' correct password ' },
    { currentPassword: ' correct password ' },
  ]) {
    assert.equal((await invoke(fixture.controller.saveCaptchaSettings, fixture.request(body))).failure.statusCode, 400);
  }
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    const req = { user: { ...fixture.account, role }, body: { enabled: false, currentPassword: ' correct password ' } };
    assert.equal((await invoke(fixture.controller.getCaptchaSettings, req)).failure.statusCode, 403);
    assert.equal((await invoke(fixture.controller.saveCaptchaSettings, req)).failure.statusCode, 403);
  }
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.account.status = status;
    assert.equal((await invoke(fixture.controller.saveCaptchaSettings, {
      user: { ...fixture.account, status: 'active' }, body: { enabled: true, currentPassword: ' correct password ' },
    })).failure.statusCode, 403);
  }
  assert.equal(fixture.state.rows.size, 0);
});

test('CAPTCHA policy read and write failures do not silently save or disable verification', async () => {
  const fixture = controllerFixture();
  fixture.state.error = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.getCaptchaSettings, fixture.request())).failure.statusCode, 503);
  assert.equal((await invoke(fixture.controller.saveCaptchaSettings, fixture.request({ enabled: true, currentPassword: ' correct password ' }))).failure.statusCode, 503);
  fixture.state.error = null;
  fixture.state.writeError = { message: 'Database unavailable' };
  assert.equal((await invoke(fixture.controller.saveCaptchaSettings, fixture.request({ enabled: true, currentPassword: ' correct password ' }))).failure.statusCode, 503);
  assert.equal(fixture.state.rows.size, 0);
});

function loginFixture() {
  const events = [];
  const state = { captchaValid: true, captchaError: null, settingsError: null, otpEnabled: true, challengeAvailable: true };
  const verificationTokens = new Map();
  let tokenCounter = 0;
  const issueToken = (action = 'login') => {
    const token = `opaque-token-${++tokenCounter}`;
    verificationTokens.set(token, action);
    return token;
  };
  const user = {
    _id: 'user-1', name: 'Account Holder', username: 'account', email: 'account@gmail.com',
    role: 'student', status: 'active', password: 'test-hash', tokenVersion: 3,
    failedLoginAttempts: 0, forcePasswordChange: false,
    async comparePassword(value) { events.push(['password']); return value === 'correct-password'; },
    async save() { events.push(['save']); },
  };
  const settings = {
    user: { emailVerificationRequired: true },
    security: { captchaEnabled: true, maxLoginAttempts: 3, accountLockoutDurationMinutes: 2 },
    maintenance: { maintenanceModeEnabled: false, maintenanceMessage: 'Scheduled maintenance' },
  };
  const challenge = {
    userId: user._id, otpHash: 'otp-hash', remember: false, failedAttempts: 0,
    async save() { events.push(['challenge-save']); },
  };
  const env = { JWT_SECRET: 'test-secret' };
  const controller = loadBackend('controllers/authController.js', {
    jsonwebtoken: { sign() { events.push(['token']); return 'test-session-token'; } },
    bcryptjs: { hash: async () => 'otp-hash', compare: async (value) => value === '123456' },
    '../services/gmailService': { async sendEmailViaGmail() { events.push(['email']); return { sent: true }; } },
    '../services/supabaseSettingsService': { async getAppSettings() { if (state.settingsError) throw state.settingsError; return settings; } },
    '../services/mathCaptchaService': { async consumeVerificationToken(token, action) {
      events.push(['captcha', action]);
      if (state.captchaError) throw state.captchaError;
      const tokenAction = verificationTokens.get(token);
      verificationTokens.delete(token);
      return state.captchaValid && tokenAction === action;
    } },
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
    process: { env },
    fetch: async () => { throw new Error('Authentication must never call an external CAPTCHA provider'); },
  });
  const request = (overrides = {}) => ({
    body: { username: 'account', password: 'correct-password', captchaToken: issueToken(), ...overrides },
    headers: { 'user-agent': 'test-device' }, ip: '127.0.0.1',
  });
  return { controller, events, state, user, settings, challenge, request, env, issueToken };
}

test('valid math CAPTCHA preserves every role and the school-wide OTP preference', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.state.otpEnabled = false;
  for (const role of ['student', 'teacher', 'headteacher', 'secretary', 'admin']) {
    fixture.user.role = role;
    const result = await invoke(fixture.controller.login, fixture.request());
    assert.equal(result.failure, undefined);
    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.body.requiresOtp, false);
    assert.equal(Boolean(result.response.body.token), true);
  }
  assert.equal(fixture.events.filter(([event]) => event === 'captcha').length, 5);
  assert.equal(fixture.events.filter(([event]) => event === 'otp-preference').length, 5);
  assert.equal(fixture.events.filter(([event]) => event === 'session').length, 5);
});

test('math CAPTCHA preserves password lockout, account status and maintenance restrictions', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await invoke(fixture.controller.login, fixture.request({ password: 'wrong' }))).failure.statusCode, 401);
  }
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 423);
  fixture.user.lockUntil = null;
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.user.status = status;
    assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 403);
  }
  fixture.user.status = 'active';
  fixture.settings.maintenance.maintenanceModeEnabled = true;
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 503);
  assert.equal(fixture.events.some(([event]) => event === 'session' || event === 'challenge'), false);
});

test('direct login rejects missing or invalid CAPTCHA regardless of stored and client bypass flags', async () => {
  const fixture = loginFixture();
  fixture.user.role = 'admin';
  fixture.state.otpEnabled = false;
  for (const recaptchaEnabled of [true, false, undefined, null, 'false', 0]) {
    fixture.settings.security.recaptchaEnabled = recaptchaEnabled;
    const rejected = await invoke(fixture.controller.login, fixture.request({
      captchaToken: '', captchaEnabled: false, recaptchaEnabled: false, skipCaptcha: true, enabled: false,
    }));
    assert.equal(rejected.failure.statusCode, 400);
  }
  fixture.settings.security.recaptchaEnabled = true;
  fixture.state.captchaValid = false;
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 400);
  fixture.state.captchaError = Object.assign(new Error('CAPTCHA storage unavailable'), { statusCode: 503 });
  assert.equal((await invoke(fixture.controller.login, fixture.request())).failure.statusCode, 503);
  assert.equal(fixture.events.some(([event]) => ['lookup', 'password', 'otp-preference', 'session', 'challenge'].includes(event)), false);
});

test('direct login rejects reused and wrong-action verification tokens', async () => {
  const fixture = loginFixture();
  const req = fixture.request();
  assert.equal((await invoke(fixture.controller.login, req)).response.statusCode, 202);
  assert.equal((await invoke(fixture.controller.login, req)).failure.statusCode, 400);
  const wrongAction = fixture.request({ captchaToken: fixture.issueToken('forgot-password') });
  assert.equal((await invoke(fixture.controller.login, wrongAction)).failure.statusCode, 400);
  assert.equal(fixture.events.filter(([event]) => event === 'challenge').length, 1);
});

test('direct forgot-password API rejects missing, invalid, reused and wrong-action CAPTCHA before account access', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  for (const captchaToken of [undefined, '', 'forged', fixture.issueToken('login')]) {
    const req = fixture.request({ email: fixture.user.email, captchaToken, skipCaptcha: true, captchaEnabled: false });
    assert.equal((await invoke(fixture.controller.requestPasswordReset, req)).failure.statusCode, 400);
  }
  assert.equal(fixture.events.some(([event]) => ['lookup', 'save', 'email'].includes(event)), false);
  const req = fixture.request({ email: fixture.user.email, captchaToken: fixture.issueToken('forgot-password') });
  const accepted = await invoke(fixture.controller.requestPasswordReset, req);
  assert.equal(accepted.failure, undefined);
  assert.equal(accepted.response.statusCode, 200);
  assert.equal(fixture.user.resetPassword.tokenHash.length, 64);
  assert.equal((await invoke(fixture.controller.requestPasswordReset, req)).failure.statusCode, 400);
  assert.equal(fixture.events.filter(([event]) => event === 'email').length, 1);
});

test('forgot-password fails closed when CAPTCHA storage is unavailable', async () => {
  const fixture = loginFixture();
  fixture.state.captchaError = Object.assign(new Error('CAPTCHA unavailable'), { statusCode: 503 });
  const req = fixture.request({ email: fixture.user.email, captchaToken: fixture.issueToken('forgot-password') });
  const rejected = await invoke(fixture.controller.requestPasswordReset, req);
  assert.equal(rejected.failure.statusCode, 503);
  assert.equal(fixture.events.some(([event]) => ['lookup', 'save', 'email'].includes(event)), false);
});

test('OTP verification retains valid-code, challenge and account checks without repeating CAPTCHA', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.state.captchaError = new Error('Unexpected CAPTCHA verification');
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
  assert.equal(fixture.events.some(([event]) => event === 'captcha'), false);
});

test('every role verifies an OTP without repeating CAPTCHA regardless of obsolete school policy flags', async () => {
  for (const enabled of [true, false]) {
    for (const role of ['student', 'teacher', 'headteacher', 'secretary', 'admin']) {
      const fixture = loginFixture();
      fixture.settings.security.recaptchaEnabled = enabled;
      fixture.user.role = role;
      fixture.state.captchaError = new Error('Unexpected CAPTCHA verification');
      const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456' });
      delete request.body.captchaToken;
      const result = await invoke(fixture.controller.verifyLoginOtp, request);
      assert.equal(result.failure, undefined);
      assert.equal(result.response.statusCode, 200);
      assert.equal(result.response.body.token, 'test-session-token');
      assert.equal(fixture.events.filter(([event]) => event === 'session').length, 1);
      assert.equal(fixture.events.some(([event]) => event === 'captcha'), false);
    }
  }
});

test('an outstanding OTP challenge does not consume another CAPTCHA token', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  assert.equal((await invoke(fixture.controller.login, fixture.request())).response.statusCode, 202);
  fixture.settings.security.recaptchaEnabled = true;
  fixture.state.captchaError = new Error('Unexpected CAPTCHA verification');
  const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456', captchaToken: '', recaptchaEnabled: false });
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, request)).response.statusCode, 200);
  assert.equal(fixture.events.filter(([event]) => event === 'captcha').length, 1);
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
  assert.equal(fixture.events.some(([event]) => event === 'session' || event === 'captcha'), false);
});

test('unavailable school settings block both login stages before CAPTCHA or session issuance', async () => {
  const fixture = loginFixture();
  fixture.settings.security.recaptchaEnabled = false;
  fixture.state.settingsError = Object.assign(new Error('Unavailable'), { statusCode: 503 });
  assert.equal((await invoke(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 503);
  assert.equal((await invoke(fixture.controller.verifyLoginOtp, fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '123456', captchaToken: '' }))).failure.statusCode, 503);
  assert.equal(fixture.events.length, 0);
});
