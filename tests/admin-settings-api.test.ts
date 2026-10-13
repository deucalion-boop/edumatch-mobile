import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:5099/api';
Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
const modules = Promise.all([import('../src/api/client'), import('../src/api/edumatch')]);

async function transport(handler: (request: InternalAxiosRequestConfig) => unknown) {
  const [{ api, setAccessToken }, endpoints] = await modules;
  const requests: InternalAxiosRequestConfig[] = [];
  api.defaults.adapter = async config => {
    requests.push(config);
    return { data: handler(config), status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
  };
  setAccessToken('admin-jwt');
  return { ...endpoints, requests };
}

const admin = { id: 'admin-one', name: 'Principal', email: 'p@gmail.com', username: 'principal', role: 'admin', profileImage: 'https://school.example/avatar.png' };

test('every role loads and updates its own profile through authenticated shared routes', async () => {
  for (const role of ['admin', 'secretary', 'headteacher', 'teacher', 'student']) {
    const account = { ...admin, id: `${role}-one`, role, sectionId: 'section-one', advisorySectionId: 'advisory-one' };
    const { authApi, requests } = await transport(request => ({ success: true, user: {
      ...account, ...(request.method === 'put' && typeof request.data === 'string' ? JSON.parse(request.data) : {}),
      password: 'private-hash', invite: { tokenHash: 'private' }, tokenVersion: 5,
    } }));
    const profile = await authApi.profile();
    assert.equal(profile.role, role);
    assert.equal(profile.id, account.id);
    assert.equal(profile.sectionId, 'section-one');
    assert.equal(profile.advisorySectionId, 'advisory-one');
    assert.equal(profile.password, undefined);
    assert.equal(profile.invite, undefined);
    assert.equal(profile.tokenVersion, undefined);
    const updated = await authApi.updateProfile({ name: ' Updated Name ', email: ' NEW.EMAIL@GMAIL.COM ', username: 'injected', role: 'admin', id: 'another-user' } as { name: string; email: string });
    assert.equal(updated.name, 'Updated Name');
    assert.equal(updated.email, 'new.email@gmail.com');
    assert.equal(updated.username, account.username);
    assert.equal(updated.role, role);
    const form = new FormData();
    form.append('profileImage', new Blob(['test-image'], { type: 'image/png' }), 'profile.png');
    assert.equal((await authApi.updateProfile(form)).id, account.id);
    assert.deepEqual(requests.map(request => [request.method, request.url]), [['get', '/auth/profile'], ['put', '/auth/profile'], ['put', '/auth/profile']]);
    assert.deepEqual(JSON.parse(requests[1]?.data), { name: 'Updated Name', email: 'new.email@gmail.com' });
    assert.equal(requests[2]?.data, form);
    assert.ok(requests.every(request => request.headers.Authorization === 'Bearer admin-jwt'));
  }
});

test('shared profile rejects malformed accounts and blank fields without inventing saved data', async () => {
  for (const user of [null, {}, { ...admin, role: 'unknown' }]) {
    const { authApi } = await transport(() => ({ success: true, user }));
    await assert.rejects(() => authApi.profile(), /invalid|unsupported/);
    await assert.rejects(() => authApi.updateProfile(new FormData()), /invalid|unsupported/);
  }
  const { authApi, requests } = await transport(() => ({ success: true, user: admin }));
  for (const input of [{ name: ' ', email: admin.email }, { name: admin.name, email: '' }]) {
    await assert.rejects(() => authApi.updateProfile(input), /name and email/);
  }
  assert.equal(requests.length, 0);
});

test('admin profile fetch and upload use self-account routes and preserve multipart data', async () => {
  const { edumatchApi, requests } = await transport(() => ({ success: true, user: { ...admin, password: 'private-hash', invite: { tokenHash: 'private' } } }));
  const profile = await edumatchApi.adminProfile();
  assert.equal(profile.id, admin.id);
  assert.equal(profile.profileImage, admin.profileImage);
  assert.equal(profile.password, undefined);
  assert.equal(profile.invite, undefined);
  const form = new FormData();
  form.append('profileImage', new Blob(['test-image'], { type: 'image/png' }), 'profile.png');
  assert.equal((await edumatchApi.updateAdminProfile(form)).role, 'admin');
  assert.deepEqual(requests.map(request => [request.method, request.url]), [['get', '/admin/profile'], ['put', '/admin/profile']]);
  assert.equal(requests[1]?.data, form);
  assert.equal((requests[1]?.data as FormData).get('profileImage') instanceof Blob, true);
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer admin-jwt'));
});

test('admin profile client rejects unsupported or malformed account responses', async () => {
  for (const user of [null, {}, { ...admin, role: 'teacher' }, { ...admin, role: 'unknown' }]) {
    const { edumatchApi } = await transport(() => ({ success: true, user }));
    await assert.rejects(() => edumatchApi.adminProfile(), /invalid|unsupported/);
    await assert.rejects(() => edumatchApi.updateAdminProfile(new FormData()), /invalid|unsupported/);
  }
});

test('admin profile detail updates submit normalized name and email without username or other account fields', async () => {
  const { edumatchApi, requests } = await transport(request => ({ success: true, user: { ...admin, ...JSON.parse(request.data) } }));
  const input = { name: '  Updated Principal  ', email: '  NEW.PRINCIPAL@GMAIL.COM  ', username: 'injected-user', role: 'teacher', id: 'other-admin' };
  const updated = await edumatchApi.updateAdminProfile(input);
  assert.equal(updated.name, 'Updated Principal');
  assert.equal(updated.email, 'new.principal@gmail.com');
  assert.equal(updated.username, admin.username);
  assert.equal(updated.id, admin.id);
  assert.equal(updated.role, 'admin');
  assert.equal(requests[0]?.url, '/admin/profile');
  assert.equal(requests[0]?.method, 'put');
  assert.deepEqual(JSON.parse(requests[0]?.data), { name: 'Updated Principal', email: 'new.principal@gmail.com' });
});

test('empty admin profile details are rejected before sending an update', async () => {
  const { edumatchApi, requests } = await transport(() => ({ success: true, user: admin }));
  for (const input of [{ name: ' ', email: admin.email }, { name: admin.name, email: '\t' }]) {
    await assert.rejects(() => edumatchApi.updateAdminProfile(input), /name and email/);
  }
  assert.equal(requests.length, 0);
});

test('OTP settings load, save both choices and reload with the server scope preserved', async () => {
  for (const scope of ['account', 'school']) {
  let enabled = true;
  const { edumatchApi, requests } = await transport(request => ({ success: true, settings: {
    enabled: request.method === 'put' ? (enabled = JSON.parse(request.data).enabled) : enabled,
    scope, updatedBy: 'private-admin', extra: 'ignored',
  } }));
  assert.deepEqual(await edumatchApi.adminOtpSettings(), { enabled: true, scope });
  assert.deepEqual(await edumatchApi.updateAdminOtpSettings({ enabled: false, currentPassword: ' current password ' }), { enabled: false, scope });
  assert.deepEqual(JSON.parse(requests[1]?.data), { enabled: false, currentPassword: ' current password ' });
  assert.deepEqual(requests.map(request => [request.method, request.url]), [['get', '/admin/settings/otp'], ['put', '/admin/settings/otp']]);
  assert.deepEqual(await edumatchApi.adminOtpSettings(), { enabled: false, scope });
  assert.deepEqual(await edumatchApi.updateAdminOtpSettings({ enabled: true, currentPassword: 'secret' }), { enabled: true, scope });
  assert.deepEqual(await edumatchApi.adminOtpSettings(), { enabled: true, scope });
  }
});

test('missing confirmation and invalid OTP settings fail visibly', async () => {
  const { edumatchApi, requests } = await transport(() => ({ success: true, settings: { enabled: true, scope: 'account' } }));
  await assert.rejects(() => edumatchApi.updateAdminOtpSettings({ enabled: false, currentPassword: '' }), /current password/);
  await assert.rejects(() => edumatchApi.updateAdminOtpSettings({ enabled: 'false' as unknown as boolean, currentPassword: 'secret' }), /OTP setting/);
  assert.equal(requests.length, 0);
  for (const settings of [undefined, {}, { enabled: 'false', scope: 'account' }, { enabled: 'true', scope: 'school' }, { enabled: true }, { enabled: true, scope: 'unknown' }]) {
    const invalid = await transport(() => ({ success: true, settings }));
    await assert.rejects(() => invalid.edumatchApi.adminOtpSettings(), /invalid OTP settings/);
    await assert.rejects(() => invalid.edumatchApi.updateAdminOtpSettings({ enabled: false, currentPassword: 'secret' }), /invalid OTP settings/);
  }
});

test('math CAPTCHA settings are required, school scoped, and read only', async () => {
  const { edumatchApi, requests } = await transport(() => ({ success: true, settings: {
    enabled: true, scope: 'school', secret: 'never-cache-this',
  } }));
  assert.deepEqual(await edumatchApi.captchaSettings(), { enabled: true, scope: 'school' });
  assert.deepEqual(requests.map(request => [request.method, request.url]), [['get', '/admin/settings/captcha']]);
});

test('math CAPTCHA settings reject disabled or malformed server policies', async () => {
  for (const settings of [undefined, {}, { enabled: 'false', scope: 'school' }, { enabled: false, scope: 'school' }, { enabled: true, scope: 'account' }]) {
    const invalid = await transport(() => ({ success: true, settings }));
    await assert.rejects(() => invalid.edumatchApi.captchaSettings(), /invalid math CAPTCHA/);
  }
});

test('public login security requires math CAPTCHA and exposes no other school security settings', async () => {
  const { authApi, requests } = await transport(() => ({ success: true, settings: { captchaEnabled: true, secret: 'private', sessionTimeoutMinutes: 120 } }));
  const [{ setAccessToken }] = await modules;
  setAccessToken(null);
  assert.deepEqual(await authApi.loginSecuritySettings(), { captchaEnabled: true });
  assert.equal(requests[0]?.url, '/auth/login-security');
  assert.equal(requests[0]?.method, 'get');
  assert.equal(requests[0]?.headers.Authorization, undefined);
  assert.equal(requests[0]?.headers['Cache-Control'], undefined);
  for (const settings of [undefined, {}, { captchaEnabled: false }, { captchaEnabled: 'true' }, { captchaEnabled: 0 }]) {
    const invalid = await transport(() => ({ success: true, settings }));
    await assert.rejects(() => invalid.authApi.loginSecuritySettings(), /invalid sign-in security/);
  }
});

test('an admin login without an OTP challenge still accepts the authenticated session and forced password state', async () => {
  const { authApi, requests } = await transport(() => ({ success: true, requiresOtp: false, token: 'password-authenticated-jwt', user: { ...admin, forcePasswordChange: true } }));
  const result = await authApi.login({ username: 'principal', password: 'secret', captchaToken: 'captcha', remember: true });
  assert.equal('challengeToken' in result, false);
  assert.equal('token' in result && result.token, 'password-authenticated-jwt');
  assert.equal('user' in result && result.user.forcePasswordChange, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/auth/login');
  assert.deepEqual(JSON.parse(requests[0]?.data), { username: 'principal', password: 'secret', captchaToken: 'captcha', remember: true });
});

test('a delayed settings failure from a previous account cannot expire a newly signed-in account', async () => {
  const [{ api, setAccessToken, onSessionExpired }, { edumatchApi, authApi }] = await modules;
  let expirations = 0;
  onSessionExpired(() => { expirations += 1; });
  try {
    const reject = (config: InternalAxiosRequestConfig) => {
      const response = { data: { success: false, message: 'Session expired' }, status: 401, statusText: 'Unauthorized', headers: {}, config };
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, response);
    };
    setAccessToken('previous-admin-session');
    api.defaults.adapter = async config => { setAccessToken('new-admin-session'); return reject(config); };
    await assert.rejects(() => edumatchApi.adminProfile(), AxiosError);
    assert.equal(expirations, 0);
    api.defaults.adapter = async config => reject(config);
    await assert.rejects(() => edumatchApi.adminProfile(), AxiosError);
    assert.equal(expirations, 1);
    await assert.rejects(() => authApi.changePassword({ currentPassword: 'wrong', newPassword: 'new', confirmNewPassword: 'new' }), AxiosError);
    assert.equal(expirations, 1);
  } finally { onSessionExpired(undefined); }
});
