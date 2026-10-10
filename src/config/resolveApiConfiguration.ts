type ApiConfigurationOptions = {
  apiUrl?: string;
  webApiUrl?: string;
  isDevelopment: boolean;
  browserHostname?: string;
};

// Local browser previews can use a CAPTCHA-approved hostname while phones use the LAN API.
export function resolveApiConfiguration(options: ApiConfigurationOptions) {
  const localBrowser = ['localhost', '127.0.0.1', '[::1]'].includes(options.browserHostname || '');
  const webOverride = options.isDevelopment && localBrowser ? options.webApiUrl?.trim() : undefined;
  const configuredUrl = webOverride || options.apiUrl?.trim();
  const apiUrl = (configuredUrl || 'http://127.0.0.1:5000/api').replace(/\/+$/, '');
  let configurationError: string | null = null;

  if (!configuredUrl) {
    configurationError = 'Set EXPO_PUBLIC_API_URL in .env to your EduMatch backend URL ending in /api.';
  } else {
    try {
      const url = new URL(apiUrl);
      if (!['https:', 'http:'].includes(url.protocol) || !url.pathname.endsWith('/api')) {
        configurationError = 'The API URL must use HTTP(S) and end in /api.';
      } else if (!options.isDevelopment && url.protocol !== 'https:') {
        configurationError = 'Release builds require an HTTPS API URL.';
      }
    } catch {
      configurationError = 'The configured API URL is invalid.';
    }
  }

  return { apiUrl, configurationError };
}
