import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRecaptchaForAttempt } from '../src/auth/loginSecurity';

test('a school administrator can disable the CAPTCHA check only through an explicit Off policy', async () => {
  assert.equal(await requireRecaptchaForAttempt(async () => ({ recaptchaEnabled: false })), false);
  for (const policy of [undefined, null, [], false, 'false', {}, { recaptchaEnabled: true }, { recaptchaEnabled: 'false' }, { recaptchaEnabled: 0 }]) {
    assert.equal(await requireRecaptchaForAttempt(async () => policy), true);
  }
});

test('an unavailable policy keeps CAPTCHA enabled rather than bypassing the security check', async () => {
  for (const failure of [new Error('Network Error'), new Error('Settings unavailable'), new Error('Invalid sign-in security settings')]) {
    assert.equal(await requireRecaptchaForAttempt(async () => { throw failure; }), true);
  }
});

test('every sign-in and OTP verification attempt reads the current policy after an administrator changes it', async () => {
  let enabled = false;
  let loads = 0;
  const loadPolicy = async () => { loads += 1; return { recaptchaEnabled: enabled }; };
  assert.equal(await requireRecaptchaForAttempt(loadPolicy), false);
  enabled = true;
  assert.equal(await requireRecaptchaForAttempt(loadPolicy), true);
  enabled = false;
  assert.equal(await requireRecaptchaForAttempt(loadPolicy), false);
  assert.equal(loads, 3);
});
