'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { sendSuccess } = require('../../backend/utils/responseHelper');
const { assertGmailEmail } = require('../../backend/utils/emailPolicy');
const { USER_ROLES } = require('../../backend/constants/userRoles');

const backendRoot = join(__dirname, '../../backend');
const source = readFileSync(join(backendRoot, 'controllers/adminProfileController.js'), 'utf8');
const sharedSource = readFileSync(join(backendRoot, 'controllers/selfProfileController.js'), 'utf8');

function load(sourceText, requireMock) {
  const module = { exports: {} };
  runInNewContext(sourceText, { module, exports: module.exports, require: requireMock, Buffer });
  return module.exports;
}

// Exercise the same extension/MIME policy used by the multipart parser without
// opening storage, database or HTTP services.
const multerMock = Object.assign(() => ({}), { memoryStorage() { return {}; } });
const { isAllowedProfileImage } = load(
  readFileSync(join(backendRoot, 'utils/uploadMiddleware.js'), 'utf8'),
  name => name === 'multer' ? multerMock : require(name)
);

function harness(options = {}) {
  const lookups = [];
  const uploads = [];
  let saves = 0;
  const requestRole = options.role || 'admin';
  const user = {
    _id: `current-${requestRole}`, name: 'School Admin', username: 'schooladmin', email: 'admin@gmail.com',
    role: options.accountRole || requestRole, status: options.status || 'active', profileImage: 'uploads/original.png',
    department: '', contactNumber: '09123456789', forcePasswordChange: true,
    password: 'secret-password-hash', tokenVersion: 3, failedLoginAttempts: 1,
    invite: { tokenHash: 'invite-secret' }, resetPassword: { tokenHash: 'reset-secret' },
    async save() { saves += 1; if (options.saveError) throw options.saveError; },
  };
  const shared = load(sharedSource, name => {
    if (name === '../services/supabaseAccountService') return {
      async findSupabaseAccount(field, id) {
        lookups.push({ field, id });
        if (field === 'email') return options.duplicateEmail ? { _id: 'another-account' } : null;
        return options.missingAccount ? null : user;
      },
    };
    if (name === '../services/storageService') return {
      async uploadFile(payload) {
        uploads.push(payload);
        if (options.uploadError) throw options.uploadError;
        return { storedPath: options.emptyStoredPath ? '' : 'uploads/admin/new-avatar.png' };
      },
    };
    if (name === '../utils/fileStorage') return { resolveStoredFileUrl(req, path) { return `https://api.example.test/${path}`; } };
    if (name === '../utils/uploadMiddleware') return { isAllowedProfileImage };
    if (name === '../utils/responseHelper') return { sendSuccess };
    if (name === '../utils/emailPolicy') return { assertGmailEmail };
    if (name === '../constants/userRoles') return { USER_ROLES };
    throw new Error(`Unexpected import: ${name}`);
  });
  const controllers = options.shared ? shared : load(source, name => {
    if (name === './selfProfileController') return shared;
    throw new Error(`Unexpected import: ${name}`);
  });
  async function invoke(handler, request = {}) {
    let error;
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controllers[handler]({ user: { _id: user._id, role: requestRole }, body: {}, ...request }, res, value => { error = value; });
    return { res, error };
  }
  return { invoke, user, lookups, uploads, get saves() { return saves; } };
}

function image(overrides = {}) {
  return { originalname: 'avatar.png', mimetype: 'image/png', size: 12, buffer: Buffer.alloc(12), ...overrides };
}

test('admin profile loads only the authenticated account and returns a safe complete user', async () => {
  const h = harness();
  const { res, error } = await h.invoke('getAdminProfile', { params: { id: 'another-admin' }, query: { id: 'another-admin' } });
  assert.equal(error, undefined);
  assert.deepEqual(h.lookups, [{ field: 'id', id: 'current-admin' }]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.id, 'current-admin');
  assert.equal(res.body.user.username, 'schooladmin');
  assert.equal(res.body.user.profileImage, 'https://api.example.test/uploads/original.png');
  assert.equal(res.body.user.forcePasswordChange, true);
  assert.equal(res.body.user.contactNumber, '09123456789');
  for (const secret of ['password', 'password_hash', 'tokenVersion', 'invite', 'resetPassword', 'failedLoginAttempts', 'save']) {
    assert.equal(Object.hasOwn(res.body.user, secret), false, `${secret} must not be returned`);
  }
  assert.equal(h.saves, 0);
});

test('picture-only upload ignores identity, role, credential and settings fields from the body', async () => {
  const h = harness();
  const file = image();
  const { res, error } = await h.invoke('updateAdminProfile', {
    file,
    body: { id: 'other-user', username: 'new-user', role: 'student', status: 'suspended', password: 'injected', profileImage: 'https://attacker.test/picture.png', department: 'Science', forcePasswordChange: false },
  });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].file, file);
  assert.equal(h.uploads[0].folder, 'profile-images/admin/current-admin');
  assert.equal(h.saves, 1);
  assert.equal(h.user.name, 'School Admin');
  assert.equal(h.user.username, 'schooladmin');
  assert.equal(h.user.email, 'admin@gmail.com');
  assert.equal(h.user.role, 'admin');
  assert.equal(h.user.status, 'active');
  assert.equal(h.user.department, '');
  assert.equal(h.user.forcePasswordChange, true);
  assert.equal(h.user.password, 'secret-password-hash');
  assert.equal(h.user.profileImage, 'uploads/admin/new-avatar.png');
  assert.equal(res.body.user.profileImage, 'https://api.example.test/uploads/admin/new-avatar.png');
});

test('details-only update trims name, normalizes email and preserves picture and immutable username', async () => {
  const h = harness();
  const { res, error } = await h.invoke('updateAdminProfile', {
    body: { name: '  Updated Admin  ', email: ' UPDATED.ADMIN@GMAIL.COM ', username: 'changed-name', role: 'student', id: 'other-admin', password: 'injected', loginOtpEnabled: false },
  });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.lookups, [{ field: 'id', id: 'current-admin' }, { field: 'email', id: 'updated.admin@gmail.com' }]);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.saves, 1);
  assert.equal(h.user.name, 'Updated Admin');
  assert.equal(h.user.email, 'updated.admin@gmail.com');
  assert.equal(h.user.username, 'schooladmin');
  assert.equal(h.user.profileImage, 'uploads/original.png');
  assert.equal(h.user.role, 'admin');
  assert.equal(h.user.password, 'secret-password-hash');
  assert.equal(Object.hasOwn(h.user, 'loginOtpEnabled'), false);
  assert.equal(res.body.user.name, 'Updated Admin');
  assert.equal(res.body.user.email, 'updated.admin@gmail.com');
  assert.equal(res.body.user.username, 'schooladmin');
  assert.equal(res.body.requiresSignIn, true);
  assert.equal(h.user.invite.tokenHash, '');
  assert.equal(h.user.invite.expiresAt, null);
  assert.equal(h.user.resetPassword.tokenHash, '');
  assert.equal(h.user.resetPassword.expiresAt, null);
});

test('name-only edits and unchanged normalized email preserve old auth state and do not require sign-in', async () => {
  for (const body of [{ name: 'New Name' }, { email: ' ADMIN@GMAIL.COM ' }]) {
    const h = harness();
    const { res, error } = await h.invoke('updateAdminProfile', { body });
    assert.equal(error, undefined);
    assert.equal(h.saves, 1);
    assert.equal(h.uploads.length, 0);
    assert.deepEqual(h.lookups, [{ field: 'id', id: 'current-admin' }]);
    assert.equal(h.user.email, 'admin@gmail.com');
    assert.equal(h.user.profileImage, 'uploads/original.png');
    assert.equal(h.user.invite.tokenHash, 'invite-secret');
    assert.equal(h.user.resetPassword.tokenHash, 'reset-secret');
    assert.equal(res.body.requiresSignIn, false);
  }
});

test('multipart profile updates can include editable details and an image together', async () => {
  const h = harness();
  const { res, error } = await h.invoke('updateAdminProfile', { file: image(), body: { name: ' Admin With Picture ', email: 'admin@gmail.com' } });
  assert.equal(error, undefined);
  assert.equal(h.saves, 1);
  assert.equal(h.uploads.length, 1);
  assert.equal(res.body.user.name, 'Admin With Picture');
  assert.equal(res.body.user.profileImage, 'https://api.example.test/uploads/admin/new-avatar.png');
  assert.equal(res.body.requiresSignIn, false);
});

test('invalid names and emails are rejected before uploading or saving', async () => {
  for (const body of [
    { name: '' }, { name: '   ' }, { name: null }, { name: [] }, { name: 123 },
    { email: '' }, { email: 'invalid' }, { email: 'admin@example.com' }, { email: 'a..b@gmail.com' },
    { email: null }, { email: ['admin@gmail.com'] }, { email: {} },
  ]) {
    const h = harness();
    const { res, error } = await h.invoke('updateAdminProfile', { body, file: image() });
    assert.equal(error?.statusCode, 400);
    assert.equal(res.body, undefined);
    assert.equal(h.saves, 0);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.user.name, 'School Admin');
    assert.equal(h.user.email, 'admin@gmail.com');
  }
});

test('duplicate email is rejected before profile changes and username-only requests cannot edit it', async () => {
  const h = harness({ duplicateEmail: true });
  const duplicate = await h.invoke('updateAdminProfile', { body: { name: 'New Name', email: ' TAKEN@GMAIL.COM ' }, file: image() });
  assert.equal(duplicate.error?.statusCode, 409);
  assert.equal(duplicate.error?.message, 'Email already exists');
  assert.equal(duplicate.res.body, undefined);
  assert.equal(h.saves, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.user.name, 'School Admin');
  assert.equal(h.user.email, 'admin@gmail.com');
  const username = await h.invoke('updateAdminProfile', { body: { username: 'new-user' } });
  assert.equal(username.error?.statusCode, 400);
  assert.equal(h.user.username, 'schooladmin');
  assert.equal(h.saves, 0);
});

test('self profile handlers require an authenticated admin and defend against a changed stored role', async () => {
  for (const handler of ['getAdminProfile', 'updateAdminProfile']) {
    for (const scenario of [
      { request: { user: null }, options: {}, code: 401 },
      ...USER_ROLES.filter(role => role !== 'admin').map(role => ({ request: { user: { _id: role, role } }, options: {}, code: 403 })),
      { request: {}, options: { accountRole: 'teacher' }, code: 403 },
      { request: {}, options: { status: 'suspended' }, code: 403 },
      { request: {}, options: { missingAccount: true }, code: 404 },
    ]) {
      const h = harness(scenario.options);
      const { res, error } = await h.invoke(handler, { file: image(), ...scenario.request });
      assert.equal(error?.statusCode, scenario.code);
      assert.equal(res.body, undefined);
      assert.equal(h.saves, 0);
      assert.equal(h.uploads.length, 0);
    }
  }
});

for (const role of USER_ROLES) {
  test(`${role} can read and edit their own profile while username and account permissions remain protected`, async () => {
    const h = harness({ shared: true, role });
    Object.assign(h.user, {
      strand: 'STEM', subject: 'Biology', department: 'Science', gradeLevel: '10',
      sectionId: 'assigned-section', advisorySectionId: 'assigned-advisory',
      headteacherId: 'assigned-headteacher', loginOtpEnabled: true,
    });
    const protectedFields = [
      '_id', 'username', 'role', 'status', 'strand', 'subject', 'department', 'gradeLevel',
      'sectionId', 'advisorySectionId', 'headteacherId', 'contactNumber', 'password',
      'tokenVersion', 'failedLoginAttempts', 'forcePasswordChange', 'loginOtpEnabled',
    ];
    const initial = Object.fromEntries(protectedFields.map(field => [field, h.user[field]]));

    const loaded = await h.invoke('getMyProfile', { params: { id: 'another-user' }, query: { id: 'another-user' } });
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.res.statusCode, 200);
    assert.equal(loaded.res.body.user.id, `current-${role}`);
    assert.equal(loaded.res.body.user.role, role);
    assert.equal(loaded.res.body.user.sectionId, 'assigned-section');
    assert.equal(loaded.res.body.user.advisorySectionId, 'assigned-advisory');
    assert.deepEqual(h.lookups, [{ field: 'id', id: `current-${role}` }]);
    for (const secret of ['password', 'tokenVersion', 'invite', 'resetPassword', 'loginOtpEnabled']) {
      assert.equal(Object.hasOwn(loaded.res.body.user, secret), false);
    }

    const renamed = await h.invoke('updateMyProfile', {
      params: { id: 'another-user' },
      body: {
        name: `  Updated ${role}  `, id: 'another-user', _id: 'another-user', username: 'replacement',
        role: role === 'admin' ? 'student' : 'admin', status: 'suspended',
        strand: 'ABM', subject: 'English', department: 'English', gradeLevel: '12',
        sectionId: 'other-section', advisorySectionId: 'other-advisory', headteacherId: 'other-headteacher',
        contactNumber: '00000000000', password: 'injected-password', tokenVersion: 0,
        failedLoginAttempts: 0, forcePasswordChange: false, loginOtpEnabled: false,
        profileImage: 'https://attacker.test/picture.png',
      },
    });
    assert.equal(renamed.error, undefined);
    assert.equal(renamed.res.statusCode, 200);
    assert.equal(renamed.res.body.user.name, `Updated ${role}`);
    assert.equal(renamed.res.body.requiresSignIn, false);
    assert.equal(h.user.profileImage, 'uploads/original.png');
    assert.equal(h.user.invite.tokenHash, 'invite-secret');
    assert.equal(h.user.resetPassword.tokenHash, 'reset-secret');
    for (const field of protectedFields) assert.equal(h.user[field], initial[field], `${field} must stay unchanged for ${role}`);

    const changed = await h.invoke('updateMyProfile', {
      file: image(), body: { email: ` UPDATED.${role.toUpperCase()}@GMAIL.COM `, username: 'replacement' },
    });
    assert.equal(changed.error, undefined);
    assert.equal(changed.res.statusCode, 200);
    assert.equal(changed.res.body.user.email, `updated.${role}@gmail.com`);
    assert.equal(changed.res.body.user.name, `Updated ${role}`);
    assert.equal(changed.res.body.requiresSignIn, true);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].folder, `profile-images/${role}/current-${role}`);
    assert.equal(h.user.invite.tokenHash, '');
    assert.equal(h.user.resetPassword.tokenHash, '');
    for (const field of protectedFields) assert.equal(h.user[field], initial[field], `${field} must stay unchanged for ${role}`);
    assert.equal(h.saves, 2);
    assert.ok(h.lookups.filter(lookup => lookup.field === 'id').every(lookup => lookup.id === `current-${role}`));
  });
}

test('shared profiles reject unauthenticated, unknown, inactive and missing accounts before mutation', async () => {
  for (const handler of ['getMyProfile', 'updateMyProfile']) {
    for (const scenario of [
      { request: { user: null }, options: {}, code: 401 },
      { request: { user: { role: 'student' } }, options: {}, code: 401 },
      { request: {}, options: { role: 'unknown-role' }, code: 403 },
      { request: {}, options: { accountRole: 'unknown-role' }, code: 403 },
      { request: {}, options: { missingAccount: true }, code: 404 },
      ...USER_ROLES.map(role => ({ request: {}, options: { role, status: 'suspended' }, code: 403 })),
      ...USER_ROLES.map(role => ({ request: {}, options: { role, status: 'pending' }, code: 403 })),
    ]) {
      const h = harness({ shared: true, ...scenario.options });
      const { res, error } = await h.invoke(handler, { body: { name: 'New Name' }, file: image(), ...scenario.request });
      assert.equal(error?.statusCode, scenario.code);
      assert.equal(res.body, undefined);
      assert.equal(h.saves, 0);
      assert.equal(h.uploads.length, 0);
    }
  }
});

test('shared profile rejects duplicate emails and username-only requests for every role', async () => {
  for (const role of USER_ROLES) {
    const h = harness({ shared: true, role, duplicateEmail: true });
    const duplicate = await h.invoke('updateMyProfile', { body: { name: 'New Name', email: ' TAKEN@GMAIL.COM ' }, file: image() });
    assert.equal(duplicate.error?.statusCode, 409);
    assert.equal(duplicate.res.body, undefined);
    assert.equal(h.user.name, 'School Admin');
    assert.equal(h.user.email, 'admin@gmail.com');
    const username = await h.invoke('updateMyProfile', { body: { username: 'replacement' } });
    assert.equal(username.error?.statusCode, 400);
    assert.equal(h.user.username, 'schooladmin');
    assert.equal(h.saves, 0);
    assert.equal(h.uploads.length, 0);
  }
});

test('profile update requires a supported, nonempty image no larger than 5 MB', async () => {
  for (const file of [
    undefined,
    image({ originalname: 'avatar.svg', mimetype: 'image/svg+xml' }),
    image({ originalname: 'avatar.jpg', mimetype: 'image/png' }),
    image({ buffer: Buffer.alloc(0), size: 0 }),
    image({ buffer: undefined }),
    image({ size: 5 * 1024 * 1024 + 1 }),
    image({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), size: 12 }),
  ]) {
    const h = harness();
    const { res, error } = await h.invoke('updateAdminProfile', { file });
    assert.equal(error?.statusCode, 400);
    assert.equal(res.body, undefined);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.saves, 0);
    assert.equal(h.user.profileImage, 'uploads/original.png');
  }
});

test('upload failure and missing storage path do not persist an image or report success', async () => {
  for (const options of [{ uploadError: new Error('Storage unavailable') }, { emptyStoredPath: true }]) {
    const h = harness(options);
    const { res, error } = await h.invoke('updateAdminProfile', { file: image() });
    assert.ok(error);
    assert.equal(res.body, undefined);
    assert.equal(h.saves, 0);
    assert.equal(h.user.profileImage, 'uploads/original.png');
  }
});

test('database failure is forwarded and never returns a success response', async () => {
  const saveError = new Error('Database unavailable');
  const h = harness({ saveError });
  const { res, error } = await h.invoke('updateAdminProfile', { file: image() });
  assert.equal(error, saveError);
  assert.equal(res.body, undefined);
  assert.equal(h.saves, 1);
});

test('admin self-profile and OTP routes share admin authentication and use their specific limiters', () => {
  const routes = [];
  const parsedImageFields = [];
  const auth = () => {};
  const adminOnly = () => {};
  const uploadLimiter = () => {};
  const accountSecurityLimiter = () => {};
  const imageParser = () => {};
  const profile = { getAdminProfile() {}, updateAdminProfile() {} };
  const security = { getAdminOtpSettings() {}, saveAdminOtpSettings() {} };
  const recaptcha = { getRecaptchaSettings() {}, saveRecaptchaSettings() {} };
  const router = {
    use(...middleware) { routes.push(['use', ...middleware]); },
    route() { return { post() { return this; }, get() { return this; }, put() { return this; }, delete() { return this; } }; },
    get(path, ...handlers) { routes.push(['get', path, ...handlers]); },
    put(path, ...handlers) { routes.push(['put', path, ...handlers]); },
    post() {}, patch() {},
  };
  load(readFileSync(join(backendRoot, 'routes/adminRoutes.js'), 'utf8'), name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../middlewares/authMiddleware') return auth;
    if (name === '../middlewares/roleMiddleware') return role => { assert.equal(role, 'admin'); return adminOnly; };
    if (name === '../controllers/adminProfileController') return profile;
    if (name === '../controllers/adminSecurityController') return security;
    if (name === '../controllers/recaptchaSettingsController') return recaptcha;
    if (name === '../middlewares/rateLimiters') return { uploadLimiter, accountSecurityLimiter };
    if (name === '../utils/uploadMiddleware') return {
      uploadProfileImage: { single(field) { parsedImageFields.push(field); return imageParser; } },
    };
    return {};
  });
  assert.deepEqual(routes[0], ['use', auth, adminOnly]);
  assert.deepEqual(routes.find(route => route[0] === 'get' && route[1] === '/profile'), ['get', '/profile', profile.getAdminProfile]);
  assert.deepEqual(routes.find(route => route[0] === 'put' && route[1] === '/profile'), ['put', '/profile', uploadLimiter, imageParser, profile.updateAdminProfile]);
  assert.ok(parsedImageFields.length > 0);
  assert.ok(parsedImageFields.every(field => field === 'profileImage'));
  assert.deepEqual(routes.find(route => route[0] === 'get' && route[1] === '/settings/otp'), ['get', '/settings/otp', security.getAdminOtpSettings]);
  assert.deepEqual(routes.find(route => route[0] === 'put' && route[1] === '/settings/otp'), ['put', '/settings/otp', accountSecurityLimiter, security.saveAdminOtpSettings]);
  assert.notEqual(profile.updateAdminProfile, security.saveAdminOtpSettings);
  assert.deepEqual(routes.find(route => route[0] === 'get' && route[1] === '/settings/recaptcha'), ['get', '/settings/recaptcha', recaptcha.getRecaptchaSettings]);
  assert.deepEqual(routes.find(route => route[0] === 'put' && route[1] === '/settings/recaptcha'), ['put', '/settings/recaptcha', accountSecurityLimiter, recaptcha.saveRecaptchaSettings]);
});

test('shared self-profile routes authenticate every role and use the existing safe image parser', () => {
  const routes = [];
  const parsedImageFields = [];
  const auth = () => {};
  const uploadLimiter = () => {};
  const imageParser = () => {};
  const profile = { getMyProfile() {}, updateMyProfile() {} };
  const recaptcha = { getLoginSecuritySettings() {} };
  const router = {
    get(path, ...handlers) { routes.push(['get', path, ...handlers]); },
    put(path, ...handlers) { routes.push(['put', path, ...handlers]); },
    post() {}, delete() {},
  };
  load(readFileSync(join(backendRoot, 'routes/authRoutes.js'), 'utf8'), name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../middlewares/authMiddleware') return auth;
    if (name === '../controllers/selfProfileController') return profile;
    if (name === '../controllers/recaptchaSettingsController') return recaptcha;
    if (name === '../middlewares/rateLimiters') return { uploadLimiter };
    if (name === '../utils/uploadMiddleware') return {
      uploadProfileImage: { single(field) { parsedImageFields.push(field); return imageParser; } },
    };
    return {};
  });
  assert.deepEqual(routes.find(route => route[0] === 'get' && route[1] === '/profile'), ['get', '/profile', auth, profile.getMyProfile]);
  assert.deepEqual(routes.find(route => route[0] === 'put' && route[1] === '/profile'), ['put', '/profile', auth, uploadLimiter, imageParser, profile.updateMyProfile]);
  assert.deepEqual(parsedImageFields, ['profileImage']);
  assert.deepEqual(routes.find(route => route[0] === 'get' && route[1] === '/login-security'), ['get', '/login-security', recaptcha.getLoginSecuritySettings]);
});
