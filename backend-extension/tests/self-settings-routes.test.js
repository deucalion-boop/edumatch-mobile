'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { runInNewContext } = require('node:vm');

const backendRoot = join(__dirname, '../../backend');
const roles = ['admin', 'secretary', 'headteacher', 'teacher', 'student'];

function loadBackend(relativePath, mocks) {
  const filename = join(backendRoot, relativePath);
  const module = { exports: {} };
  runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    process: { env: { JWT_SECRET: 'test-secret' } },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      return require(name.startsWith('.') ? join(dirname(filename), name) : name);
    },
  });
  return module.exports;
}

function authenticationFixture() {
  const events = [];
  const user = { _id: 'signed-in-user', role: 'student', status: 'active', tokenVersion: 2, forcePasswordChange: false };
  const session = { _id: 'session-one', lastSeenAt: new Date(Date.now() - 1000).toISOString() };
  const state = { claims: { id: user._id, jti: 'token-one', tokenVersion: 2 }, session, user };
  const settings = {
    security: { sessionTimeoutMinutes: 15 },
    maintenance: { maintenanceModeEnabled: false, maintenanceMessage: 'School maintenance' },
  };
  const middleware = loadBackend('middlewares/authMiddleware.js', {
    jsonwebtoken: { verify(token, secret, options) {
      assert.equal(token, 'session-token');
      assert.equal(secret, 'test-secret');
      assert.deepEqual(Array.from(options.algorithms), ['HS256']);
      return state.claims;
    } },
    '../services/supabaseAccountService': {
      async findSupabaseAccount(field, id) { assert.equal(field, 'id'); assert.equal(id, user._id); return state.user; },
      async touchSupabaseAccountActivity(...args) { events.push(['activity', ...args]); },
    },
    '../services/supabaseAuthPersistenceService': {
      async findActiveSession(id, tokenId) { assert.equal(id, user._id); assert.equal(tokenId, state.claims.jti); return state.session; },
      async revokeSession(...args) { events.push(['revoke', ...args]); },
      async touchSession(...args) { events.push(['session', ...args]); },
    },
    '../services/supabaseSettingsService': { async getAppSettings() { return settings; } },
  });
  async function authenticate(method = 'GET', path = '/profile', overrides = {}) {
    const req = { headers: { authorization: 'Bearer session-token' }, baseUrl: '/api/auth', method, path, ...overrides };
    let called = false;
    let failure;
    await middleware(req, {}, error => { called = true; failure = error; });
    assert.equal(called, true);
    return { req, failure };
  }
  return { authenticate, events, user, state, settings, session };
}

test('shared authentication routes do not expose an OTP preference endpoint', () => {
  const routes = [];
  const router = Object.fromEntries(['get', 'put', 'post', 'delete'].map(method => [method, (path, ...handlers) => routes.push({ method, path, handlers })]));
  loadBackend('routes/authRoutes.js', {
    express: { Router: () => router },
    '../middlewares/authMiddleware': () => {},
    '../controllers/authController': {},
    '../controllers/passwordController': {},
    '../controllers/securityController': {},
    '../controllers/selfProfileController': {},
    '../controllers/adminSecurityController': {},
    '../controllers/captchaSettingsController': {},
    '../middlewares/rateLimiters': {},
    '../utils/uploadMiddleware': { uploadProfileImage: { single: () => () => {} } },
  });
  assert.equal(routes.some(route => route.path === '/settings/otp'), false);
  assert.equal(routes.some(route => route.path === '/login/verify-otp'), true);
  assert.equal(routes.some(route => route.path === '/login/resend-otp'), true);
});

test('active accounts in every role can load and update their profile through authentication', async () => {
  const fixture = authenticationFixture();
  for (const role of roles) {
    fixture.user.role = role;
    for (const method of ['GET', 'PUT']) {
      const result = await fixture.authenticate(method);
      assert.equal(result.failure, undefined, `${role} ${method}`);
      assert.equal(result.req.user, fixture.user);
      assert.equal(result.req.session, fixture.session);
      assert.equal(result.req.token, 'session-token');
    }
  }
  assert.equal(fixture.events.filter(([event]) => event === 'activity').length, roles.length * 2);
  assert.equal(fixture.events.filter(([event]) => event === 'session').length, roles.length * 2);
});

test('temporary-password accounts must change their password before opening or saving their profile', async () => {
  const fixture = authenticationFixture();
  fixture.user.forcePasswordChange = true;
  for (const role of roles) {
    fixture.user.role = role;
    for (const method of ['GET', 'PUT']) {
      const result = await fixture.authenticate(method);
      assert.equal(result.failure.statusCode, 403, `${role} ${method}`);
      assert.match(result.failure.message, /Password change required/);
      assert.equal(result.req.user, undefined);
    }
    const passwordChange = await fixture.authenticate('POST', '/change-password');
    assert.equal(passwordChange.failure, undefined);
    assert.equal(passwordChange.req.user, fixture.user);
  }
  assert.equal(fixture.events.filter(([event]) => event === 'activity').length, roles.length);
});

test('unauthenticated, inactive and revoked sessions cannot reach a self-profile handler', async () => {
  for (const method of ['GET', 'PUT']) {
    const fixture = authenticationFixture();
    assert.equal((await fixture.authenticate(method, '/profile', { headers: {} })).failure.statusCode, 401);
    for (const status of ['pending', 'inactive', 'suspended']) {
      fixture.user.status = status;
      const result = await fixture.authenticate(method);
      assert.equal(result.failure.statusCode, 403);
      assert.equal(result.req.user, undefined);
    }
    fixture.user.status = 'active';
    fixture.state.claims.tokenVersion = 1;
    assert.equal((await fixture.authenticate(method)).failure.statusCode, 401);
    fixture.state.claims.tokenVersion = 2;
    fixture.state.session = null;
    assert.equal((await fixture.authenticate(method)).failure.statusCode, 401);
    assert.equal(fixture.events.length, 0);
  }
});

test('profile routes retain school maintenance restrictions while password changes remain available', async () => {
  const fixture = authenticationFixture();
  fixture.settings.maintenance.maintenanceModeEnabled = true;
  for (const role of roles) {
    fixture.user.role = role;
    for (const method of ['GET', 'PUT']) {
      const result = await fixture.authenticate(method);
      if (role === 'admin') assert.equal(result.failure, undefined);
      else {
        assert.equal(result.failure.statusCode, 503);
        assert.equal(result.failure.message, 'School maintenance');
        assert.equal(result.req.user, undefined);
      }
    }
    assert.equal((await fixture.authenticate('POST', '/change-password')).failure, undefined);
  }
});

test('opening settings does not revive an expired session', async () => {
  for (const method of ['GET', 'PUT']) {
    const fixture = authenticationFixture();
    fixture.session.lastSeenAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const result = await fixture.authenticate(method);
    assert.equal(result.failure.statusCode, 401);
    assert.match(result.failure.message, /inactivity/);
    assert.equal(result.req.user, undefined);
    assert.deepEqual(fixture.events, [['revoke', fixture.user._id, fixture.session._id, 'Inactivity timeout']]);
  }
});
