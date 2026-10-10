const ALLOWED_AI_PROVIDERS = ['openrouter', 'gemini', 'huggingface', 'openai', 'custom'];

function parseBooleanEnv(value, fallback = true) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumberEnv(value, fallback, { min, max } = {}) {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  let next = parsed;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return next;
}

function getAiRuntimeConfigFromEnv() {
  const providerCandidate = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = ALLOWED_AI_PROVIDERS.includes(providerCandidate) ? providerCandidate : 'openrouter';
  return {
    provider,
    model: String(process.env.AI_MODEL_NAME || '').trim(),
    apiKey: String(process.env.AI_API_KEY || '').trim(),
    baseUrl: String(process.env.AI_BASE_URL || '').trim(),
    isEnabled: parseBooleanEnv(process.env.AI_GENERATOR_ENABLED, true),
    maxTokens: parseNumberEnv(process.env.AI_MAX_TOKENS, 1024, { min: 64, max: 8192 }),
    temperature: parseNumberEnv(process.env.AI_TEMPERATURE, 0.3, { min: 0, max: 2 }),
  };
}

module.exports = {
  getAiRuntimeConfigFromEnv,
};
