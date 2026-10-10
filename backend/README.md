# EduMatch API deployment

This is a clean runtime copy of the existing EduMatch Express backend, including its installed mobile API extension. It uses the same existing Supabase database and private storage as the school web application. It does not include credentials, database dumps, uploaded files, backups, or dependencies.

For Vercel, import a repository containing this directory and set Root Directory to `backend`. The committed `vercel.json` selects Express, installs the locked backend dependencies with `npm ci`, and uses the framework's default build and output settings. Clear any remaining Expo export build command and `dist` output override in the dashboard. `server.js` exports the Express application for Vercel and supports `npm start` on a regular Node host.

After saving project settings, deploy the latest commit. The build logs should show `npm ci` and dependency installation, and the deployment should contain an Express function. The API has no website at `/`; use `/api/health` to verify it. A Vercel `NOT_FOUND` response on that endpoint means the API function is not routed; an application JSON error means the request reached the backend and its runtime configuration needs attention.

Configure the names in `.env.example` under Vercel Project Settings > Environment Variables, using the existing backend's values. Backend credentials belong only on the API service. `REDIS_URL` must be a TCP Redis URL (`redis://` or `rediss://`), and `TRUST_PROXY` must match the platform's verified proxy setup. `FRONTEND_URL` must identify the existing EduMatch web application used for password-reset links. Configure the deployed API hostname in Google reCAPTCHA and `RECAPTCHA_ALLOWED_HOSTNAMES`. Keep the existing HTTPS mail API configured for OTP delivery.

Set `NODE_ENV=production` and use the deployed hostnames, HTTPS origins, and hosting proxy settings rather than local development values. Apply the environment variables to Vercel's Production environment and redeploy after changing them.

After saving the environment and redeploying, verify these public endpoints:

- `/api/health` must return HTTP 200 with `success: true`.
- `/api/mobile/captcha` must return the configured CAPTCHA HTML page.

Then set `EXPO_PUBLIC_API_URL=https://<your-api-domain>/api` in the mobile EAS preview environment and build the Android APK. Database migrations are managed separately; this copy never applies migrations automatically.

Vercel Functions limit request and response payloads to 4.5 MB. The current backend transfers files through Express, so larger uploads/downloads need direct signed Supabase transfers before using those workflows. The existing remote push worker requires separate worker hosting or adaptation to scheduled processing. Legacy files stored only in local `uploads` must be migrated to private Supabase storage to be available on this deployment.
