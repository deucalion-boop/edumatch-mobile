# EduMatch mobile API contract

The mobile project consumes the existing Express APIs in the sibling `Edumatch/backend` project. `EXPO_PUBLIC_API_URL` includes the `/api` prefix. Axios supplies `Authorization: Bearer <JWT>` after login. The new endpoints are packaged in `backend-extension`; install that extension and its migration into the existing backend before using mobile login rehydration, QR attendance, or push registration.

Responses use `{ success: true, message, ...fields }`. Failures use HTTP 4xx/5xx with `{ success: false, message, details? }`. Array fields are named per endpoint, rather than nested under `data`. The client validates array responses and normalizes `id`/`_id` without changing server decisions. `ResourceItem.raw` retains the returned record for detail and mutation screens, excluding password hashes, invitation/reset metadata and token fields found in some legacy user management responses. Authentication tokens are stored separately through SecureStore.

Roles are `admin`, `secretary`, `headteacher`, `teacher`, and `student`. The Principal interface uses the server's `admin` role. The existing role middleware grants each role only its matching route namespace. A client route or disabled button is not a permission boundary. The JWT uses the existing issuer, audience, session ID, token version, expiration, and session revocation checks; mobile does not mint JWTs or connect to PostgreSQL with a privileged key.

## Authentication and account security

| Method and route | Request | Response fields / behavior |
| --- | --- | --- |
| `POST /auth/login` | `{ username, password, captchaToken, remember? }` | `202 { requiresOtp: true, challengeToken, deliveryHint, expiresAt, resendAvailableAt }`; password alone does not create a session. |
| `POST /auth/login/verify-otp` | `{ challengeToken, otpCode, captchaToken }` | `{ token, user, redirectPath? }`; OTP and a fresh CAPTCHA are checked by the backend. |
| `POST /auth/login/resend-otp` | `{ challengeToken }` | New challenge and timing fields; server enforces cooldown and attempt limits. |
| `GET /mobile/me` | Bearer token | `{ user }`; resolves current role and account status for SecureStore rehydration. |
| `POST /auth/change-password` | `{ currentPassword, newPassword, confirmNewPassword }` | Password update and session invalidation; sign in again afterward. |
| `POST /auth/logout` | `{}` | Revokes the current server session. Clear SecureStore even if the network is unavailable. |
| `POST /auth/presence` | `{}` | `{ lastActivityAt }`; this heartbeat does not extend an idle session. |
| `GET /auth/sessions` | — | `{ sessions: [{ id, current, ipAddress, userAgent, remember, createdAt, lastSeenAt, expiresAt }] }`. |
| `DELETE /auth/sessions/:id` | — | Revokes a session belonging to the authenticated account. |
| `POST /auth/forgot-password` | `{ email }` | Generic reset-email result. |

The server requires Google reCAPTCHA for both login stages and emails a six-digit OTP. Its public mobile CAPTCHA page exposes only the site key; the secret remains on the backend. `forcePasswordChange` routes the app to the password screen. Maintenance, suspended accounts, role restrictions, and inactivity errors are shown from the API. No alternate mobile password/CAPTCHA bypass is introduced.

The existing browser invitation and password reset routes remain compatible: `GET /auth/invite/:token`, `POST /auth/invite/:token/complete {password}`, `GET /auth/reset/:token`, and `POST /auth/reset/:token/complete {password}`.

## Admin / Principal and Secretary

| Role | Method and route | Request / response |
| --- | --- | --- |
| Admin, Secretary | `GET /:role/users` | `{ users }`; visibility is constrained by the backend user management policy. This endpoint is not paginated; mobile search/status/department filtering is local. |
| Admin, Secretary | `POST /:role/users` | `{ name, email, username?, role, contactNumber?, department?, subject?, gradeLevel?, sectionId?, advisorySectionId? }` → `{ user, invite? }`. Server validates role and assignments. New students start with an empty strand; legacy strand input is ignored. Department is required for teachers and head teachers and ignored for secretaries. |
| Admin, Secretary | `GET /:role/users/:id` | `{ user }`, with additional learning insights for a student. |
| Admin, Secretary | `PUT /:role/users/:id` | Editable user fields; optional multipart `profileImage` → `{ user }`. |
| Admin, Secretary | `POST /:role/users/:id/messages` | `{ subject, content, urgent? }` → `{ messageRecord, notification }`; recipient is a **user ID**, not a section ID. |
| Admin, Secretary | `GET /:role/sections` | `{ sections, advisorySection }`. |
| Admin | `GET /admin/analytics` | `{ analytics, academicAnalytics, aiAnalytics, recentActivities, ... }`; dashboard counters come from `analytics`. |
| Admin | `GET /admin/audit-logs` | Query `search, category, role, method, result, page` → `{ logs, summary, filters, pagination, categories }`, server page size 50. |
| Admin | `GET /admin/login-attempts` | Query `search, status, role, page` → `{ attempts, summary, filters, pagination }`, server page size 50. |
| Admin | `GET /admin/export-requests/archived-pdf` | Query `limit` → `{ requests, summary }`. |
| Admin | `PATCH /admin/export-requests/:id/review` | `{ decision: 'approved'|'rejected', note? }` → `{ request }`. |
| Admin | `GET /admin/student-account-requests` | Query `limit` → `{ requests }`. |
| Admin | `PATCH /admin/student-account-requests/:id/review` | `{ decision, note?, confirmation? }` → `{ request }`. Approved permanent deletion requires the exact student email in `confirmation`. |
| Secretary | `GET /secretary/directory` | `{ users }` containing teachers and head teachers. |
| Secretary | `GET /secretary/students` | `{ students, summary }`; each record includes section, adviser, progress and recommendation. |
| Secretary | `GET /secretary/students/archived` | Query `schoolYear?` → `{ students, summary: { totalArchived, schoolYears, schoolYear, currentSchoolYear } }`. |
| Secretary | `GET /secretary/students/archived/export-requests/current` | Query export filters → `{ request, exportContext }`. |
| Secretary | `POST /secretary/students/archived/export-requests` | `{ schoolYear?, department?, gradeLevel?, searchTerm? }` → `{ request, exportContext }`. Repeated requests reuse an existing pending/approved matching request. |
| Secretary | `POST /secretary/students/archived/export-requests/:id/consume` | `{}` → `{ request, exportContext }`; verifies the approved selection has not changed and marks the approval used. |
| Secretary | `POST /secretary/students/end-school-year` | `{ schoolYear }`; archives eligible inactive student accounts, with selection and changes performed server-side. |

Secretary cannot review Admin approval requests. Export approvals expire after 30 minutes and may be consumed once. Student account actions revoke affected sessions. The API client provides archival/export request methods; a PDF generated outside this project must consume the matching approval before export, as the existing web workflow does.

## Head Teacher

| Method and route | Request / response |
| --- | --- |
| `GET /headteacher/teachers` | Query `months?` → `{ department, teachers, summary }` with server academic/content activity counters. |
| `GET /headteacher/teachers/:id/students` | `{ teacher, students, summary }`; requires a managed teacher in the head teacher's department. |
| `POST /headteacher/teachers` | Teacher account fields and assignments → `{ user, invite? }`. |
| `POST /headteacher/students` | Student account fields including `teacherId` and assignments → `{ user, invite? }`. |
| `PUT /headteacher/teachers/:id` | `{ name?, email?, status?, subject?, contactNumber?, advisorySectionId? }` → `{ user }`. |
| `GET /headteacher/lessons` | `{ lessons }` from managed teachers. |
| `POST /headteacher/lessons` | Multipart fields including `teacherId, title, description, track/strand` and exactly one PDF `lessonPlanFile` → `{ lesson }`. |
| `GET /headteacher/assessments` | `{ assessments }`. |
| `POST /headteacher/assessments` | `{ teacherId, lessonId, title, subject?, examType, difficulty, numberOfItems, examDurationMinutes, submissionDeadline?, assessmentMode?, gradingPeriod?, ... }` → `{ assessment }`. |
| `PUT /headteacher/assessments/:id` | Assessment editing fields → `{ assessment }`. |
| `POST /headteacher/teachers/:id/announcements` | `{ subject, content, urgent? }` → `{ notification }`; recipient is the managed **teacher ID**. |

There is no existing Head Teacher approval route or unrestricted teacher/student grading route. Mobile uses managed teacher/student records for academic monitoring; grade changes remain with the responsible teacher.

## Teacher

| Method and route | Request / response |
| --- | --- |
| `GET /teacher/subjects` | `{ subjects }`; includes class code, approved/pending counts, lesson/assessment counts and deletion blockers. |
| `POST /teacher/subjects` | `{ className, subject, description? }` → `{ subject }`; server checks the teacher's subject/strand assignment. |
| `PATCH /teacher/subjects/:id` | `{ className }` → `{ subject }`. |
| `GET /teacher/students` | Query `subjectId?` → `{ students }`; approved students only, with server progress/recommendation fields. |
| `GET /teacher/subjects/:id/students` | `{ subject, students }`. |
| `POST /teacher/students` | Student fields → `{ user, invite }`. |
| `GET /teacher/enrollment-requests` | Query `subjectId?` → `{ requests }`. Each returned `id` is an **enrollment request ID**. |
| `PATCH /teacher/enrollment-requests/:id/accept` | `{}` → `{ student }`; despite the historical route parameter name `studentId`, pass the returned **request ID**. |
| `PATCH /teacher/enrollment-requests/:id/reject` | `{}` → `{ student }`; same request ID rule. |
| `GET /teacher/lessons` | `{ lessons }` with attachment and download URLs. |
| `POST /teacher/lessons` | Multipart lesson fields `subjectId, title, subject, description, track/strand` and exactly one PDF `lessonPlanFile` → `{ lesson }`. |
| `GET /teacher/assessments` | `{ assessments }` with grading policy, deadline, attachment, question and assignment fields. |
| `POST /teacher/assessments` | JSON/multipart `{ title, subjectId, subject, assessmentMode, ... }`; activities require `challengeDescription`, optionally `activityPoints, allowedSubmissionTypes, allowResubmission, allowLateSubmissions`. Quizzes/exams require `examType, difficulty, numberOfItems, examDurationMinutes`. Optional multipart `attachments` → `{ assessment, attachmentUpload? }`. |
| `GET /teacher/students/assessment-results` | Query `sort: highest|lowest|recent, studentId?, subjectId?, passFail: pass|fail` → `{ results }`. |
| `PATCH /teacher/assessments/:assessmentId/submissions/:submissionId/review` | `{ action:'grade', gradeValue, teacherFeedback? }` or `{ action:'return_for_revision', teacherFeedback }` → `{ submission }`. |
| `GET /teacher/subjects/:id/assessment-weights` | `{ weights: { activity, quiz, exam, minimumEvidenceCount } }`. |
| `PATCH /teacher/subjects/:id/assessment-weights` | Same weight fields; server requires nonnegative weights summing to 100 → `{ weights }`. |
| `POST /teacher/subjects/:id/announcements` | `{ title, content, requestId }` → `{ recipientCount }`; recipients are approved students of this class. |

For grading, `gradeValue` is a score in **points**, not a locally calculated percentage. The server requires `0 ≤ gradeValue ≤ activityPoints` for an activity and `0 ≤ gradeValue ≤ totalPoints` for quizzes/exams. It calculates scores, percentages, evidence, recommendations and notification events. Return for revision requires feedback and enabled resubmission. An announcement's `requestId` is a stable 16–80-character alphanumeric/hyphen ID reused on retry; identical requests do not create duplicate student notification events.

## Student

The neighboring backend now permits class listing and code enrollment for all authenticated student grades. Joining creates a pending enrollment request for the responsible teacher; approval is required for class membership. Lessons, assessments, submissions, and academic insights retain the Grade 10 requirement. Non-Grade-10 subject listing returns membership and teacher information without reading academic content or computing grades/recommendations. Profile, announcements, settings, account requests, and attendance remain available to other grades.

| Method and route | Request / response |
| --- | --- |
| `GET /student/subjects` | All student grades: `{ subjects, pendingSubjects, studentContext, insights }`. Mobile merges approved and pending classes for display. Grade 10 responses include server-calculated grades/evidence; other grades receive empty `insights` and no academic counts/performance. |
| `POST /student/subjects/join` | All student grades: `{ code }` → `{ request: { id, subject } }`, with pending enrollment. Blank, invalid/inactive codes and duplicate approved/pending enrollment are rejected server-side. |
| `GET /student/lessons` | `{ lessons }`; published lessons in approved subjects only, including `progress`. |
| `PATCH /student/lessons/:id/progress` | `{ progressPercent, engagementSeconds, reachedEnd? }` → `{ progress }`; server validates enrollment and assessment unlock requirements. |
| `GET /student/assessments` | `{ assessments }` including `isLocked, lockReason, prerequisite, submissionDeadline, allowedSubmissionTypes`. |
| `GET /student/assessments/:id` | Exam/assessment details after server access and prerequisite checks. |
| `POST /student/assessments/:id/start` | `{}` → server exam session and timer fields. |
| `PATCH /student/assessments/:id/progress` | `{ answers: [{ questionIndex, answer }] }` → session progress. |
| `POST /student/assessments/:id/submissions` | `{ answers: [{ questionIndex, answer }] }` → `{ submission, masteryProgress, recommendation }`; server grades and prevents retakes/duplicates. |
| `GET /student/submissions/me` | `{ submissions, summary }`; legacy submissions may use `_id` and a hydrated `assessmentId` object. |
| `GET /student/activity-submissions` | `{ submissions }`; activity records include feedback, grade and submission attachments. |
| `POST /student/assessments/:id/activity-response/draft` | JSON/multipart `{ responseText, links?, retainedAttachmentIds? }` and optional `attachments` → `{ submission }`. |
| `POST /student/assessments/:id/activity-response/submit` | Same fields → `{ submission }`; deadline, allowed types, graded work and resubmission rules run on the server. |
| `POST /student/assessments/:id/activity-response/unsubmit` | `{}` → `{ submission }`; graded/closed work cannot be unsubmitted. |
| `POST /student/account-requests` | `{ action: 'deactivate'|'delete', reason }` with at least 10 characters → `{ request }`; only one pending request per student. |
| `GET /student/account-requests/current` | `{ request }`. |

`GET/PUT /student/profile` and `GET/PUT /teacher/profile` retain their web contracts; profile images use multipart `profileImage`. Student notification settings use `GET/PUT /student/settings`.

## Announcements and notifications

| Method and route | Request / response |
| --- | --- |
| `GET /notifications` | Query `limit` (1–50) → `{ notifications, unreadCount }`; all authenticated roles, filtered by owner and student notification preferences. |
| `PATCH /notifications/:id/view` | `{}` → `{ notification, unreadCount }`; only the authenticated owner can mark it viewed. |
| `PATCH /notifications/view-all` | `{}` → `{ unreadCount }`. |
| `GET /notifications/announcements` | Student only; `{ announcements: [{ id, eventKey, title, content, subject, teacher, createdAt }] }`. |
| `GET /notifications/announcement` | Query `event` (announcement event key) → `{ announcement }`. |

Other role announcement screens use the authenticated notification feed. Existing APIs do not provide a teacher's sent announcement history or a school-wide section announcement endpoint. The mobile client does not fabricate either contract.

## Attendance and QR sessions

Manual attendance remains compatible with the web:

| Method and route | Request / response |
| --- | --- |
| `GET /teacher/attendance/roster` | Query `subjectId?, date, scope: handled_class|advisory_class` → `{ attendanceScope, subject, section, dateKey, attendance, students }`. `attendanceStatus` is blank until marked. |
| `POST /teacher/attendance` | `{ subjectId?, date, scope?, entries:[{studentId,status}] }` → `{ record, attendance, students, subject, ... }`; must contain all approved students exactly once. |
| `PATCH /teacher/attendance/:id/lock` | `{}` → `{ record }`; owner only, irreversible finalization. |
| `GET /teacher/attendance` | Query `subjectId?, scope?, from?, to?, limit?` → `{ records, summary }`. |
| `GET /student/attendance` | `{ records, summary }` containing the student's own status only. |
| `GET /secretary/attendance` | Query `from?,to?` → `{ summary, studentSummaries, recentRecords }`. |
| `GET /headteacher/attendance` | Managed teachers only → `{ summary, teacherSummaries, recentRecords }`. |
| `GET /admin/attendance/report` | Query `from?,to?` → `{ summary, teacherSummaries, subjectSummaries, recentRecords }`. |

`status` is one of `Present`, `Late`, `Absent`, or `Excused`, with matching capitalization.

The backend extension adds:

| Role | Method and route | Request / response |
| --- | --- | --- |
| Teacher | `POST /mobile/attendance/sessions` | `{ subjectId, dateKey, durationMinutes?:15, lateAfterMinutes?:5 }` → `{ session, qrPayload }`. |
| Teacher | `GET /mobile/attendance/sessions` | Query `subjectId?` → `{ sessions }`. |
| Teacher | `GET /mobile/attendance/sessions/:id` | `{ session, roster:[{studentId,studentName,status,scannedAt}] }`. |
| Teacher | `POST /mobile/attendance/sessions/:id/rotate` | `{}` → `{ session, qrPayload }`; old QR becomes invalid. |
| Teacher | `POST /mobile/attendance/sessions/:id/cancel` | `{}` → `{ session }`; cancels an open QR window without finalizing attendance. |
| Student | `POST /mobile/attendance/scan` | `{ qrPayload }` → `{ attendance:{sessionId,subjectId,dateKey,status,scannedAt}, duplicate }`. |
| Teacher | `POST /mobile/attendance/sessions/:id/finalize` | `{ overrides?:[{studentId,status}] }` → `{ session, record }`; fills unscanned roster members as absent and locks the resulting existing attendance record. |

`session` contains `id, subjectId, dateKey, status, expiresAt, lateAfter, attendanceRecordId, scanCount`. Status is `open`, `finalized`, or `cancelled`; an expired open window rejects scans but can still be finalized or cancelled. Students submit the opaque QR string; the app never interprets it as authority. The server validates the random secret's stored hash, expiry, rotation, role, class ownership, approved enrollment, student identity and finalization. Duplicate scans reuse the recorded result. QR and manual attendance share the same final attendance table, date/class uniqueness, and locked-record rules.

## Push device registration

| Method and route | Request / response |
| --- | --- |
| `POST /mobile/devices` | `{ installationId, expoPushToken, platform:'android'|'ios', projectId }` → `{ device:{installationId,platform,enabled} }`; owner and active session come from JWT authentication. |
| `DELETE /mobile/devices/:installationId` | Disables the installation belonging to the authenticated account and current session → `{ unregistered:true }`. |

The backend verifies the configured Expo project ID, registration ownership, installation/token uniqueness and session binding. Notification inserts enqueue durable delivery jobs for registered devices; the separate worker sends Expo tickets, checks receipts, retries transient errors and retires invalid device registrations. Lock-screen payloads contain generic school updates and notification IDs. Actual details are fetched under JWT authentication. Web previews and the HTTP fixture do not exercise native permission, APNs/FCM, or physical-device delivery.

## Files and storage

Lesson, assessment and submission responses contain attachment `url`/`downloadUrl` values. Existing `/storage/file?token=...` URLs are signed storage grants with expiry and file metadata. Mobile opens these exact URLs and refreshes the resource query to obtain a new grant after expiration. It does not construct Supabase paths, expose service-role keys, attach JWTs to third-party URLs, or change the existing storage provider.

Teacher/Student lesson endpoints `GET /:role/lessons/:id/download` and `GET /:role/lessons/:id/attachments/:attachmentId/download` additionally check ownership/enrollment and may redirect to storage. They require bearer authentication; use returned signed attachment URLs for the operating system's document viewer. Upload fields are `lessonPlanFile`, `attachments` (teacher assessment maximum 10; student submission maximum 5), and `profileImage`, matching the web middleware.

## Contract verification

This mapping was audited against the actual Express routes/controllers, Supabase services, and current Vue callers in `../Edumatch`. TypeScript API clients compile under strict checking. Backend extension tests verify the new security and attendance contracts using isolated fake persistence; they do not claim production Supabase or real-device delivery is configured. Consult the project verification guide for seeded staging/device workflows and the backend extension README for installation.
