'use strict';

// Public API checks only. Never reads or sends backend/database credentials.
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.resolve(__dirname, '../.env');
const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const configured = text.split(/\r?\n/).find(line => /^\s*EXPO_PUBLIC_API_URL\s*=/.test(line));
const apiUrl = (process.env.EXPO_PUBLIC_API_URL || configured?.split('=').slice(1).join('=').trim() || '').replace(/\/+$/, '');

async function main() {
  if (!apiUrl || !/^https?:\/\//.test(apiUrl)) throw new Error('Configure EXPO_PUBLIC_API_URL in the mobile .env first.');
  console.log(`EduMatch API: ${apiUrl}`);
  const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10000) });
  if (!health.ok) throw new Error(`Backend health check failed (HTTP ${health.status}).`);
  const status = await health.json();
  if (status.success !== true) throw new Error('The API did not return a successful EduMatch health response.');
  console.log('Backend is reachable and startup checks passed.');
  const captcha = await fetch(`${apiUrl}/mobile/captcha`, { signal: AbortSignal.timeout(10000) });
  if (!captcha.ok) throw new Error(`Mobile CAPTCHA is not ready (HTTP ${captcha.status}). Configure RECAPTCHA_SITE_KEY in the existing backend .env and restart it.`);
  if (!captcha.headers.get('content-type')?.includes('text/html')) throw new Error('The mobile CAPTCHA endpoint returned an unexpected response.');
  console.log('Mobile CAPTCHA endpoint is configured. Google domain/key acceptance and email OTP still require a real sign-in.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Connection check failed.');
  if (error?.cause?.code) console.error(`Network error: ${error.cause.code}. Start the existing backend and check the PC address/firewall.`);
  process.exitCode = 1;
});
