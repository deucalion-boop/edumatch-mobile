'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const backendRequire = createRequire(path.join(__dirname, '../../backend/package.json'));
const express = backendRequire('express');
const captcha = require('../../backend/services/mathCaptchaService');

test('real CAPTCHA HTTP routes hide answers, reject replay/action misuse and enforce IP attempt/generation limits', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/captcha', require('../../backend/routes/captchaRoutes'));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/captcha`;
  const post = (body, forwarded = '') => fetch(`${url}/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}) }, body: JSON.stringify(body),
  });

  const first = await fetch(`${url}/challenge?action=login`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const challenge = await first.json();
  assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'expiresAt', 'question', 'success']);
  const [, left, operator, right] = /^(\d+) ([+\u2212]) (\d+) = \?$/.exec(challenge.question);
  const answer = operator === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
  const input = { challengeId: challenge.challengeId, action: 'login', answer };
  const verified = await post(input);
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get('cache-control'), 'no-store');
  const proof = await verified.json();
  assert.deepEqual(Object.keys(proof).sort(), ['expiresAt', 'success', 'verificationToken']);
  assert.equal(await captcha.consumeVerificationToken(proof.verificationToken, 'login'), true);
  assert.equal(await captcha.consumeVerificationToken(proof.verificationToken, 'login'), false);
  assert.equal((await post(input)).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await fetch(`${url}/challenge?action=unsupported`)).status, 400);

  // Same connection IP retains its budget even with a different claimed client IP.
  for (let attempts = 3; attempts < 15; attempts++) assert.equal((await post(input, `198.51.100.${attempts}`)).status, 400);
  const throttled = await post(input, '198.51.100.99');
  assert.equal(throttled.status, 429);
  assert.equal((await throttled.json()).success, false);
  assert.ok(throttled.headers.get('ratelimit'));
  assert.ok(throttled.headers.get('retry-after'));

  for (let generated = 2; generated < 30; generated++) assert.equal((await fetch(`${url}/challenge`)).status, 200);
  assert.equal((await fetch(`${url}/challenge`)).status, 429);
});
