function extractProviderErrorDetail(responseText = '') {
  const raw = String(responseText || '').trim();
  if (!raw) return '';

  try {
    const payload = JSON.parse(raw);
    const metadataRaw =
      payload?.error?.metadata?.raw
      || payload?.metadata?.raw
      || payload?.error?.details?.raw
      || payload?.details?.raw
      || '';
    const candidates = [
      metadataRaw,
      payload?.error?.message,
      payload?.error?.error?.message,
      payload?.error?.detail,
      payload?.error?.details?.message,
      payload?.message,
      payload?.detail,
      payload?.error,
    ];
    const resolved = candidates.find((item) => typeof item === 'string' && item.trim());
    return resolved ? String(resolved).trim() : raw;
  } catch (_error) {
    return raw;
  }
}

function normalizeProviderErrorMessage(status, responseText = '') {
  const detail = extractProviderErrorDetail(responseText);
  const text = detail.toLowerCase();

  if (status === 401) return 'Invalid API Key';
  if (status === 403) return 'Provider authentication failed';
  if (status === 404) return 'Model not found';
  if (status === 429) return 'Provider rate limit exceeded';

  if (text.includes('invalid api key') || text.includes('incorrect api key')) return 'Invalid API Key';
  if (text.includes('auth') || text.includes('permission') || text.includes('unauthorized') || text.includes('forbidden')) {
    return 'Provider authentication failed';
  }
  if (text.includes('model') && (text.includes('not found') || text.includes('does not exist') || text.includes('unknown'))) {
    return 'Model not found';
  }
  if (text.includes('no endpoints found') || text.includes('not a valid model') || text.includes('unsupported model')) {
    return 'Model not found';
  }

  if (status === 400 && detail) {
    return `Provider rejected request: ${detail.slice(0, 320)}`;
  }

  if (status === 400) {
    const compactRaw = String(responseText || '').replace(/\s+/g, ' ').trim();
    if (compactRaw) {
      return `Provider rejected request: ${compactRaw.slice(0, 320)}`;
    }
  }

  return `Verification failed (${status})`;
}

function buildProviderRequest({ provider, model, baseUrl, apiKey, maxTokens, temperature }) {
  if (provider === 'openrouter') {
    return {
      endpoint: 'https://openrouter.ai/api/v1/models',
      options: {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    };
  }

  if (provider === 'gemini') {
    return {
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: {
            temperature: Number.isFinite(temperature) ? temperature : 0,
            maxOutputTokens: Math.min(32, maxTokens || 128),
          },
        }),
      },
    };
  }

  if (provider === 'huggingface') {
    return {
      endpoint: `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
      options: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: 'ping',
          parameters: {
            max_new_tokens: Math.min(16, maxTokens || 64),
            temperature: Number.isFinite(temperature) ? temperature : 0,
          },
        }),
      },
    };
  }

  if (provider === 'openai') {
    const normalizedBaseUrl = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    return {
      endpoint: `${normalizedBaseUrl}/chat/completions`,
      options: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: Math.min(32, maxTokens || 128),
          temperature: Number.isFinite(temperature) ? temperature : 0,
        }),
      },
    };
  }
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  return {
    endpoint: `${normalizedBaseUrl}/chat/completions`,
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: Math.min(32, maxTokens || 128),
        temperature: Number.isFinite(temperature) ? temperature : 0,
      }),
    },
  };
}

function hasValidPayload(provider, payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (provider === 'openrouter') {
    return Array.isArray(payload?.data);
  }
  if (provider === 'gemini') {
    return Array.isArray(payload?.candidates);
  }
  if (provider === 'huggingface') {
    if (payload?.error) return false;
    if (Array.isArray(payload)) return payload.length >= 0;
    return typeof payload === 'object';
  }
  return Array.isArray(payload?.choices);
}

async function verifyAiProviderConfig(config) {
  const provider = String(config?.provider || '').trim().toLowerCase();
  const model = String(config?.model || '').trim();
  const apiKey = String(config?.apiKey || '').trim();
  const baseUrl = String(config?.baseUrl || '').trim();

  if (!provider) {
    const error = new Error('AI provider is required');
    error.statusCode = 400;
    throw error;
  }
  if (!model) {
    const error = new Error('Model name is required');
    error.statusCode = 400;
    throw error;
  }
  if (!apiKey) {
    const error = new Error('Invalid API Key');
    error.statusCode = 400;
    throw error;
  }
  if (provider === 'custom' && !baseUrl) {
    const error = new Error('Base URL is required for custom API provider');
    error.statusCode = 400;
    throw error;
  }

  const { endpoint, options } = buildProviderRequest({
    provider,
    model,
    baseUrl,
    apiKey,
    maxTokens: Number(config?.maxTokens || 128),
    temperature: Number(config?.temperature ?? 0),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(endpoint, {
      ...options,
      signal: controller.signal,
    });

    const responseText = await response.text();
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(normalizeProviderErrorMessage(response.status, responseText));
      error.statusCode = response.status === 401 || response.status === 403 || response.status === 404 ? 400 : response.status;
      error.providerStatusCode = response.status;
      throw error;
    }

    if (!hasValidPayload(provider, payload)) {
      const error = new Error('Provider returned an invalid response payload');
      error.statusCode = 400;
      throw error;
    }

    if (provider === 'openrouter') {
      const requestedModel = String(model || '').trim().toLowerCase();
      const availableModels = Array.isArray(payload?.data) ? payload.data : [];
      const modelExists = availableModels.some((item) => {
        const modelId = String(item?.id || '').trim().toLowerCase();
        return modelId && modelId === requestedModel;
      });

      if (!modelExists) {
        const error = new Error('Model not found');
        error.statusCode = 400;
        throw error;
      }
    }

    return {
      ok: true,
      provider,
      model,
      statusCode: response.status,
      verifiedAt: new Date(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  verifyAiProviderConfig,
};
