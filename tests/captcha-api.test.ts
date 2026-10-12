import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { CaptchaAction } from '../src/api/types';

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
  setAccessToken(null);
  return { ...endpoints, requests };
}

const expiresAt = () => new Date(Date.now() + 300_000).toISOString();

test('challenge and verification use the backend and send the exact protected action', async () => {
  for (const action of ['login', 'forgot-password'] as CaptchaAction[]) {
    const expiration = expiresAt();
    const { captchaApi, authApi, requests } = await transport(request => request.url === '/captcha/challenge'
      ? { success: true, challengeId: 'opaque-challenge', question: '12 − 7 = ?', expiresAt: expiration, answer: 5 }
      : request.url === '/captcha/verify'
        ? { success: true, verificationToken: 'opaque-server-proof', expiresAt: expiration, answer: 5 }
        : { success: true, token: 'session', user: { id: 'student-one', name: 'Student', email: 's@example.test', role: 'student' } });
    const controller = new AbortController();
    const challenge = await captchaApi.challenge(action, controller.signal);
    assert.deepEqual(challenge, { challengeId: 'opaque-challenge', question: '12 − 7 = ?', expiresAt: expiration });
    assert.equal(requests[0]?.signal, controller.signal);
    assert.deepEqual(requests[0]?.params, { action });
    const result = await captchaApi.verify(challenge.challengeId, '5', action, controller.signal);
    assert.deepEqual(result, { verificationToken: 'opaque-server-proof', expiresAt: expiration });
    assert.deepEqual(JSON.parse(requests[1]?.data), { challengeId: 'opaque-challenge', answer: '5', action });
    assert.equal(requests[1]?.signal, controller.signal);
    if (action === 'login') {
      await authApi.login({ username: 'student', password: 'password', captchaToken: result.verificationToken });
      assert.equal(requests[2]?.url, '/auth/login');
    } else {
      await authApi.forgotPassword('s@example.test', result.verificationToken);
      assert.equal(requests[2]?.url, '/auth/forgot-password');
    }
    assert.equal(JSON.parse(requests[2]?.data).captchaToken, 'opaque-server-proof');
    assert.equal(requests[2]?.headers.Authorization, undefined);
  }
});

test('only addition and subtraction questions with a live server expiration are accepted', async () => {
  for (const question of ['5 + 3 = ?', '10 - 6 = ?', '12 − 7 = ?']) {
    const { captchaApi } = await transport(() => ({ success: true, challengeId: 'opaque', question, expiresAt: expiresAt() }));
    assert.equal((await captchaApi.challenge()).question, question);
  }
  for (const overrides of [
    { question: '4 × 2 = ?' }, { question: '8 / 2 = ?' }, { challengeId: '' }, { success: undefined },
    { expiresAt: 'not-a-date' }, { expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const { captchaApi } = await transport(() => ({ success: true, challengeId: 'opaque', question: '5 + 3 = ?', expiresAt: expiresAt(), ...overrides }));
    await assert.rejects(() => captchaApi.challenge(), /invalid|expired/);
  }
});

test('an answer never produces a local proof when backend verification rejects or returns invalid data', async () => {
  for (const response of [
    { success: false, message: 'Incorrect answer. Refresh the question.' },
    { success: true }, { success: true, verificationToken: 8, expiresAt: expiresAt() },
    { success: true, verificationToken: 'proof', expiresAt: 'invalid' },
    { success: true, verificationToken: 'proof', expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const { captchaApi } = await transport(() => response);
    await assert.rejects(() => captchaApi.verify('opaque', '8'), /Incorrect|did not verify|expired/);
  }
  const { captchaApi } = await transport(config => {
    throw new AxiosError('Network Error', 'ERR_NETWORK', config);
  });
  await assert.rejects(() => captchaApi.verify('opaque', '8'), AxiosError);
});
