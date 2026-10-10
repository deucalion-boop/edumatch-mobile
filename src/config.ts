import { resolveApiConfiguration } from './config/resolveApiConfiguration';

const resolved = resolveApiConfiguration({
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  webApiUrl: process.env.EXPO_PUBLIC_WEB_API_URL,
  isDevelopment: __DEV__,
  browserHostname: typeof window !== 'undefined' && typeof document !== 'undefined'
    ? window.location.hostname
    : undefined,
});

export const API_URL = resolved.apiUrl;
export const configurationError = resolved.configurationError;
