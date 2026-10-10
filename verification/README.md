# Local browser verification fixture

This directory contains a **test-only** HTTP fixture for deterministic browser verification. It is separate from the shipped app and from the backend extension. Never deploy it or configure a release build to point at it. It uses fake in-memory users, tokens, attendance and grades and does not contact PostgreSQL, Supabase storage, email, Google CAPTCHA, Expo push, or real devices.

Start it in one terminal:

```powershell
node verification/mock-api.cjs
```

Start a web preview in another terminal with the fixture API:

```powershell
$env:EXPO_PUBLIC_API_URL='http://127.0.0.1:5099/api'
$env:EXPO_PUBLIC_WEB_API_URL='http://127.0.0.1:5099/api'
npx expo start --web --port 8081
```

Sign in as `admin`, `secretary`, `headteacher`, `teacher`, or `student`. `principal` also maps to Admin. All fixture accounts use password `VerifyEduMatch1!` and OTP `123456`. The fixture's CAPTCHA page requires pressing **Complete verification check** at each stage and sends its result through the same native/web bridge as the real page. The production backend's CAPTCHA verification is unchanged and will reject this fixture token.

The fixture supplies populated dashboards, records, academic monitoring, notifications, lessons, activities and attendance for all five roles. Admin has an export request and an account request to review; Teacher has an enrollment request, grading result, announcement target, and attendance roster. Teacher announcements appear in the Student feed. The Teacher QR workflow creates, reads, rotates and finalizes a session. Student scan requests accept the opaque generated payload and return a deterministic duplicate result on repeat. The browser camera and native push require separate physical-device verification.

State resets when the process restarts. The fixture binds only to `127.0.0.1` on port `5099`; override the port with `VERIFICATION_API_PORT`. Set `VERIFICATION_LEARNING_PAGINATION=true` before starting it to load eleven lessons and seven assessments for pagination and reader checks. The default fixture data is unchanged. It is intentionally incomplete and returns 404 for unimplemented endpoints, which makes contract mismatches visible during review. Its simplified validation is not a replacement for the backend extension's server tests.

Run `node verification/smoke.cjs` to start an isolated fixture on port 5100, verify all role reads and teacher grading, QR rotation/duplicate/finalization, announcements and export approvals, and stop that isolated process automatically. This leaves the main review fixture on port 5099 unchanged.

Automated API adapter tests run with `npm test` and exercise production API client code without connecting to this fixture. Backend tests run with `npm run test:backend`. Browser evidence against this fixture should be reported explicitly as fixture verification, separate from staging/database, camera, push delivery, Android or iOS testing.
