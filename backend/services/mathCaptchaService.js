'use strict';

const { createHash, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const VERIFICATION_TTL_MS = 60 * 1000;
const ACTIONS = new Set(['login', 'forgot-password']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TAKE_SCRIPT = "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value";

function unavailable() {
  const error = new Error('CAPTCHA verification is temporarily unavailable. Please try again.');
  error.statusCode = 503;
  return error;
}

function validateAction(action) {
  if (!ACTIONS.has(action)) {
    const error = new Error('Choose a supported CAPTCHA action.');
    error.statusCode = 400;
    throw error;
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Development only. Deleting before returning makes take atomic within a process.
// Production and every host configured with Redis use the shared atomic store.
function createMemoryStore({ now = Date.now, maxEntries = 5000 } = {}) {
  const entries = new Map();
  return {
    async put(key, value, ttlMs) {
      for (const [entryKey, entry] of entries) {
        if (entry.expiresAt <= now()) entries.delete(entryKey);
      }
      if (entries.size >= maxEntries) throw unavailable();
      if (entries.has(key)) throw unavailable();
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    async take(key) {
      const entry = entries.get(key);
      entries.delete(key);
      return entry && entry.expiresAt > now() ? entry.value : null;
    },
  };
}

function createRedisStore(getClient) {
  return {
    async put(key, value, ttlMs) {
      try {
        const client = await getClient();
        if (!client || await client.set(key, value, { PX: ttlMs, NX: true }) !== 'OK') throw unavailable();
      } catch { throw unavailable(); }
    },
    async take(key) {
      try {
        const client = await getClient();
        if (!client) throw unavailable();
        // A single Redis command consumes the record across all API workers.
        return await client.eval(TAKE_SCRIPT, { keys: [key], arguments: [] });
      } catch { throw unavailable(); }
    },
  };
}

function createMathCaptchaService({ store, now = Date.now, integer = randomInt } = {}) {
  if (!store) throw new Error('A server-side CAPTCHA store is required.');
  const keyFor = (kind, token) => `edumatch:math-captcha:${kind}:${hash(token)}`;

  return {
    async issueChallenge(action) {
      validateAction(action);
      let left = integer(1, 11);
      let right = integer(1, 11);
      const addition = integer(0, 2) === 0;
      if (!addition && left < right) [left, right] = [right, left];
      const answer = String(addition ? left + right : left - right);
      const challengeId = randomBytes(32).toString('base64url');
      const expiresAt = now() + CHALLENGE_TTL_MS;
      await store.put(keyFor('challenge', challengeId), JSON.stringify({ action, answer, expiresAt }), CHALLENGE_TTL_MS);
      return { challengeId, question: `${left} ${addition ? '+' : '\u2212'} ${right} = ?`, expiresAt: new Date(expiresAt).toISOString() };
    },

    async verifyChallenge({ challengeId, answer, action } = {}) {
      validateAction(action);
      if (typeof challengeId !== 'string' || !TOKEN_PATTERN.test(challengeId)) return null;
      // Every attempt consumes the challenge, including malformed/wrong answers.
      const raw = await store.take(keyFor('challenge', challengeId));
      if (!raw) return null;
      const challenge = JSON.parse(raw);
      const submitted = typeof answer === 'number' && Number.isSafeInteger(answer) ? String(answer) : answer;
      if (challenge.action !== action || challenge.expiresAt <= now()
        || typeof submitted !== 'string' || !/^\d{1,2}$/.test(submitted.trim())) return null;
      const expectedHash = Buffer.from(hash(challenge.answer), 'hex');
      const actualHash = Buffer.from(hash(String(Number(submitted.trim()))), 'hex');
      if (!timingSafeEqual(expectedHash, actualHash)) return null;
      const verificationToken = randomBytes(32).toString('base64url');
      const verifiedAt = now();
      const expiresAt = Math.min(verifiedAt + VERIFICATION_TTL_MS, challenge.expiresAt);
      const ttlMs = expiresAt - verifiedAt;
      if (ttlMs <= 0) return null;
      await store.put(keyFor('verified', verificationToken), JSON.stringify({ action, expiresAt }), ttlMs);
      return { verificationToken, expiresAt: new Date(expiresAt).toISOString() };
    },

    async consumeVerificationToken(token, action) {
      validateAction(action);
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
      const raw = await store.take(keyFor('verified', token));
      if (!raw) return false;
      const verified = JSON.parse(raw);
      return verified.action === action && verified.expiresAt > now();
    },
  };
}

let service;
function runtimeService() {
  if (!service) {
    const redisConfigured = Boolean(String(process.env.REDIS_URL || '').trim());
    if (!redisConfigured && process.env.NODE_ENV === 'production') throw unavailable();
    const store = redisConfigured
      ? createRedisStore(() => require('../middlewares/rateLimiters').getRedisClient())
      : createMemoryStore();
    service = createMathCaptchaService({ store });
  }
  return service;
}

module.exports = {
  CHALLENGE_TTL_MS, VERIFICATION_TTL_MS, createMathCaptchaService, createMemoryStore, createRedisStore,
  issueChallenge: (action) => runtimeService().issueChallenge(action),
  verifyChallenge: (input) => runtimeService().verifyChallenge(input),
  consumeVerificationToken: (token, action) => runtimeService().consumeVerificationToken(token, action),
};
