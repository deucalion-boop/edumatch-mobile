# Math CAPTCHA migration

This migration updates the Expo React Native app, its React web preview, and the Express deployment copy inside this `Edumatch-mobile` workspace. The inspected project uses Supabase PostgreSQL and private storage, with existing Mongoose compatibility models. It is not a Vite/Bootstrap/MongoDB frontend project. The existing layout, school accounts, database models, mail service, and authentication workflows are preserved. The neighboring `../Edumatch` website was not modified, as requested.

## ReCAPTZ review and implementation choice

The [official ReCAPTZ README](https://github.com/ShejanMahamud/ReCAPTZ#readme) documents `Captcha` with `type="math"`, `mathConfig.operations`, `mathConfig.range`, and `onValidate`. Selecting `operations: ['add', 'subtract']` is documented. It also explicitly describes generation and validation as entirely client-side. That does not meet the required server-held answer and atomic single-use verification. This implementation uses the requested compatible custom math CAPTCHA interface instead. No unsupported ReCAPTZ server properties or functions are assumed, and `recaptz` is not installed.

The shared [Captcha component](../src/auth/Captcha.tsx) works on Android, iOS, and the Expo web preview. It uses the existing modal, green theme, controls, input field, and status messages. It displays a server question, accepts a numeric answer, offers **Refresh question** and **Try a new question** controls, and shows expiration/failure feedback. It cancels stale requests when refreshed or closed and hands a verified token to the pending login or password-recovery action.

## Backend and frontend flow

1. The app requests a question for `login` or `forgot-password` from `GET /api/captcha/challenge?action=...`.
2. The [backend service](../backend/services/mathCaptchaService.js) uses Node's cryptographic random generator for operands, the addition/subtraction choice, and a 32-byte opaque challenge ID. Operands are 1–10; subtraction is reordered to keep results nonnegative. The correct answer, action, and expiry are stored only on the server. The response contains `success`, `challengeId`, `question`, and `expiresAt`.
3. The app posts `{challengeId, answer, action}` to `POST /api/captcha/verify`. The backend atomically takes and deletes the challenge before checking the supplied answer. Wrong or malformed answers, an action mismatch, expired records, and repeat submissions fail. The app must request a new challenge after a failed attempt.
4. A correct answer issues an opaque `verificationToken` bound to the action. It expires after at most 60 seconds and never later than the original five-minute challenge expiry. The response contains `success`, `verificationToken`, and `expiresAt`, without the expected answer.
5. The app immediately submits the original form with that token in the existing `captchaToken` field. Login and password recovery atomically take and delete the verified token before completing their protected work. Direct calls without valid verification, forged success flags, a raw challenge ID, reused tokens, and tokens for another action are rejected.

IDs and verification tokens are hashed in storage keys. The expected answer is never included in API responses, frontend state, generated client code, or a signed token. It is held in server storage until consumption or expiry. CAPTCHA responses use `Cache-Control: no-store`; audit metadata excludes CAPTCHA credentials and submitted answers.

Production uses the existing Redis connection for shared challenge and token storage. Redis `SET` with expiry and `NX` creates records, and one Lua `GET`/`DEL` operation consumes them across API workers. Missing production Redis configuration and storage failures return HTTP 503 without allowing protected actions. Development without Redis uses a process-local map capped at 5,000 records with expired-record cleanup. It is suitable for one local API process; multiple workers should use Redis.

Challenge issuance has a limit of 30 requests per IP per five minutes. Verification has a limit of 15 attempts per IP per five minutes. Existing API, login, and password-reset limits remain active. Configure `TRUST_PROXY` for the actual trusted hosting proxy so IP budgets reflect the client correctly.

Visible arithmetic is easy for automated solvers. This migration enforces server verification, expiry, replay prevention, action binding, and attempt budgets; its resistance to automated abuse depends on those controls.

## Protected forms and existing behavior

| Workflow | CAPTCHA behavior | Existing checks retained |
| --- | --- | --- |
| Initial sign-in | Solve a challenge for `login`, then send the verification token as `captchaToken`. | Username/password, account status, maintenance, account lockout, sessions, and administrator OTP preference. |
| Forgot password | Solve a challenge for `forgot-password`, then send `{email,captchaToken}`. | Existing generic response, account lookup, secure reset link, mail delivery, and reset-rate limits. |
| Verify/resend emailed OTP | Continues the already verified sign-in challenge without another math question. | Six-digit OTP, expiry, resend cooldown, attempt limit, account status, and maintenance. |
| Account creation | Existing authenticated, role-authorized account creation remains in place. | Administrator/secretary/head-teacher permissions, invitations, assignments, validation, and email. |
| Invitation/reset completion | Existing secure email-token endpoints remain in place. | Invitation/reset token, expiry, password validation, and session revocation. |

Every initial login and password-recovery request now requires math CAPTCHA, even if an old stored setting disabled Google CAPTCHA. The administrator's Security page displays the required policy. The canonical settings endpoint is `GET /api/admin/settings/captcha`; the former `/settings/recaptcha` URLs remain compatibility aliases. Authenticated settings updates can confirm `enabled:true` with the current password; `enabled:false` is rejected. Stored unrelated settings and administrator-specific OTP preferences remain intact.

`GET /api/auth/login-security` reports `captchaEnabled:true`, plus the old `recaptchaEnabled:true` response field for upgrading clients. The legacy `GET /api/mobile/captcha` returns HTTP 307 to the JSON login challenge endpoint. It no longer serves HTML or a Google widget. An old browser/WebView client cannot use that redirect as a verified CAPTCHA token. Any separately deployed website must adopt the new API before it is pointed at this updated backend; that website is outside this change.

## Dependencies and environment

No new production dependency is required. The backend already contains `redis`, `express-rate-limit`, and `rate-limit-redis`, and cryptographic operations use `node:crypto`. The unused `react-native-webview` dependency was removed from the root package and lockfile with the former widget bridge. No separate Google CAPTCHA package was installed in the inspected manifests. Other Google integrations, Gmail/mail delivery, Google fonts, and Firebase push configuration are preserved.

Use the committed lockfiles for a fresh installation:

```powershell
npm ci
npm ci --prefix backend
```

An older local dependency tree can remove the obsolete bridge with `npm uninstall react-native-webview`; this checkout's manifest and lockfile already include that removal. Do not add `recaptz` for the custom server-verified implementation.

The app still needs only its existing public configuration:

```dotenv
EXPO_PUBLIC_API_URL=https://your-api-host/api
# Optional override for local browser development only:
EXPO_PUBLIC_WEB_API_URL=http://localhost:5000/api
```

The backend retains the names in [backend/.env.example](../backend/.env.example), including Supabase/private-storage credentials, `JWT_SECRET`, `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, mail configuration, and the Expo project ID. For production configure:

```dotenv
NODE_ENV=production
REDIS_URL=rediss://your-existing-redis-service
# Set to the trusted proxy configuration for your actual hosting platform.
TRUST_PROXY=
```

The Redis URL above is illustrative; use the existing private deployment value and credentials. Never place it or database, JWT, or mail credentials in public Expo variables. Redis must allow normal key creation/expiry and the CAPTCHA Lua script.

Remove obsolete `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, and `RECAPTCHA_ALLOWED_HOSTNAMES` from the configuration of this updated API. Remove any obsolete public CAPTCHA key from a deployment of this updated client. No CAPTCHA key replaces them. Configuration and source outside this workspace, including the sibling website's `VITE_RECAPTCHA_SITE_KEY`, were not changed. No database migration is required for CAPTCHA; attendance/push migrations remain independent.

## Installation and deployment

1. Use Node 22.13 or later for the app, and install the root/backend dependencies with the two `npm ci` commands above.
2. Preserve the existing private backend environment and set the API, CORS, mail, Supabase, JWT, Redis, and proxy values for the intended host. Remove its obsolete CAPTCHA variables. For a single local API without Redis, use `NODE_ENV=development`; production requires working Redis.
3. Deploy the complete updated `backend/` directory, or start it locally with `npm start --prefix backend`. On Vercel use Root Directory `backend` and the existing Express configuration. The mobile extension installer does not copy auth controllers, root routes, or the math CAPTCHA service and cannot install this migration by itself. No installer apply command or new SQL migration is needed for this workspace.
4. Verify `/api/health` and `/api/captcha/challenge?action=login` on the intended API host. The latter should return only a question, challenge ID, expiry, and success flag. Run `npm run check:connection` from the app project to check its configured API.
5. Set `EXPO_PUBLIC_API_URL` to that API address, ending with `/api`. For a local web preview, set the optional loopback override and allow its origin in `CORS_ALLOWED_ORIGINS`. For a phone use a reachable LAN address during development or HTTPS API. Restart Metro after environment changes with `npm start` or `npm run web`.
6. Verify complete login, email OTP, and password-recovery workflows. For a release bundle use the deployed HTTPS URL in the appropriate EAS environment, rebuild the app, and distribute only after device acceptance checks.

## Testing

Run the repository's checks from the project root:

```powershell
npm run check
node --test backend-extension/tests/math-captcha.test.js backend-extension/tests/captcha-http.test.js backend-extension/tests/captcha-settings.test.js
```

The second command is a focused rerun when debugging CAPTCHA. The automated suites use isolated fixtures and cover operator limits, response privacy, answer parsing, missing/expired/reused challenges, concurrent single-use consumption, wrong-action tokens, token expiry, rate limits, storage failures, required policy, login/password-recovery bypass rejection, and unchanged OTP behavior. See [recorded verification results](VERIFICATION.md) for current counts and export/browser validation.

A local API smoke test uses a question from the running backend:

```powershell
$captchaApiBase = 'http://127.0.0.1:5000/api'
$captchaChallenge = Invoke-RestMethod "$captchaApiBase/captcha/challenge?action=login"
$captchaChallenge.question
$enteredCaptchaAnswer = Read-Host 'Enter the displayed math answer'
$captchaRequestBody = @{
  challengeId = $captchaChallenge.challengeId
  answer = $enteredCaptchaAnswer
  action = 'login'
} | ConvertTo-Json
$captchaVerified = Invoke-RestMethod "$captchaApiBase/captcha/verify" -Method Post -ContentType 'application/json' -Body $captchaRequestBody
$captchaVerified | Select-Object success, expiresAt
# Repeating this verification request must return HTTP 400:
Invoke-RestMethod "$captchaApiBase/captcha/verify" -Method Post -ContentType 'application/json' -Body $captchaRequestBody
```

Use a separate challenge for each further test. An incorrect answer must fail and invalidate its challenge; solving it afterward must still fail. A challenge older than five minutes must fail. In the isolated test environment, send the verified token as `captchaToken` to the matching protected endpoint; reusing it or sending a login token to password recovery must fail. Direct login/recovery calls without a token must fail. Verification tokens older than 60 seconds must fail, and a late-solved challenge cannot extend its original expiry. Test rate-limit thresholds in isolated development instead of sending bursts to the school API.

In the app, test **Refresh question**, wrong-answer feedback, refresh after failure, modal cancellation/reopening, question expiry, network retry, and narrow/mobile layouts. A correct answer should continue the pending form automatically. An OTP step should not reopen CAPTCHA. Password recovery should send its existing secure web reset link after successful verification. Inspect the browser network response and component state to confirm the expected answer is absent. Test Redis outages on staging to confirm HTTP 503 and blocked login/recovery rather than a verification bypass.

## Changed and deleted files

The CAPTCHA migration touches the following groups. Existing unrelated work, if present in the working tree, is not part of these changes.

| Purpose | Modified or added files |
| --- | --- |
| Shared math CAPTCHA and protected forms | `src/auth/Captcha.tsx`, `src/auth/LoginScreen.tsx`, `src/auth/SettingsScreen.tsx`, `src/auth/loginSecurity.ts` |
| Typed API contracts/configuration | `src/api/edumatch.ts`, `src/api/types.ts`, `src/config/resolveApiConfiguration.ts`, `scripts/check-connection.cjs` |
| Secure backend generation/verification | Added `backend/services/mathCaptchaService.js`, added `backend/routes/captchaRoutes.js`, `backend/server.js`, `backend/controllers/authController.js`, `backend/middlewares/rateLimiters.js` |
| Required CAPTCHA policy and auditing | Added `backend/controllers/captchaSettingsController.js`, `backend/routes/authRoutes.js`, `backend/routes/adminRoutes.js`, `backend/services/supabaseSettingsService.js`, `backend/middlewares/auditLogMiddleware.js` |
| Mobile compatibility route | `backend-extension/index.js`, `backend/mobile/index.js` |
| Configuration/dependencies | `backend/.env.example`, `package.json`, `package-lock.json` |
| Frontend regression checks | Added `tests/captcha-api.test.ts`, `tests/login-security.test.ts`, `tests/admin-settings-api.test.ts` |
| Backend regression checks | Added `backend-extension/tests/math-captcha.test.js`, `backend-extension/tests/captcha-http.test.js`, `backend-extension/tests/captcha-settings.test.js`; updated `backend-extension/tests/mobile.test.js`, `backend-extension/tests/admin-otp-settings.test.js`, `backend-extension/tests/admin-profile.test.js`, `backend-extension/tests/self-settings-routes.test.js` |
| Documentation | `README.md`, `backend/README.md`, `backend-extension/README.md`, `docs/API-CONTRACT.md`, `docs/VERIFICATION.md`, added `docs/MATH-CAPTCHA-MIGRATION.md` |

Deleted files are `src/auth/Captcha.web.tsx`, `backend-extension/lib/captcha.js`, `backend/mobile/lib/captcha.js`, `backend/controllers/recaptchaSettingsController.js`, and `backend-extension/tests/recaptcha-settings.test.js`. The native/web CAPTCHA component is now shared, the Google HTML bridge is removed, and renamed math-policy tests replace Google-specific fixtures. Existing local backend environment files may be cleaned of obsolete CAPTCHA entries; those private files remain untracked and are not distributed.
