# EduMatch mobile backend extension

This package mounts additive APIs on the existing Express application. It reads the existing `users`, `sessions`, `subjects`, `subject_enrollments`, `notifications`, and `attendance_records` tables and imports the existing authentication middleware and role controllers. Existing web routes and server grade formulas remain the source of truth. Principal is a display label for the existing `admin` role.

## Install and configure

Node 20 or later and the existing backend dependencies are required. No production dependency installation is needed for this extension.

From the separate mobile project, inspect the integration first:

```powershell
node backend-extension/install.cjs --backend ../Edumatch/backend --check
node backend-extension/install.cjs --backend ../Edumatch/backend --apply
```

The installer copies runtime modules into `backend/mobile/`, copies migrations into `backend/supabase/migrations/`, and inserts one `/api/mobile` mount before the existing 404/error handlers. It backs up the previous `server.js`, refuses unmanaged file conflicts or ambiguous mount locations, and can be run again. It does not apply SQL or restart a service.

Apply the existing migrations 001–012, then apply `013_mobile_attendance.sql` and `014_mobile_push.sql` to the same Supabase PostgreSQL database using your normal migration process. Both migrations use a transaction, enable RLS on all new tables, revoke direct client access, and restrict RPC execution to the backend service role. Do not expose the Supabase service key to the app. A backup and staging migration check belong in the school's normal deployment process.

Add these values to the **backend** environment:

```dotenv
RECAPTCHA_SITE_KEY=your_existing_recaptcha_v2_site_key
EXPO_PROJECT_ID=your_eas_project_uuid
EXPO_ACCESS_TOKEN=optional_expo_push_security_access_token
SCHOOL_TIMEZONE=Asia/Manila
EDUMATCH_BACKEND_ROOT=C:/path/to/Edumatch/backend
```

Continue using the existing backend `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, private storage configuration, `JWT_SECRET`, Gmail OTP configuration, and `RECAPTCHA_SECRET_KEY`. Allow the API hostname in Google's reCAPTCHA configuration and in `RECAPTCHA_ALLOWED_HOSTNAMES`. Mobile native HTTP requests have no browser origin; the existing CORS policy permits these requests. The app uses only the existing `Authorization` and `Content-Type` headers.

Start the existing API normally. Run the durable push worker as a separate supervised process:

```powershell
$env:EDUMATCH_BACKEND_ROOT = 'C:/path/to/Edumatch/backend'
node backend-extension/scripts/push-worker.js
```

After installation, the worker is also available at `backend/mobile/scripts/push-worker.js`. Configure EAS APNs/FCM credentials, use a physical development/release build, and ensure Expo project IDs match. See [Expo's server delivery documentation](https://docs.expo.dev/push-notifications/sending-notifications/).

## API contracts

All protected requests send the same `Authorization: Bearer <token>` as the web app. Responses are flat `{success: true, ...fields}`. Errors use the existing Express error handler `{success: false, message}`.

| Method and path, relative to `/api/mobile` | Role | Request / response |
| --- | --- | --- |
| `GET /captcha` | Public | HTTPS HTML page with configured reCAPTCHA v2. Posts `{type:'captcha',token}`, `{type:'expired'}`, or `{type:'error'}` to the native WebView bridge. No auth token goes into a URL. |
| `GET /me` | Any account | `{user}` using the login user shape, with safe section IDs. Works during forced password change using the existing self-account security authentication policy. |
| `GET /bootstrap` | All five roles | `{user,dashboard:{metrics:[{label,value}],capabilities,insights?}}`. Calls only that role's existing server controllers. |
| `POST /devices` | All five roles | `{installationId,expoPushToken,platform:'android'|'ios',projectId}` → `{device:{installationId,platform,enabled}}`. Binds the authenticated account and session. |
| `DELETE /devices/:installationId` | Own device | Disables the current account's matching installation only. |
| `GET /attendance/sessions?subjectId=` | Teacher | `{sessions}`; at most 50, newest first. |
| `POST /attendance/sessions` | Teacher | `{subjectId,dateKey,durationMinutes?:15,lateAfterMinutes?:5}` → `{session,qrPayload}`. Current school day only. |
| `GET /attendance/sessions/:id` | Owning Teacher | `{session,roster:[{studentId,studentName,status,scannedAt}]}`. Unscanned status is `null`. |
| `POST /attendance/sessions/:id/rotate` | Owning Teacher | `{session,qrPayload}`. Revokes the previous QR secret without extending the window. |
| `POST /attendance/scan` | Student | `{qrPayload}` → `{attendance:{sessionId,subjectId,dateKey,status,scannedAt},duplicate}`. Server chooses Present/Late and returns the original result for retries. |
| `POST /attendance/sessions/:id/finalize` | Owning Teacher | `{overrides?:[{studentId,status}]}` → `{session,record}`. Status is Present/Late/Absent/Excused. Unscanned students default to Absent. |
| `POST /attendance/sessions/:id/cancel` | Owning Teacher | `{session}`. Frees an open window; cannot cancel a finalized record. |

Session fields are `id`, `subjectId`, `dateKey`, `status` (`open`, `finalized`, `cancelled`), `expiresAt`, `lateAfter`, `createdAt`, `attendanceRecordId`, and `scanCount`. The QR is `edumatch://attendance/<sessionId>?token=<randomSecret>` and only the SHA-256 secret hash is stored on the server. List/create responses report a default zero scan count; the detail endpoint returns the live count. Finalized record fields include `id`, `dateKey`, `isLocked`, `lockedAt`, `subject`, `entries`, and `summary`.

Existing login remains `POST /api/auth/login` with `{username,password,captchaToken,remember}`. It returns `202` and `{requiresOtp,challengeToken,expiresAt,resendAvailableAt,deliveryHint}`. Verify with `/api/auth/login/verify-otp` using `{challengeToken,otpCode,captchaToken}` and a **new CAPTCHA token**. This returns `{token,user}`. OTP resend uses `/api/auth/login/resend-otp`. Forced password change uses the existing `/api/auth/change-password`. The extension does not bypass CAPTCHA, OTP, maintenance, revoked sessions, token versions, or inactivity policy.

Approvals, accounts, grading, academic monitoring, announcements, files, and manual attendance continue through the existing `/api/admin`, `/api/secretary`, `/api/headteacher`, `/api/teacher`, `/api/student`, `/api/notifications`, and `/api/storage` APIs. The mobile client never calculates authoritative grades or creates attendance for a supplied student ID.

## Attendance and web compatibility

The session snapshots the approved active class roster when opened. New enrollment changes take effect in the next session; a removed or inactive student cannot scan. Finalization includes the snapshot roster, defaults unscanned students to Absent, applies teacher overrides, calculates all totals in PostgreSQL, and inserts an already locked row into the **existing** `attendance_records` table. Student, Secretary, Head Teacher, and Admin attendance reports immediately see that row through their existing APIs. Finalization is idempotent.

PostgreSQL row locks serialize scans, QR rotation, cancellation, and finalization. A primary key prevents duplicate scans. A shared advisory lock prevents a concurrent web manual save from racing session creation. Existing attendance for a class/day blocks opening a QR session. While a QR session is open, manual writes for that class/day return a conflict; finalize or cancel it first. A database trigger makes finalized attendance immutable, also fixing the original web save/lock race. Expired sessions stay available for finalization/cancellation; they reject new scans.

These QR windows prove possession of a short-lived class QR by an approved account. They do not establish physical location or prevent one student sharing a picture with another enrolled student. No client GPS claim is trusted as attendance authority.

## Push delivery

The notification INSERT trigger enqueues existing web and mobile events once per notification/installation; there is no unrestricted broadcast API. Device registration enforces installation/token ownership and Expo project identity. Sending filters active account, current token version, bound session revocation/expiry/inactivity, forced password changes, maintenance policy, notification category preferences, and cleared notifications. Logout/revoke on the web immediately makes a registered mobile device ineligible, even if mobile unregistration fails. Re-registration after sign in binds the new session; queued messages for an old session are cancelled.

The worker claims batches with `FOR UPDATE SKIP LOCKED`, persists sending leases, retries transient HTTP/Expo errors with bounded exponential backoff (maximum five attempts), checks tickets after 15 minutes, and records receipts. `DeviceNotRegistered` disables only the installation with the matching bound session. Device lock-screen payloads contain a generic school update and notification ID, with no grades, student names, announcement content, or JWTs. Notification detail is fetched under authentication after the app opens. Expo acceptance receipts do not prove the phone displayed the message; network failures can produce duplicate pushes because delivery is at least once.

## Verification

```powershell
node --test backend-extension/tests/*.test.js
```

Unit tests cover unauthorized role actions, foreign-session visibility, QR input/hash behavior, impossible dates, authenticated scan identity, duplicate override denial, device project/session/ownership, forced-password identity lookup, privacy, push tickets, receipts, retries, and device retirement.

The embedded PostgreSQL integration suite uses dev-only `@electric-sql/pglite`, loads the **actual existing migration files**, and then runs both mobile migrations and transactional attendance/device/notification tests. To enable it, run `npm install --ignore-scripts` inside `backend-extension`. It skips when this test dependency or the original backend migrations are unavailable. Set `EDUMATCH_BACKEND_ROOT` if the web backend is not at `../Edumatch/backend`. The tests use isolated in-memory data and never connect to your Supabase instance. Production database migration, authenticated physical-device scanning, push delivery, APNs/FCM credentials, and EAS signing still require your deployment environment.
