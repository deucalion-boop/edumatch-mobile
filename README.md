# EduMatch Mobile

A separate `edumatch-mobile` project for Android and iOS, built with React Native, Expo SDK 57, TypeScript, Expo Router, Axios, and TanStack Query. It connects to the existing EduMatch Express backend and its Supabase PostgreSQL database and private file storage.

The existing web project is at `../Edumatch`. Mobile routes are separate from web pages. Principal accounts retain the server's `admin` role. Authentication, approval permissions, grade formulas, enrollment checks, QR validation, duplicate prevention, and final attendance records remain server responsibilities.

The mobile sign-in screen uses primary green `#69AA47`, dark green `#3F7F2A`, a `#F8FAFC` background, and a white login card. A shared background adds thin, evenly spaced horizontal and vertical green lines to the login and role screens, with low opacity to keep the content easy to read. A compact school header sits above a single-column form on phones and wide screens, with larger inputs, touch controls, and scrolling on short screens. Sign In opens the security verification window before calling the existing authentication APIs; password visibility, "Remember me", password recovery, and email OTP are supported. Password recovery sends the existing web reset link to the registered email address. Unchecking "Remember me" keeps the accepted session in memory until the app closes; checked native sessions use SecureStore. The server still controls session expiry and revocation.

Role dashboards use the same palette, with white cards, green icons, school metrics, and recent activity. Narrow phones use single-column metric cards and shorter tab labels with full accessibility labels. Larger layouts use card grids. School tools are available through Workspace and the dashboard's workspace button. Dark green keeps buttons and text readable; primary green supplies accents. Loading and retry states retain navigation, and unavailable school data does not appear as an empty activity feed. Grade restrictions and backend routes are preserved.

## Start locally

Use Node 22.13 or newer. Dependencies are already installed in this workspace; a fresh checkout uses `npm ci`.

```powershell
Copy-Item .env.example .env
# Edit EXPO_PUBLIC_API_URL in .env, including /api.
npm ci
npm start
```

For a physical phone, use an HTTPS development API or the computer's LAN address, for example `http://192.168.1.100:5000/api`. The phone and computer must be on the same network. Android emulators use `http://10.0.2.2:5000/api`; iOS simulators on the API host can use `http://localhost:5000/api`. Start the existing backend normally and allow its port through the local firewall. Restart Metro after changing `.env`. Release bundles reject HTTP API URLs.

For a browser preview opened on `localhost`, `127.0.0.1`, or `[::1]`, set `EXPO_PUBLIC_WEB_API_URL=http://localhost:5000/api` in `.env` to serve CAPTCHA from the local backend hostname approved by its key. This override applies only in development on those browser hosts; phones, remote previews, and release builds use `EXPO_PUBLIC_API_URL`. The backend must allow the preview origin. Restart Metro after changing either URL.

The local mobile `.env` is now pointed at this computer's detected LAN address, `http://192.168.254.136:5000/api`. The existing backend is configured for the same Supabase project as the web app. This address can change when the computer reconnects to the network. Check the actual connection with:

```powershell
npm run check:connection
```

This command checks the public backend health and mobile CAPTCHA endpoints. It does not read or transmit database credentials, sign in, or change school records. A successful health response means the backend's own database/private-storage startup checks passed. A configured CAPTCHA endpoint does not prove Google accepts its key/domain; verify the real CAPTCHA and email OTP sign-in separately.

Use Expo Go for SDK 57 and scan the QR code from `npm start` (or `npm run start:go`). To clear Metro's cache after an SDK upgrade, stop the previous server with Ctrl+C and run `npm start -- --clear`. These commands explicitly select Expo Go even when `expo-dev-client` is installed; the terminal should display `Using Expo Go` and an `exp://` URL. Keep your phone and computer on the same Wi-Fi. For the complete remote push workflow, install an EAS development build and use `npm run start:dev`. Rebuild existing development clients after upgrading the SDK. Native Android builds require Android Studio/SDK; local iOS builds require macOS and Xcode. EAS can build both platforms from Windows.

Expo Go skips remote push registration and listeners so unsupported Android push APIs do not interrupt startup or sign-in. The app's notification inbox still uses the backend normally. See [Expo's notification support](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) and [CLI launch targets](https://docs.expo.dev/more/expo-cli/#launch-target).

## Connect the existing backend

Mobile and web sign in through the same `/api/auth/login` and email OTP endpoints. Existing accounts are stored in Supabase's `public.users` table with password hashes and use backend-issued sessions; they are not Supabase Auth accounts. Adding Supabase API keys to the mobile `.env` will not enable these accounts to sign in. The mobile app needs only `EXPO_PUBLIC_API_URL` pointing to the running EduMatch backend. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the existing backend environment; the last variable accepts the server's Supabase secret key. Keep that secret out of the mobile app and rotate any key that has been shared. See [Supabase's API key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

The reviewed installer adds `backend/mobile/`, migrations 013 and 014, and one `/api/mobile` mount. It backs up `server.js`, detects unmanaged changes, and is idempotent. It has been applied to the neighboring EduMatch backend in this workspace. It never applies SQL or starts a service.

For another checkout:

```powershell
node backend-extension/install.cjs --backend ../Edumatch/backend --check
node backend-extension/install.cjs --backend ../Edumatch/backend --apply
```

Apply `013_mobile_attendance.sql` and `014_mobile_push.sql` after the existing migrations 001–012 to the **same** Supabase database through your migration process, then restart the API. New tables use RLS and service-role-only RPCs. Keep the Supabase service role key, JWT secret, CAPTCHA secret, and Expo access token exclusively on the backend.

The backend needs `RECAPTCHA_SITE_KEY` for the existing reCAPTCHA v2 account verification and `EXPO_PROJECT_ID` matching the EAS project. The API hostname must be allowed in the existing Google reCAPTCHA configuration. Gmail OTP delivery and the existing CAPTCHA secret remain required. Native sign-in loads `/api/mobile/captcha` in a WebView, then uses the original login and email OTP endpoints. Both stages obtain a fresh CAPTCHA token. Forced password changes revoke the old session and require a new sign-in.

The public CAPTCHA site key must be different from the secret verification key. The mobile CAPTCHA endpoint refuses to serve a secret configured as its site key. Remove duplicate `RECAPTCHA_SECRET_KEY` entries from backend environment files when correcting the pair; dotenv otherwise uses the final occurrence within a file. Keep JWT, Supabase secret/service-role, mail and CAPTCHA secret keys out of the mobile project. If these values were shared publicly or bundled into a frontend, rotate them at their providers and update the backend configuration.

In this workspace, the supplied distinct CAPTCHA pair is configured in the existing backend's `.env` and `.env.local`, with one secret entry per file. The local web frontend's `VITE_RECAPTCHA_SITE_KEY` now contains the public key, and the backend allows the mobile preview origins on port 8081. Restart the local web development server to reload its changed environment; a deployed web frontend needs its own public-key environment update and rebuild. No CAPTCHA secret was added to the mobile project. The restarted backend's mobile CAPTCHA endpoint returns HTTP 200.

Google's domain settings must allow the hostname serving `/api/mobile/captcha`. The local browser override hosts this page at `localhost`; physical phones still use `192.168.254.136` through the mobile API URL. If Google reports an invalid domain on a phone, use an API hostname allowed for the key and update `EXPO_PUBLIC_API_URL`; authorizing `localhost` alone does not establish that the LAN address is accepted. Google key/domain acceptance and a complete CAPTCHA/email OTP sign-in remain device acceptance checks. See [Google's domain validation guide](https://developers.google.com/recaptcha/docs/domain_validation).

For browser previews, allow the preview origin in the backend's `CORS_ALLOWED_ORIGINS`. The CAPTCHA page allows only those configured origins as iframe parents. Native requests use the backend's existing no-origin CORS behavior.

Run the push worker separately under your deployment's process supervisor:

```powershell
$env:EDUMATCH_BACKEND_ROOT = 'C:/path/to/Edumatch/backend'
node backend-extension/scripts/push-worker.js
```

The worker processes the existing notification events with persisted queues, session checks, retries, Expo tickets, and receipts. APNs and FCM credentials must be configured in EAS. See [backend setup and contracts](backend-extension/README.md) and [existing REST API mappings](docs/API-CONTRACT.md).

## Development and release builds

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
# Put the resulting project UUID in EXPO_PUBLIC_EAS_PROJECT_ID.
# Set EXPO_OWNER, Android package, and iOS bundle identifier in .env.
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest build --profile development --platform ios
npm run start:dev
```

Configure `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_EAS_PROJECT_ID` in each EAS environment: `development`, `preview`, and `production`. Use EAS environment variables rather than relying on a gitignored local `.env` being uploaded. Android push requires `google-services.json`; provide its path with `GOOGLE_SERVICES_JSON` using an EAS file environment variable. Configure iOS APNs credentials using EAS credentials. Optional Firebase iOS configuration can be supplied through `GOOGLE_SERVICES_PLIST`.

`eas.json` includes physical development builds, an iOS simulator build, internal preview APKs, and production Android AAB/iOS builds with automatic version increments. Signing accounts, certificates, store identifiers, and submission credentials belong to the school.

```powershell
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --profile production --platform all
```

EAS builds and store submission have not been run in this environment. The project has no invented EAS project ID or signing credentials. [Expo Router](https://docs.expo.dev/router/introduction/), [React Native query refresh](https://tanstack.com/query/latest/docs/framework/react/react-native), [SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/), [Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/), [Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/), and [EAS Build](https://docs.expo.dev/build/introduction/) provide the upstream integration references.

## Role workflows

| Account | Mobile workflows |
| --- | --- |
| Admin / Principal | School dashboard, account creation and records, export/account approvals, academic monitoring, attendance reports, messages, notification inbox |
| Secretary | Dashboard, active/archived student records, school-year filtering and export requests, authorized account creation/archive, attendance reports, request status, messages |
| Head Teacher | Department dashboard and academic results, assigned-teacher lesson publication with PDF plan, grading reports, attendance monitoring, teacher messages |
| Teacher | Classes and enrollment approvals, lesson/activity publication, student responses and grading/feedback, QR attendance, complete manual rosters, locked finalization, subject announcements |
| Student | Dashboard, attendance scanning/history, announcements; authorized subject enrollment, lessons/progress, file/link/written activities, exams, grades/feedback and academic progress |

Students in every grade can open **Workspace → Subjects**, enter the teacher's enrollment code, and request to join a class. Approved and pending classes are shown together with their enrollment status. The neighboring backend permits class listing and code enrollment for all student grades; requests require teacher approval. Lessons, assessments, submissions, grades, and academic progress retain the backend's Grade 10 requirement. The mobile grade check recognizes both `Grade 10` and `10`, avoiding hidden tools when the backend returns its full grade label. Students in other grades retain attendance records in the Records tab.

Lessons and assessments each display five records per page with Previous/Next controls and separate page selections. Opening a record uses a full-screen reading view with a persistent Back button; closing it returns to the same list page and scroll position. Student lesson progress and saved assessment drafts use the existing APIs.

The neighboring backend's student attendance query now serializes its JSONB containment value before passing it to Supabase. This corrects the `invalid input syntax for type json` dashboard error while retaining the current student's filter. The backend regression tests cover the actual SDK request serialization, escaped student identifiers, empty results, and database failures.

TanStack Query provides refresh, retries, reconnect and app-focus behavior. Private query data is cleared on sign-out/account changes and is not persisted to disk. Tokens are stored through SecureStore on native devices; the optional browser preview keeps its token in memory. Mutations are not queued offline. A failed QR scan can be retried safely because the server returns the existing scan result.

## Verification

```powershell
npm run check
node verification/smoke.cjs
node node_modules/expo/bin/cli export --platform all --output-dir dist
```

The database integration tests use a dev-only embedded PostgreSQL engine and load the actual existing migrations plus 013–014 into isolated test data. They never connect to the school's Supabase instance. If the optional engine is unavailable on a fresh checkout, install the `backend-extension` development dependencies to enable those tests; the suite reports a skip otherwise.

See [verification results and device acceptance steps](docs/VERIFICATION.md). The HTTP fixture is isolated under `verification/`, contains synthetic accounts, and is never imported by the app. Native camera scanning, permission prompts, device uploads, real push delivery, live Supabase migration and signed EAS binaries require the school's devices and deployment configuration.
