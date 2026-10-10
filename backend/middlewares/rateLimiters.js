const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const { verifyStorageAccessToken } = require('../utils/fileStorage');

let redisClient = null;
let redisConnection = Promise.resolve();
const storeInitializations = [];

function apiRateLimitKey(req) {
  // A verified signature is used only to assign a request budget. Protected
  // routes still validate the database account and session in authMiddleware.
  const match = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''));
  if (match && process.env.JWT_SECRET) {
    try {
      const claims = jwt.verify(match[1], process.env.JWT_SECRET, {
        algorithms: ['HS256'], issuer: 'edumatch-api', audience: 'edumatch-web',
      });
      if (typeof claims.id === 'string' && claims.id && claims.jti && Number.isFinite(claims.exp)) {
        return `user:${claims.id}`;
      }
    } catch { /* Invalid or expired tokens share the unauthenticated IP budget. */ }
  }
  const requestPath = String(req.originalUrl || req.url || '').split('?')[0];
  if (['GET', 'HEAD'].includes(req.method) && requestPath === '/api/storage/file') {
    try {
      const payload = verifyStorageAccessToken(req.query.token);
      const fileKey = createHash('sha256').update(payload.storedPath).digest('hex');
      // Browser images/PDFs carry a signed URL, not an Authorization header.
      // Separate their per-file/IP budget from the school's unauthenticated API budget.
      return `storage:${fileKey}:${ipKeyGenerator(req.ip)}`;
    } catch { /* A forged/expired file link remains subject to the normal IP limit. */ }
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function authenticatedRateLimitKey(req) {
  return req.user?._id ? `user:${req.user._id}` : `ip:${ipKeyGenerator(req.ip)}`;
}

function createSharedStore(prefix) {
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (!redisUrl) return undefined;

  if (!redisClient) {
    redisClient = createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => retries < 2 ? 250 : new Error('Rate-limit store unavailable'),
      },
    });
    redisClient.on('error', () => {
      console.error('[RATE_LIMIT] Redis connection unavailable.');
    });
    redisConnection = redisClient.connect().then(() => {
      console.log('[RATE_LIMIT] Redis-backed rate limiting enabled.');
    });
  }

  const store = new RedisStore({
    sendCommand: async (...args) => {
      await redisConnection;
      return redisClient.sendCommand(args);
    },
    prefix: `edumatch:${prefix}:`,
  });
  const init = store.init.bind(store);
  store.init = (options) => {
    const ready = init(options);
    storeInitializations.push(ready);
    return ready;
  };
  return store;
}

function buildLimiter({ prefix, windowMs, limit, message, keyGenerator = authenticatedRateLimitKey }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    passOnStoreError: false,
    store: createSharedStore(prefix),
    message: { success: false, message },
  });
}

const apiLimiter = buildLimiter({
  prefix: 'api',
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: 'Too many requests. Please try again later.',
  keyGenerator: apiRateLimitKey,
});

const loginLimiter = buildLimiter({
  prefix: 'login',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many sign-in attempts. Please try again later.',
});

const passwordResetLimiter = buildLimiter({
  prefix: 'password-reset',
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'Too many password-reset requests. Please try again later.',
});

const inviteLimiter = buildLimiter({
  prefix: 'invite',
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many invite requests. Please try again later.',
});

const uploadLimiter = buildLimiter({
  prefix: 'upload',
  windowMs: 60 * 60 * 1000,
  limit: 30,
  message: 'Too many file uploads. Please try again later.',
});

const aiLimiter = buildLimiter({
  prefix: 'ai',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many AI-generation requests. Please try again later.',
});

module.exports = {
  apiRateLimitKey,
  buildLimiter,
  aiLimiter,
  apiLimiter,
  inviteLimiter,
  loginLimiter,
  passwordResetLimiter,
  redisReady: Promise.all([redisConnection, ...storeInitializations]),
  uploadLimiter,
};
