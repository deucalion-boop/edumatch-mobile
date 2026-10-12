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

For a browser preview opened on `localhost`, `127.0.0.1`, or `[::1]`, set `EXPO_PUBLIC_WEB_API_URL=http://localhost:5000/api` in `.env` to use the local backend. This override applies only in development on those browser hosts; phones, remote previews, and release builds use `EXPO_PUBLIC_API_URL`. The backend must allow the preview origin. Restart Metro after changing either URL.

The local mobile `.env` is now pointed at this computer's detected LAN address, `http://192.168.254.136:5000/api`. The existing backend is configured for the same Supabase project as the web app. This address can change when the computer reconnects to the network. Check the actual connection with:

```powershell
npm run check:connection
```

This command checks the public backend health and math CAPTCHA challenge endpoints. It does not read or transmit database credentials, sign in, or change school records. A successful health response means the backend's own database/private-storage startup checks passed. Verify the complete math CAPTCHA and email OTP sign-in separately.

Use Expo Go for SDK 57 and scan the QR code from `npm start` (or `npm run start:go`). To clear Metro's cache after an SDK upgrade, stop the previous server with Ctrl+C and run `npm start -- --clear`. These commands explicitly select Expo Go even when `expo-dev-client` is installed; the terminal should display `Using Expo Go` and an `exp://` URL. Keep your phone and computer on the same Wi-Fi. For the complete remote push workflow, install an EAS development build and use `npm run start:dev`. Rebuild existing development clients after upgrading the SDK. Native Android builds require Android Studio/SDK; local iOS builds require macOS and Xcode. EAS can build both platforms from Windows.

Expo Go skips remote push registration and listeners so unsupported Android push APIs do not interrupt startup or sign-in. The app's notification inbox still uses the backend normally. See [Expo's notification support](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) and [CLI launch targets](https://docs.expo.dev/more/expo-cli/#launch-target).

## Connect the existing backend

The `backend/` directory contains the reviewed deployment copy of the existing Express API, including the mobile routes. To deploy this repository to Vercel, set the project's Root Directory to `backend`, select the Express framework preset, and clear any Expo build command or `dist` output override. Configure the server environment in Vercel using [backend/.env.example](backend/.env.example), then redeploy. See [backend deployment instructions and hosting limits](backend/README.md).

Verify `https://<your-api-domain>/api/health` and `https://<your-api-domain>/api/captcha/challenge?action=login` before setting the mobile EAS API URL or building the APK. The backend uses the existing Supabase database and private storage; credentials and local uploaded files are excluded from the repository.

Mobile and web sign in through the same `/api/auth/login` and email OTP endpoints. Existing accounts are stored in Supabase's `public.users` table with password hashes and use backend-issued sessions; they are not Supabase Auth accounts. Adding Supabase API keys to the mobile `.env` will not enable these accounts to sign in. The mobile app needs only `EXPO_PUBLIC_API_URL` pointing to the running EduMatch backend. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the existing backend environment; the last variable accepts the server's Supabase secret key. Keep that secret out of the mobile app and rotate any key that has been shared. See [Supabase's API key guidance](https://supabase.com/docs/guides/getting-started/api-keys).

The reviewed installer adds `backend/mobile/`, migrations 013 and 014, and one `/api/mobile` mount. It backs up `server.js`, detects unmanaged changes, and is idempotent. It never applies SQL or starts a service. This installer is for the mobile extension; it does not copy the math CAPTCHA authentication routes, service, or controllers. Deploy the updated `backend/` tree for this CAPTCHA migration. The neighboring website was not edited as part of this migration.

For another checkout:

```powershell
node backend-extension/install.cjs --backend ../Edumatch/backend --check
node backend-extension/install.cjs --backend ../Edumatch/backend --apply
```

Apply `013_mobile_attendance.sql` and `014_mobile_push.sql` after the existing migrations 001–012 to the **same** Supabase database through your migration process, then restart the API. These attendance and push migrations are independent of math CAPTCHA, which needs no database migration. New tables use RLS and service-role-only RPCs. Keep the Supabase service role key, JWT secret, and Expo access token exclusively on the backend.

Math CAPTCHA displays an addition or subtraction question in the existing security window on native devices and the Expo web preview. The backend generates each question, verifies the answer once, and issues a short-lived token required by login or password recovery. Questions expire after five minutes. Email OTP continues without a second CAPTCHA, and forced password changes retain the existing session revocation behavior.

Production requires `REDIS_URL` for shared atomic challenge and verification-token consumption. Local development without Redis uses a bounded in-memory store. No CAPTCHA site or secret keys are required. Keep the existing Gmail/mail configuration and `EXPO_PROJECT_ID` for OTP delivery and push. For browser previews, allow the preview origin in `CORS_ALLOWED_ORIGINS`; native requests retain the existing no-origin CORS behavior. See [math CAPTCHA migration, installation, API examples, and tests](docs/MATH-CAPTCHA-MIGRATION.md).

Run the push worker separately under your deployment's process supervisor:

```powershell
$env:EDUMATCH_BACKEND_ROOT = 'C:/path/to/Edumatch/backend'
node backend-extension/scripts/push-worker.js
```

The worker processes the existing notification events with persisted queues, session checks, retries, Expo tickets, and receipts. APNs and FCM credentials must be configured in EAS. See [backend setup and contracts](backend-extension/README.md) and [existing REST API mappings](docs/API-CONTRACT.md).

## Development and release builds

This checkout is linked to [@4dmin01/edumatch](https://expo.dev/accounts/4dmin01/projects/edumatch), project ID `16f46295-63ba-4cd3-89aa-7874be0a09e8`. The public owner and project ID are committed as defaults in `app.config.ts`, so fresh checkouts resolve the existing project. Environment variables can override them when connecting a different Expo project.

For a directly installable Android APK, use the existing `preview` profile:

```powershell
npm run eas:login
npm run eas:info
npm run build:preview
```

`build:preview` uses EAS CLI through `npx`, so a global CLI installation is not required. The preview APK runs independently of Metro and Expo Go. Before building, configure `EXPO_PUBLIC_API_URL` in the EAS `preview` environment with the deployed HTTPS backend address ending in `/api`. A local HTTP or LAN address will be rejected by the release app. Verify math CAPTCHA and email OTP login before sharing the APK.

```powershell
npx eas-cli@latest login
npm run eas:info
# Set the public API URL in the development EAS environment.
npx eas-cli@latest build --profile development --platform android
npx eas-cli@latest build --profile development --platform ios
npm run start:dev
```

Configure `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_EAS_PROJECT_ID` in each EAS environment: `development`, `preview`, and `production`. Use EAS environment variables rather than relying on a gitignored local `.env` being uploaded. Android push requires `google-services.json`; provide its path with `GOOGLE_SERVICES_JSON` using an EAS file environment variable. Configure iOS APNs credentials using EAS credentials. Optional Firebase iOS configuration can be supplied through `GOOGLE_SERVICES_PLIST`.

Android push is optional. Builds without Firebase configuration skip push registration and show a clear availability message when **Enable notifications** is tapped. School updates remain available through the app's **Notifications** screen and existing Supabase backend. A local `./google-services.json` is detected automatically; it must belong to Android package `com.edumatch.mobile` (or your `EXPO_ANDROID_PACKAGE` override). For cloud builds, upload it as the `GOOGLE_SERVICES_JSON` file variable in the profile's EAS environment. To deliver Android push alerts, also configure the Firebase FCM V1 service account under EAS Android credentials, then rebuild and reinstall the APK. The FCM service account private key belongs in EAS credentials, not in the app. See [Expo's Android push setup](https://docs.expo.dev/push-notifications/fcm-credentials/).

`eas.json` includes physical development builds, an iOS simulator build, internal preview APKs, and production Android AAB/iOS builds with automatic version increments. Signing accounts, certificates, store identifiers, and submission credentials belong to the school.

```powershell
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest submit --profile production --platform all
```

EAS project linking has been verified. Signed builds and store submission have not been run in this environment; EAS can generate the Android keystore on the first build. [Expo Router](https://docs.expo.dev/router/introduction/), [React Native query refresh](https://tanstack.com/query/latest/docs/framework/react/react-native), [SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/), [Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/), [Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/), and [EAS Build](https://docs.expo.dev/build/introduction/) provide the upstream integration references.

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

Dashboard Recent activity displays five entries per page with Previous/Next controls, page counts, and entry ranges. It pages through the activity returned by the existing role-specific APIs. Refresh keeps the current page when possible and adjusts it if fewer entries remain.

Admins can open **Workspace → AI assessment analytics** to review AI draft-generation requests over the last 7, 30, or 90 school calendar days. The page shows successful drafts, failures, active creators, a usage chart, creator totals, and five requests per history page. Counts come from the audited teacher and head teacher AI generation endpoints, rather than assuming every saved assessment used AI. Successful drafts include any recorded local fallback; publishing, token consumption, and monetary cost are not measured. New generation records include provider, model, subject, question counts, and generation mode when available. Existing audit records remain usable without a database migration.

Active admin accounts receive notifications when teachers or head teachers save a new lesson or assessment, including copies into another class. Grade 10 students completing the required first, second, and third grading records receive their strand recommendation, and admins are notified once per student when that recommendation is ready. Pending AI essay scores require teacher approval before they count toward readiness. Repeated recommendation refreshes preserve existing read/cleared alerts. Notifications appear in the admin inbox and use the existing mobile push queue for registered devices; no additional database migration is needed.

Every role has a **Settings** tab containing **Profile** and **Security**. Admins, secretaries, head teachers, teachers, and students can edit their own name and Gmail address while keeping their username read-only, plus preview and save a JPG, PNG, or WebP profile picture up to 5 MB. Changing your email signs you out so you can sign in again with your existing username. Security includes password changes for all roles. Only admins have a personal OTP On/Off switch; changing that preference requires the current password and takes effect on the next sign-in. OTP defaults to On for admins and remains required for every other role. Admin preferences affect only the signed-in administrator, use the existing `app_settings` table, and preserve existing choices without a SQL migration. Shared authenticated profile endpoints are `GET/PUT /api/auth/profile`; OTP preferences remain restricted to `GET/PUT /api/admin/settings/otp`. Accounts with a temporary password must change it before accessing Profile or OTP preferences.

Admins can view the required **School math CAPTCHA** policy in **Settings → Security**. Every initial login and password-recovery request requires backend verification; the CAPTCHA cannot be disabled. The **Verify code** step proceeds directly using the emailed OTP. `GET /api/auth/login-security` reports `captchaEnabled: true`; `GET /api/admin/settings/captcha` remains admin-only. The old settings URL is retained as a compatibility alias and cannot disable protection. Passwords, rate limits, lockouts, maintenance restrictions, and account-specific OTP rules remain enforced.

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
