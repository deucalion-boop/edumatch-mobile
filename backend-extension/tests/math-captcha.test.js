'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMathCaptchaService, createMemoryStore, createRedisStore, CHALLENGE_TTL_MS, VERIFICATION_TTL_MS } = require('../../backend/services/mathCaptchaService');

function fixture(values = [5, 3, 0]) {
  let time = 1000000;
  let index = 0;
  const now = () => time;
  const store = createMemoryStore({ now });
  const service = createMathCaptchaService({ store, now, integer: () => values[index++ % values.length] });
  return { service, advance: (ms) => { time += ms; } };
}

test('server returns only an opaque identifier, question and five-minute expiry; operators are addition/subtraction', async () => {
  for (const [values, question, answer] of [[[5, 3, 0], '5 + 3 = ?', 8], [[3, 9, 1], '9 \u2212 3 = ?', 6], [[4, 4, 1], '4 \u2212 4 = ?', 0]]) {
    const { service } = fixture(values);
    const challenge = await service.issueChallenge('login');
    assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'expiresAt', 'question']);
    assert.equal(challenge.question, question);
    assert.match(challenge.challengeId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(challenge.expiresAt), 1000000 + CHALLENGE_TTL_MS);
    const verification = await service.verifyChallenge({ challengeId: challenge.challengeId, action: 'login', answer });
    assert.deepEqual(Object.keys(verification).sort(), ['expiresAt', 'verificationToken']);
    assert.equal(await service.consumeVerificationToken(verification.verificationToken, 'login'), true);
  }
  const { service } = fixture();
  assert.notEqual((await service.issueChallenge('login')).challengeId, (await service.issueChallenge('login')).challengeId);
});

test('wrong and malformed answers consume challenges, preventing brute-force retries', async () => {
  for (const answer of [9, '', undefined, null, {}, [], true, '8abc', '8.0', '8e0', '0x8', '-8', Infinity]) {
    const { service } = fixture();
    const { challengeId } = await service.issueChallenge('login');
    assert.equal(await service.verifyChallenge({ challengeId, answer, action: 'login' }), null);
    assert.equal(await service.verifyChallenge({ challengeId, answer: 8, action: 'login' }), null);
  }
});

test('expired, missing, fabricated and raw challenge identifiers cannot authorize a protected action', async () => {
  const { service, advance } = fixture();
  const { challengeId } = await service.issueChallenge('login');
  for (const token of [undefined, '', {}, 'frontend-success', 'a'.repeat(43), challengeId]) {
    assert.equal(await service.consumeVerificationToken(token, 'login'), false);
  }
  advance(CHALLENGE_TTL_MS);
  assert.equal(await service.verifyChallenge({ challengeId, answer: 8, action: 'login' }), null);
  await assert.rejects(service.issueChallenge('unsupported'), { statusCode: 400 });
  await assert.rejects(service.issueChallenge({ action: 'login' }), { statusCode: 400 });
});

test('concurrent verification and protected requests have exactly one winner', async () => {
  const { service } = fixture();
  const { challengeId } = await service.issueChallenge('login');
  const results = await Promise.all(Array.from({ length: 20 }, () => service.verifyChallenge({ challengeId, answer: 8, action: 'login' })));
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  const consumed = await Promise.all(Array.from({ length: 20 }, () => service.consumeVerificationToken(winners[0].verificationToken, 'login')));
  assert.equal(consumed.filter(Boolean).length, 1);
});

test('verification tokens expire after one minute or by the original challenge expiry', async () => {
  for (const elapsed of [0, CHALLENGE_TTL_MS - 500]) {
    const { service, advance } = fixture();
    const { challengeId } = await service.issueChallenge('login');
    advance(elapsed);
    const result = await service.verifyChallenge({ challengeId, answer: ' 08 ', action: 'login' });
    const remaining = Math.min(VERIFICATION_TTL_MS, CHALLENGE_TTL_MS - elapsed);
    assert.equal(Date.parse(result.expiresAt), 1000000 + elapsed + remaining);
    advance(remaining);
    assert.equal(await service.consumeVerificationToken(result.verificationToken, 'login'), false);
  }
});

test('challenge and verification token action binding prevents use for a different form', async () => {
  const { service } = fixture();
  const first = await service.issueChallenge('login');
  assert.equal(await service.verifyChallenge({ challengeId: first.challengeId, answer: 8, action: 'forgot-password' }), null);
  const second = await service.issueChallenge('forgot-password');
  const result = await service.verifyChallenge({ challengeId: second.challengeId, answer: 8, action: 'forgot-password' });
  assert.equal(await service.consumeVerificationToken(result.verificationToken, 'login'), false);
  assert.equal(await service.consumeVerificationToken(result.verificationToken, 'forgot-password'), false);
});

test('bounded development store prunes expired data and rejects capacity exhaustion', async () => {
  let time = 100;
  const store = createMemoryStore({ now: () => time, maxEntries: 1 });
  await store.put('first', 'value', 10);
  await assert.rejects(store.put('second', 'value', 10), { statusCode: 503 });
  time += 10;
  await store.put('second', 'value', 10);
  assert.equal(await store.take('first'), null);
  assert.equal(await store.take('second'), 'value');
  assert.equal(await store.take('second'), null);
});

test('separate service instances share single-use challenge and verification state', async () => {
  const store = createMemoryStore();
  const first = createMathCaptchaService({ store, integer: (_min, max) => max === 2 ? 0 : 5 });
  const second = createMathCaptchaService({ store });
  const { challengeId } = await first.issueChallenge('login');
  const proof = await second.verifyChallenge({ challengeId, answer: 10, action: 'login' });
  assert.equal(await first.verifyChallenge({ challengeId, answer: 10, action: 'login' }), null);
  assert.equal(await first.consumeVerificationToken(proof.verificationToken, 'login'), true);
  assert.equal(await second.consumeVerificationToken(proof.verificationToken, 'login'), false);
});

test('production cannot generate a challenge without the shared Redis store', async () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    assert.throws(() => require('../../backend/services/mathCaptchaService').issueChallenge('login'), { statusCode: 503 });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Redis store uses expiring writes and one atomic read/delete command; outages fail closed', async () => {
  const calls = [];
  const client = {
    async set(...args) { calls.push(['set', ...args]); return 'OK'; },
    async eval(...args) { calls.push(['eval', ...args]); return 'stored-record'; },
  };
  const store = createRedisStore(async () => client);
  await store.put('challenge', 'record', CHALLENGE_TTL_MS);
  assert.deepEqual(calls[0], ['set', 'challenge', 'record', { PX: CHALLENGE_TTL_MS, NX: true }]);
  assert.equal(await store.take('challenge'), 'stored-record');
  assert.match(calls[1][1], /redis\.call\('GET'.*redis\.call\('DEL'/);
  assert.deepEqual(calls[1][2], { keys: ['challenge'], arguments: [] });
  for (const getClient of [async () => null, async () => { throw new Error('private host details'); }]) {
    const failed = createRedisStore(getClient);
    await assert.rejects(failed.take('challenge'), { statusCode: 503, message: 'CAPTCHA verification is temporarily unavailable. Please try again.' });
    await assert.rejects(failed.put('challenge', 'value', 100), { statusCode: 503 });
  }
});
