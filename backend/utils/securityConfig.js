function resolveTrustProxy(value = process.env.TRUST_PROXY) {
  const configured = String(value || '').trim();
  if (!configured) return false;
  if (/^\d+$/.test(configured) && Number.isSafeInteger(Number(configured))) return Number(configured);
  if (['loopback', 'linklocal', 'uniquelocal'].includes(configured)) return configured;
  throw new Error('TRUST_PROXY must be a non-negative hop count or a trusted Express subnet name');
}

function securityConfigurationErrors(env = process.env, { production = env.NODE_ENV === 'production' } = {}) {
  const errors = [];
  const value = (key) => String(env[key] || '').trim();
  const placeholder = (input) => /replace-with|your-project|your-.*-key|changeme/i.test(input);
  const secret = value('JWT_SECRET');
  if (!secret || placeholder(secret)) errors.push('JWT_SECRET must be configured with a random secret');
  else if (production && Buffer.byteLength(secret) < 32) errors.push('JWT_SECRET must be at least 32 bytes in production');

  if (!value('SUPABASE_SERVICE_ROLE_KEY') || placeholder(value('SUPABASE_SERVICE_ROLE_KEY'))) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY must be configured for backend database access');
  }
  try {
    const url = new URL(value('SUPABASE_URL'));
    if (!['http:', 'https:'].includes(url.protocol) || placeholder(url.hostname)) throw new Error();
    if (production && url.protocol !== 'https:') throw new Error();
  } catch {
    errors.push('SUPABASE_URL must be a valid project URL (HTTPS in production)');
  }

  if (['true', '1', 'yes', 'on'].includes(value('SUPABASE_STORAGE_PUBLIC').toLowerCase())) {
    errors.push('SUPABASE_STORAGE_PUBLIC must be false for private student and lesson files');
  }
  const signingSecret = value('STORAGE_URL_SIGNING_SECRET');
  if (signingSecret && (placeholder(signingSecret) || (production && Buffer.byteLength(signingSecret) < 32))) {
    errors.push('STORAGE_URL_SIGNING_SECRET must be random and at least 32 bytes in production, or omitted to use JWT_SECRET');
  }
  const redisUrl = value('REDIS_URL');
  if (production && !redisUrl) errors.push('REDIS_URL is required in production for shared rate limits');
  if (redisUrl) {
    try {
      const url = new URL(redisUrl);
      if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
      errors.push('REDIS_URL must use redis:// or rediss://');
    }
  }
  try { resolveTrustProxy(value('TRUST_PROXY')); } catch (error) { errors.push(error.message); }
  if (production && !value('TRUST_PROXY')) {
    errors.push('Set TRUST_PROXY explicitly for production (0 for direct access, otherwise the verified proxy topology)');
  }
  if (production) {
    const origins = value('CORS_ALLOWED_ORIGINS') || value('FRONTEND_URL');
    if (!origins) errors.push('CORS_ALLOWED_ORIGINS or FRONTEND_URL must identify the production frontend');
    else {
      for (const origin of origins.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        try {
          const url = new URL(origin);
          if (url.protocol !== 'https:' || url.origin !== origin.replace(/\/+$/, '') || url.username || url.password) throw new Error();
        } catch {
          errors.push('Production frontend origins must be exact HTTPS origins without paths or wildcards');
          break;
        }
      }
    }
  }
  return errors;
}

function validateRuntimeSecurity(env = process.env) {
  const errors = securityConfigurationErrors(env);
  if (errors.length) throw new Error(`Security configuration: ${errors.join('; ')}`);
}

module.exports = { resolveTrustProxy, securityConfigurationErrors, validateRuntimeSecurity };
