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

function settingsFixture(initialRows = []) {
  const state = { rows: new Map(initialRows.map((row) => [row.key, structuredClone(row)])), events: [], error: null, writeError: null, conflict: null };
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
      state.events.push({ operation, filters: { ...filters }, payload });
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
  const service = loadBackend('services/adminSecurityService.js', {
    './supabaseStorageService': { getSupabaseStorageClient: () => client },
  });
  return { state, service };
}

function personalRow(id, value) {
  return { key: `admin-security:${id}`, value, updated_at: '2026-10-11T01:00:00.000Z' };
}

async function callController(controller, req = {}) {
  const response = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let failure;
  await controller(req, response, (error) => { failure = error; });
  return { response, failure };
}

test('administrator OTP defaults on for missing and malformed preferences', async () => {
  assert.equal(await settingsFixture().service.getAdminLoginOtpEnabled('admin-1'), true);
  for (const value of [undefined, null, 0, '', 'false', {}, []]) {
    const { service } = settingsFixture([personalRow('admin-1', { loginOtpEnabled: value })]);
    assert.equal(await service.getAdminLoginOtpEnabled('admin-1'), true);
  }
  for (const value of [null, 'false', [{ loginOtpEnabled: false }]]) {
    assert.equal(await settingsFixture([personalRow('admin-1', value)]).service.getAdminLoginOtpEnabled('admin-1'), true);
  }
  assert.equal(await settingsFixture([personalRow('admin-1', { loginOtpEnabled: false })]).service.getAdminLoginOtpEnabled('admin-1'), false);
});

test('administrator OTP persists per account without changing global policies or another account', async () => {
  const globalRow = { key: 'global', value: { user: { emailVerificationRequired: true }, security: { maxLoginAttempts: 4 } } };
  const other = personalRow('admin-2', { loginOtpEnabled: false });
  const fixture = settingsFixture([globalRow, other, personalRow('admin-1', { theme: 'dark', loginOtpEnabled: true })]);
  assert.equal(await fixture.service.saveAdminLoginOtpEnabled('admin-1', false), false);
  assert.equal(await fixture.service.getAdminLoginOtpEnabled('admin-1'), false);
  assert.equal(await fixture.service.getAdminLoginOtpEnabled('admin-2'), false);
  assert.deepEqual(fixture.state.rows.get('global'), globalRow);
  assert.deepEqual(fixture.state.rows.get('admin-security:admin-2'), other);
  assert.equal(fixture.state.rows.get('admin-security:admin-1').value.theme, 'dark');
  assert.equal(fixture.state.rows.get('admin-security:admin-1').updated_by, 'admin-1');
  assert.equal(await fixture.service.saveAdminLoginOtpEnabled('admin-1', true), true);
  assert.equal(await fixture.service.getAdminLoginOtpEnabled('admin-1'), true);
  assert.ok(fixture.state.events.every((event) => event.filters.key !== 'global' && event.payload?.key !== 'global'));
});

test('administrator OTP first save creates only the personal settings row', async () => {
  const { state, service } = settingsFixture();
  assert.equal(await service.saveAdminLoginOtpEnabled('admin-1', false), false);
  assert.deepEqual([...state.rows.keys()], ['admin-security:admin-1']);
  assert.equal(state.rows.get('admin-security:admin-1').value.loginOtpEnabled, false);
});

test('personal settings retry concurrent changes while preserving unrelated values', async () => {
  const { state, service } = settingsFixture([personalRow('admin-1', { loginOtpEnabled: true, theme: 'old' })]);
  state.conflict = { ...personalRow('admin-1', { loginOtpEnabled: true, theme: 'new', language: 'en' }), updated_at: '2026-10-11T02:00:00.000Z' };
  await service.saveAdminLoginOtpEnabled('admin-1', false);
  assert.deepEqual(state.rows.get('admin-security:admin-1').value, { loginOtpEnabled: false, theme: 'new', language: 'en' });
  const empty = settingsFixture();
  empty.state.conflict = personalRow('admin-1', { theme: 'new' });
  await empty.service.saveAdminLoginOtpEnabled('admin-1', false);
  assert.equal(empty.state.rows.get('admin-security:admin-1').value.theme, 'new');
});

test('personal OTP read and write failures fail closed and reject nonboolean updates', async () => {
  const fixture = settingsFixture();
  fixture.state.error = { message: 'Unavailable' };
  await assert.rejects(fixture.service.getAdminLoginOtpEnabled('admin-1'), { statusCode: 503 });
  await assert.rejects(fixture.service.saveAdminLoginOtpEnabled('admin-1', false), { statusCode: 503 });
  fixture.state.error = null;
  fixture.state.writeError = { message: 'Unavailable' };
  await assert.rejects(fixture.service.saveAdminLoginOtpEnabled('admin-1', false), { statusCode: 503 });
  fixture.state.writeError = null;
  for (const value of [undefined, null, 0, 'false']) {
    await assert.rejects(fixture.service.saveAdminLoginOtpEnabled('admin-1', value), { statusCode: 400 });
  }
  assert.equal(fixture.state.rows.size, 0);
});

function controllerFixture() {
  const fixture = settingsFixture();
  const events = [];
  const account = {
    _id: 'admin-1', name: 'Administrator', role: 'admin', status: 'active',
    async comparePassword(value) { events.push(['password', value]); return value === ' correct password '; },
  };
  const controller = loadBackend('controllers/adminSecurityController.js', {
    '../services/adminSecurityService': fixture.service,
    '../services/supabaseAccountService': { async findSupabaseAccount(field, id) { events.push(['account', field, id]); return account; } },
  });
  const request = (body = {}) => ({ user: { ...account }, body });
  return { ...fixture, events, account, controller, request };
}

test('OTP settings fetch and save are restricted to the authenticated administrator account', async () => {
  const fixture = controllerFixture();
  const initial = await callController(fixture.controller.getAdminOtpSettings, fixture.request({ userId: 'admin-2' }));
  assert.equal(initial.failure, undefined);
  assert.deepEqual(plain(initial.response.body.settings), { enabled: true, scope: 'account' });
  const req = fixture.request({ enabled: false, currentPassword: ' correct password ', userId: 'admin-2', id: 'admin-2' });
  const saved = await callController(fixture.controller.saveAdminOtpSettings, req);
  assert.equal(saved.failure, undefined);
  assert.deepEqual(plain(saved.response.body.settings), { enabled: false, scope: 'account' });
  assert.deepEqual(fixture.events[0], ['account', 'id', 'admin-1']);
  assert.deepEqual(fixture.events[1], ['password', ' correct password ']);
  assert.deepEqual([...fixture.state.rows.keys()], ['admin-security:admin-1']);
  assert.equal(req.auditLogContext.targetId, 'admin-1');
  assert.equal(JSON.stringify(req.auditLogContext).includes('correct password'), false);
});

test('OTP settings reject missing, incorrect and malformed password or enabled input without saving', async () => {
  const fixture = controllerFixture();
  for (const body of [
    { enabled: false },
    { enabled: false, currentPassword: '' },
    { enabled: false, currentPassword: 'wrong' },
    { enabled: 'false', currentPassword: ' correct password ' },
    { currentPassword: ' correct password ' },
  ]) {
    const result = await callController(fixture.controller.saveAdminOtpSettings, fixture.request(body));
    assert.equal(result.failure.statusCode, 400);
  }
  assert.equal(fixture.state.rows.size, 0);
});

test('OTP settings cannot be used by other roles or unavailable administrator accounts', async () => {
  const fixture = controllerFixture();
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    const req = { user: { ...fixture.account, role }, body: { enabled: false, currentPassword: ' correct password ' } };
    assert.equal((await callController(fixture.controller.getAdminOtpSettings, req)).failure.statusCode, 403);
    assert.equal((await callController(fixture.controller.saveAdminOtpSettings, req)).failure.statusCode, 403);
  }
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.account.status = status;
    const req = { user: { ...fixture.account, status: 'active' }, body: { enabled: false, currentPassword: ' correct password ' } };
    assert.equal((await callController(fixture.controller.saveAdminOtpSettings, req)).failure.statusCode, 403);
  }
  assert.equal(fixture.state.rows.size, 0);
});

function loginFixture(preferenceService) {
  const events = [];
  const state = { enabled: true, error: null, captchaValid: true, familiarDevice: true };
  const user = {
    _id: 'admin-1', name: 'Administrator', username: 'admin', email: 'admin@gmail.com',
    role: 'admin', status: 'active', password: 'test-hash', tokenVersion: 3,
    failedLoginAttempts: 0, forcePasswordChange: false,
    async comparePassword(value) { events.push(['password']); return value === 'correct-password'; },
    async save() { events.push(['save']); },
  };
  const settings = {
    user: { emailVerificationRequired: true },
    security: { maxLoginAttempts: 3, accountLockoutDurationMinutes: 2 },
    maintenance: { maintenanceModeEnabled: false, maintenanceMessage: 'Scheduled maintenance' },
  };
  const challenge = {
    userId: user._id, otpHash: 'otp-hash', remember: true, failedAttempts: 0,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    async save() { events.push(['challenge-save']); },
  };
  const controller = loadBackend('controllers/authController.js', {
    jsonwebtoken: { sign(claims, secret, options) { events.push(['token', plain(claims), plain(options)]); return 'test-session-token'; } },
    bcryptjs: { hash: async () => 'otp-hash', compare: async (value) => value === '123456' },
    '../services/gmailService': { async sendEmailViaGmail(payload) { events.push(['email', plain(payload)]); return { sent: true }; } },
    '../services/supabaseSettingsService': { getAppSettings: async () => settings },
    '../services/mathCaptchaService': { async consumeVerificationToken(token, action) {
      assert.equal(action, 'login');
      return Boolean(token) && state.captchaValid;
    } },
    '../services/adminSecurityService': { async getAdminLoginOtpEnabled(id) { events.push(['preference', id]); if (state.error) throw state.error; return preferenceService ? preferenceService.getAdminLoginOtpEnabled(id) : state.enabled; } },
    '../services/supabaseAccountService': {
      findSupabaseAccountByUsername: async () => user,
      findSupabaseAccountByEmail: async () => user,
      findSupabaseAccount: async () => user,
    },
    '../services/supabaseAuthPersistenceService': {
      consumeOpenChallenges: async (...args) => { events.push(['consume', ...args]); },
      createChallenge: async (payload) => { events.push(['challenge', plain(payload)]); },
      createSession: async (payload) => { events.push(['session', plain(payload)]); },
      sessionExists: async () => state.familiarDevice,
      recordLoginAttempt: async (payload) => { events.push(['attempt', plain(payload)]); },
      findActiveChallenge: async () => challenge,
      findOpenChallenge: async () => challenge,
    },
    '../utils/fileStorage': { resolveStoredFileUrl: (_req, value) => value },
  }, {
    process: { env: { JWT_SECRET: 'test-secret' } },
  });
  const request = (overrides = {}) => ({
    body: { username: 'admin', password: 'correct-password', captchaToken: 'verified', ...overrides },
    headers: { 'user-agent': 'test-device' }, ip: '127.0.0.1',
  });
  return { controller, events, state, user, settings, challenge, request };
}

test('OTP-off administrator login completes normal session issuance and consumes old challenges', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  fixture.user.failedLoginAttempts = 2;
  fixture.user.lockUntil = new Date(Date.now() - 60000);
  const startedAt = Date.now();
  const result = await callController(fixture.controller.login, fixture.request());
  assert.equal(result.failure, undefined);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.response.body.requiresOtp, false);
  assert.equal(result.response.body.token, 'test-session-token');
  assert.equal(result.response.body.user.id, 'admin-1');
  assert.equal(result.response.body.user.password, undefined);
  assert.equal(result.response.body.challengeToken, undefined);
  assert.equal(fixture.user.failedLoginAttempts, 0);
  assert.equal(fixture.user.lockUntil, null);
  assert.ok(fixture.user.lastLoginAt.getTime() >= startedAt);
  assert.equal(fixture.user.lastLoginAt.getTime(), fixture.user.lastActivityAt.getTime());
  assert.deepEqual(fixture.events.find(([name]) => name === 'consume'), ['consume', 'admin-1']);
  const session = fixture.events.find(([name]) => name === 'session')[1];
  assert.equal(session.userId, 'admin-1');
  assert.equal(session.remember, false);
  assert.equal(session.userAgent, 'test-device');
  assert.equal(session.ipAddress, '127.0.0.1');
  assert.ok(new Date(session.expiresAt).getTime() - startedAt >= 24 * 60 * 60 * 1000);
  const token = fixture.events.find(([name]) => name === 'token');
  assert.equal(token[1].id, 'admin-1');
  assert.equal(token[1].jti, session.tokenId);
  assert.equal(token[1].tokenVersion, 3);
  assert.equal(token[2].expiresIn, '1d');
  assert.equal(token[2].issuer, 'edumatch-api');
  const attempt = fixture.events.find(([name]) => name === 'attempt')[1];
  assert.equal(attempt.outcome, 'success');
  assert.equal(attempt.reason, 'Login successful (admin OTP disabled)');
  assert.equal(fixture.events.some(([name]) => name === 'challenge' || name === 'email'), false);
});

test('personal OTP preference applies on the next login and enabled policy ignores body bypass flags', async () => {
  const fixture = loginFixture();
  const enabled = await callController(fixture.controller.login, fixture.request({ requiresOtp: false, skipOtp: true, enabled: false, loginOtpEnabled: false }));
  assert.equal(enabled.failure, undefined);
  assert.equal(enabled.response.statusCode, 202);
  assert.equal(enabled.response.body.requiresOtp, true);
  assert.equal(enabled.response.body.token, undefined);
  fixture.state.enabled = false;
  assert.equal((await callController(fixture.controller.login, fixture.request())).response.statusCode, 200);
  fixture.state.enabled = true;
  assert.equal((await callController(fixture.controller.login, fixture.request())).response.statusCode, 202);
  assert.equal(fixture.events.filter(([name]) => name === 'session').length, 1);
});

test('OTP-off administrator login preserves remember-me and forced password change requirements', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  fixture.user.forcePasswordChange = true;
  fixture.user.temporaryPasswordIssuedAt = '2026-10-10T01:00:00.000Z';
  const startedAt = Date.now();
  const result = await callController(fixture.controller.login, fixture.request({ remember: 'true' }));
  assert.equal(result.failure, undefined);
  assert.equal(result.response.body.redirectPath, '/auth/change-password');
  assert.equal(result.response.body.user.forcePasswordChange, true);
  assert.equal(fixture.user.forcePasswordChange, true);
  assert.equal(result.response.body.user.temporaryPasswordIssuedAt, fixture.user.temporaryPasswordIssuedAt);
  const session = fixture.events.find(([name]) => name === 'session')[1];
  assert.equal(session.remember, true);
  assert.ok(new Date(session.expiresAt).getTime() - startedAt >= 30 * 24 * 60 * 60 * 1000);
  const token = fixture.events.find(([name]) => name === 'token');
  assert.equal(token[1].remember, true);
  assert.equal(token[2].expiresIn, '30d');
});

test('other roles always require OTP without reading an administrator preference', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    fixture.user.role = role;
    const result = await callController(fixture.controller.login, fixture.request({ loginOtpEnabled: false }));
    assert.equal(result.failure, undefined);
    assert.equal(result.response.statusCode, 202);
    assert.equal(result.response.body.requiresOtp, true);
  }
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session'), false);
});

test('saved OTP-off preferences and client bypass flags cannot disable OTP for other roles', async () => {
  const preferences = settingsFixture([
    personalRow('admin-1', { loginOtpEnabled: false }),
    { key: 'account-security:admin-1', value: { loginOtpEnabled: false }, updated_at: '2026-10-11T01:00:00.000Z' },
  ]);
  const fixture = loginFixture(preferences.service);
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    fixture.user.role = role;
    const result = await callController(fixture.controller.login, fixture.request({
      role: 'admin', userId: 'admin-1', requiresOtp: false, skipOtp: true, enabled: false, loginOtpEnabled: false,
    }));
    assert.equal(result.failure, undefined);
    assert.equal(result.response.statusCode, 202);
    assert.equal(result.response.body.requiresOtp, true);
    assert.equal(result.response.body.token, undefined);
  }
  assert.equal(preferences.state.events.length, 0);
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session'), false);
  fixture.user.role = 'admin';
  const administrator = await callController(fixture.controller.login, fixture.request());
  assert.equal(administrator.failure, undefined);
  assert.equal(administrator.response.statusCode, 200);
  assert.equal(administrator.response.body.requiresOtp, false);
  assert.deepEqual(preferences.state.events.map(event => event.filters.key), ['admin-security:admin-1']);
});

test('OTP-off does not bypass CAPTCHA, incorrect passwords or account lockouts', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  assert.equal((await callController(fixture.controller.login, fixture.request({ captchaToken: '' }))).failure.statusCode, 400);
  fixture.state.captchaValid = false;
  assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 400);
  fixture.state.captchaValid = true;
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await callController(fixture.controller.login, fixture.request({ password: 'wrong' }))).failure.statusCode, 401);
  }
  assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 423);
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session' || name === 'challenge'), false);
});

test('OTP-off does not bypass inactive accounts, missing credentials or Gmail policy', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  for (const status of ['pending', 'inactive', 'suspended']) {
    fixture.user.status = status;
    assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 403);
  }
  fixture.user.status = 'active';
  fixture.user.password = '';
  assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 403);
  fixture.user.password = 'test-hash';
  fixture.user.email = 'admin@example.com';
  assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 400);
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session' || name === 'challenge'), false);
});

test('unavailable personal settings fail closed without issuing a login challenge or session', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  fixture.state.error = Object.assign(new Error('Unavailable'), { statusCode: 503 });
  const result = await callController(fixture.controller.login, fixture.request());
  assert.equal(result.failure.statusCode, 503);
  assert.equal(fixture.events.some(([name]) => name === 'session' || name === 'challenge'), false);
  assert.equal(fixture.user.lastLoginAt, undefined);
});

test('maintenance policy remains enforced for other roles while administrator sign-in stays available', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  fixture.settings.maintenance.maintenanceModeEnabled = true;
  for (const role of ['student', 'teacher', 'headteacher', 'secretary']) {
    fixture.user.role = role;
    assert.equal((await callController(fixture.controller.login, fixture.request())).failure.statusCode, 503);
  }
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session'), false);
  fixture.user.role = 'admin';
  assert.equal((await callController(fixture.controller.login, fixture.request())).response.statusCode, 200);
});

test('OTP-off administrator sign-in still sends the existing new-device security alert', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  fixture.state.familiarDevice = false;
  assert.equal((await callController(fixture.controller.login, fixture.request())).response.statusCode, 200);
  const emails = fixture.events.filter(([name]) => name === 'email');
  assert.equal(emails.length, 1);
  assert.equal(emails[0][1].subject, 'EduMatch security alert: new administrator sign-in');
});

test('an outstanding OTP challenge still needs a valid code even when personal OTP is off', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  const request = fixture.request({ challengeToken: 'a'.repeat(64), otpCode: '000000' });
  const rejected = await callController(fixture.controller.verifyLoginOtp, request);
  assert.equal(rejected.failure.statusCode, 401);
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session'), false);
  request.body.otpCode = '123456';
  const verified = await callController(fixture.controller.verifyLoginOtp, request);
  assert.equal(verified.failure, undefined);
  assert.equal(verified.response.statusCode, 200);
  assert.equal(verified.response.body.token, 'test-session-token');
});

test('resending an outstanding challenge never authenticates an OTP-off administrator', async () => {
  const fixture = loginFixture();
  fixture.state.enabled = false;
  const result = await callController(fixture.controller.resendLoginOtp, fixture.request({ challengeToken: 'a'.repeat(64) }));
  assert.equal(result.failure, undefined);
  assert.equal(result.response.statusCode, 202);
  assert.equal(result.response.body.requiresOtp, true);
  assert.equal(result.response.body.token, undefined);
  assert.equal(fixture.events.some(([name]) => name === 'preference' || name === 'session'), false);
});
