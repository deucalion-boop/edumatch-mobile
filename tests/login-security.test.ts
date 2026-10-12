import test from 'node:test';
import assert from 'node:assert/strict';
import { requireCaptchaForAttempt } from '../src/auth/loginSecurity';

test('every initial login requires CAPTCHA without a configurable bypass', () => {
  assert.equal(requireCaptchaForAttempt(), true);
  assert.equal(requireCaptchaForAttempt('login'), true);
});

test('OTP verification continues the previously CAPTCHA-verified login', () => {
  assert.equal(requireCaptchaForAttempt('verify-code'), false);
});
