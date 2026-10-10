import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiConfiguration } from '../src/config/resolveApiConfiguration';

const apiUrl = 'http://192.168.254.136:5000/api';
const webApiUrl = 'http://localhost:5000/api';

test('development browser previews use the explicit override only on loopback hosts', () => {
  for (const browserHostname of ['localhost', '127.0.0.1', '[::1]']) {
    assert.deepEqual(resolveApiConfiguration({ apiUrl, webApiUrl, isDevelopment: true, browserHostname }),
      { apiUrl: webApiUrl, configurationError: null });
  }
});

test('native and remote browser development keep the phone API URL', () => {
  for (const browserHostname of [undefined, '192.168.254.136', 'edumatch.example', 'localhost.example', '::1']) {
    assert.deepEqual(resolveApiConfiguration({ apiUrl, webApiUrl, isDevelopment: true, browserHostname }),
      { apiUrl, configurationError: null });
  }
});

test('release builds ignore the local browser override and still require HTTPS', () => {
  assert.deepEqual(resolveApiConfiguration({ apiUrl: 'https://api.edumatch.example/api', webApiUrl,
    isDevelopment: false, browserHostname: 'localhost' }),
  { apiUrl: 'https://api.edumatch.example/api', configurationError: null });
  assert.equal(resolveApiConfiguration({ apiUrl, webApiUrl, isDevelopment: false, browserHostname: 'localhost' }).configurationError,
    'Release builds require an HTTPS API URL.');
});

test('an unset override falls back to the phone URL and trims trailing slashes', () => {
  assert.deepEqual(resolveApiConfiguration({ apiUrl: ` ${apiUrl}/// `, webApiUrl: ' ',
    isDevelopment: true, browserHostname: 'localhost' }), { apiUrl, configurationError: null });
});

test('invalid active browser overrides are reported before authentication', () => {
  for (const [webApiUrl, expected] of [
    ['not-a-url', 'The configured API URL is invalid.'],
    ['ftp://localhost:5000/api', 'The API URL must use HTTP(S) and end in /api.'],
    ['http://localhost:5000', 'The API URL must use HTTP(S) and end in /api.'],
  ]) {
    assert.equal(resolveApiConfiguration({ apiUrl, webApiUrl, isDevelopment: true, browserHostname: 'localhost' }).configurationError,
      expected);
  }
  assert.deepEqual(resolveApiConfiguration({ apiUrl, webApiUrl: 'not-a-url', isDevelopment: true }),
    { apiUrl, configurationError: null });
});

test('a missing API URL remains a visible configuration error outside a local preview', () => {
  assert.match(resolveApiConfiguration({ webApiUrl, isDevelopment: true }).configurationError || '', /Set EXPO_PUBLIC_API_URL/);
});
