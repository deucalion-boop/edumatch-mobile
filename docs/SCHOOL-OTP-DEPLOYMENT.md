# School-wide sign-in OTP

The administrator's switch controls email OTP for admin, headteacher, teacher,
secretary, and student sign-ins. Both the settings API and login API must run the
updated backend. Rebuilding an APK does not deploy the backend.

## Deploy

1. Deploy this repository's complete `backend/` directory to the API host used by
   the APK's EAS `EXPO_PUBLIC_API_URL`. For the existing Vercel setup, use Root
   Directory `backend` and deploy the updated commit to Production. Preserve the
   existing backend environment variables.
2. Sign in as admin and open Settings > Security. The settings endpoint
   `GET /api/admin/settings/otp` must return
   `settings: { enabled: true, scope: "school" }` (or `enabled: false` if already
   saved). `scope: "account"` identifies an older backend deployment.
3. Turn OTP off and save using the current admin password. This creates or updates
   `app_settings` key `admin-security:school-login-otp`. No schema migration is
   required. An old admin-only Off preference is not the shared school setting;
   save the school-wide preference after deploying.
4. Start a fresh sign-in for each of the five roles. With OTP off, valid credentials
   and CAPTCHA should return a session immediately. With OTP on, each role should
   receive the email-code challenge. Already-open OTP screens should return to
   the initial sign-in screen and start again.

Password checks, CAPTCHA, account status, lockouts, maintenance restrictions and
forced password changes remain enforced. Only administrators can save this policy.

## Verification

Run `node --test backend-extension/tests/admin-otp-settings.test.js` from the
repository root. The regression suite saves Off, On, then Off through the admin
controller and exercises all five roles through the login controller using the
same persisted settings fixture. These checks use mocked database and mail
services; they do not verify the deployed service.
