import { api } from './client';
import { isGradeTenStudent } from '../auth/studentAccess';
import type {
  ActivityResponseInput, AdminOtpSettings, AiCreatorRole, AiUsageAnalytics, AiUsageDays, Approval, Assessment, AssessmentWeights, Attachment,
  AttendanceFilters, AttendanceOverview, AttendanceRecord, AttendanceRoster,
  AttendanceScanResult, AttendanceSession, AttendanceSessionDetail, AttendanceSessionQr,
  AttendanceStatus, AuthSession, CreateAttendanceSessionInput, CreateUserInput,
  Dashboard, DataRow, Lesson, ListFilters, LoginChallenge, LoginInput, LoginResult, LoginSecuritySettings,
  Notification, Paginated, PublishAnnouncementInput, ResourceItem, ReviewGradeInput,
  RecaptchaSettings, Role, SaveAttendanceInput, Section, Subject, User, VerifyOtpInput,
} from './types';

const roles = new Set<Role>(['admin', 'secretary', 'headteacher', 'teacher', 'student']);
const object = (value: unknown): DataRow => value && typeof value === 'object' && !Array.isArray(value)
  ? value as DataRow : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const id = (value: unknown): string => typeof value === 'string' ? value : string(object(value).id || object(value)._id);
const encoded = (value: string) => encodeURIComponent(value);
const rows = (data: DataRow, key: string): DataRow[] => {
  if (!Array.isArray(data[key])) throw new Error(`The server returned an invalid ${key} response.`);
  return (data[key] as unknown[]).map(object);
};
function envelope(value: unknown): DataRow {
  const data = object(value);
  if (data.success === false) throw new Error(string(data.message) || 'The request was rejected.');
  return data;
}
async function get(path: string, params?: object): Promise<DataRow> {
  return envelope((await api.get(path, { params })).data);
}
async function post(path: string, body: unknown = {}): Promise<DataRow> {
  return envelope((await api.post(path, body)).data);
}
async function patch(path: string, body: unknown = {}): Promise<DataRow> {
  return envelope((await api.patch(path, body)).data);
}
async function put(path: string, body: unknown): Promise<DataRow> {
  return envelope((await api.put(path, body)).data);
}

type ProfileUpdateInput = FormData | { name: string; email: string };
function profileUpdateBody(input: ProfileUpdateInput): ProfileUpdateInput {
  if (input instanceof FormData) return input;
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!name || !email) throw new Error('Enter your name and email.');
  return { name, email };
}
function normalizeOtpSettings(value: unknown): AdminOtpSettings {
  const settings = object(value);
  if (typeof settings.enabled !== 'boolean' || settings.scope !== 'account') throw new Error('The server returned invalid OTP settings.');
  return { enabled: settings.enabled, scope: 'account' };
}
function normalizeRecaptchaSettings(value: unknown): RecaptchaSettings {
  const settings = object(value);
  if (typeof settings.enabled !== 'boolean' || settings.scope !== 'school') throw new Error('The server returned invalid reCAPTCHA settings.');
  return { enabled: settings.enabled, scope: 'school' };
}
function otpUpdateBody(input: { enabled: boolean; currentPassword: string }) {
  if (typeof input.enabled !== 'boolean' || typeof input.currentPassword !== 'string' || !input.currentPassword) {
    throw new Error('Choose an OTP setting and enter your current password.');
  }
  return { enabled: input.enabled, currentPassword: input.currentPassword };
}

export function normalizeRole(value: unknown): Role {
  const role = string(value).toLowerCase().trim().replace(/[ _-]/g, '');
  const canonical = role === 'principal' ? 'admin' : role;
  if (!roles.has(canonical as Role)) throw new Error('The server returned an unsupported account role.');
  return canonical as Role;
}
function safeAccountRow(value: unknown): DataRow {
  const row = { ...object(value) };
  // Some legacy management responses include persisted authentication metadata.
  // Keep it out of account snapshots, query caches and mobile record details.
  for (const key of ['password', 'password_hash', 'passwordHash', 'invite', 'resetPassword', 'reset_password',
    'tokenVersion', 'token_version', 'token', 'refreshToken', 'refresh_token']) delete row[key];
  return row;
}
export function normalizeUser(value: unknown): User {
  const row = safeAccountRow(value);
  if (!id(row)) throw new Error('The server returned an invalid account.');
  return { ...row, id: id(row), name: string(row.name), email: string(row.email), role: normalizeRole(row.role) };
}
function normalizeLogin(value: unknown): LoginResult {
  const data = envelope(value);
  if (data.requiresOtp === true && string(data.challengeToken)) {
    return {
      requiresOtp: true, challengeToken: string(data.challengeToken), deliveryHint: string(data.deliveryHint),
      expiresAt: string(data.expiresAt) || null, resendAvailableAt: string(data.resendAvailableAt) || null,
    };
  }
  if (!string(data.token)) throw new Error('The server did not return an authentication token.');
  return { token: string(data.token), user: normalizeUser(data.user), redirectPath: string(data.redirectPath) || undefined };
}
function subject(row: DataRow): Subject {
  return { ...row, id: id(row), name: string(row.name), className: string(row.className), code: string(row.code) };
}
function attachment(row: DataRow): Attachment {
  return { ...row, id: id(row), fileName: string(row.fileName || row.originalName), url: string(row.url || row.downloadUrl) };
}
function lesson(row: DataRow): Lesson {
  return { ...row, id: id(row), title: string(row.title), description: string(row.description),
    subject: string(row.subject), subjectId: id(row.subjectId),
    attachments: Array.isArray(row.attachments) ? row.attachments.map(object).map(attachment) : [] };
}
function assessment(row: DataRow): Assessment {
  return { ...row, id: id(row), title: string(row.title), subject: string(row.subject), subjectId: id(row.subjectId),
    assessmentMode: string(row.assessmentMode) || 'activity',
    attachments: Array.isArray(row.attachments) ? row.attachments.map(object).map(attachment) : [] };
}
function notification(row: DataRow): Notification {
  return { ...row, id: id(row), type: string(row.type), title: string(row.title),
    message: string(row.message), isViewed: row.isViewed === true };
}
function attendanceRecord(row: DataRow): AttendanceRecord {
  return { ...row, id: id(row), dateKey: string(row.dateKey), isLocked: row.isLocked === true };
}
function userItem(row: DataRow): ResourceItem {
  row = safeAccountRow(row);
  const progress = object(row.progress);
  const recommendation = object(row.recommendation);
  const section = object(row.section);
  const parts = [row.email, row.department || row.subject, row.gradeLevel && `Grade ${string(row.gradeLevel)}`,
    row.sectionName || section.name].map(string).filter(Boolean);
  return { id: id(row), title: string(row.name) || 'Account', subtitle: parts.join(' · '),
    status: string(row.status), description: string(recommendation.recommendationExplanation)
      || (progress.averageScore !== undefined || row.averageScore !== undefined
        ? `Average score: ${number(progress.averageScore ?? row.averageScore)}` : ''), raw: row };
}
function notificationItem(row: DataRow): ResourceItem {
  return { id: id(row), title: string(row.title || row.subject) || 'Announcement',
    subtitle: [row.teacher || row.senderName, row.subject].map(string).filter(Boolean).join(' · '),
    description: string(row.content || row.message || row.preview),
    status: row.isViewed === false ? 'Unread' : undefined, createdAt: string(row.createdAt), raw: row };
}
function gradeItem(row: DataRow): ResourceItem {
  const assessmentRow = object(row.assessment || row.assessmentId);
  return { id: id(row), title: string(row.assessmentTitle || row.title || assessmentRow.title) || 'Assessment result',
    subtitle: [row.studentName, row.subjectName || row.subject || assessmentRow.subject,
      row.totalPoints !== undefined ? `${number(row.score)} / ${number(row.totalPoints)}` : ''].map(string).filter(Boolean).join(' · '),
    status: string(row.scoringStatus || row.status), description: string(row.teacherFeedback),
    raw: { ...row, assessmentId: id(row.assessmentId), assessmentTitle: row.assessmentTitle || assessmentRow.title,
      subjectName: row.subjectName || row.subject || assessmentRow.subject } };
}
function approvalItem(row: DataRow, kind: Approval['kind']): Approval {
  const requester = object(row.requester);
  return { id: id(row), kind, title: kind === 'export' ? 'Archived records export'
    : kind === 'account' ? `${string(row.studentName) || 'Student'}: ${string(row.action) || 'account request'}`
    : `${string(row.name) || 'Student'}: class enrollment`,
    subtitle: kind === 'export' ? `${string(requester.name)} · ${number(row.studentCount)} student records`
      : [row.email || row.studentEmail, row.subjectName, row.className].map(string).filter(Boolean).join(' · '),
    description: string(row.reason), status: string(kind === 'enrollment' ? row.enrollmentStatus : row.status),
    action: string(row.action), studentEmail: string(row.studentEmail), raw: row };
}
function ensureRole(role: Role, allowed: Role[]): void {
  if (!allowed.includes(role)) throw new Error('This action is unavailable for your role.');
}

function aiCreatorRole(value: unknown): AiCreatorRole {
  const role = normalizeRole(value);
  if (role !== 'teacher' && role !== 'headteacher') throw new Error('The server returned an invalid AI creator role.');
  return role;
}

function optionalAiCount(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function aiCount(value: unknown): number {
  const count = optionalAiCount(value);
  if (count === undefined) throw new Error('The server returned an invalid AI usage count.');
  return count;
}

function aiUsageAnalytics(value: unknown): AiUsageAnalytics {
  const data = object(value);
  const summary = object(data.summary);
  const period = object(data.period);
  const pagination = object(data.pagination);
  if (!Object.keys(summary).length || !Object.keys(pagination).length || ![7, 30, 90].includes(number(period.days))) {
    throw new Error('The server returned an invalid AI usage response.');
  }
  const counts = (row: DataRow) => ({ requests: aiCount(row.requests), successfulDrafts: aiCount(row.successfulDrafts), failedRequests: aiCount(row.failedRequests) });
  return {
    period: { days: number(period.days) as AiUsageDays, start: string(period.start), end: string(period.end) },
    summary: { ...counts(summary), activeCreators: aiCount(summary.activeCreators), localFallbacks: aiCount(summary.localFallbacks) },
    trend: rows(data, 'trend').map(row => ({ date: string(row.date), ...counts(row) })),
    creators: rows(data, 'creators').map(row => ({ id: id(row), name: string(row.name), role: aiCreatorRole(row.role),
      department: string(row.department) || undefined, ...counts(row) })),
    recent: rows(data, 'recent').map(row => ({ id: id(row), creatorId: string(row.creatorId), creatorName: string(row.creatorName),
      creatorRole: aiCreatorRole(row.creatorRole), createdAt: string(row.createdAt), succeeded: row.succeeded === true, durationMs: number(row.durationMs),
      provider: string(row.provider) || undefined, model: string(row.model) || undefined, subject: string(row.subject) || undefined,
      generationMode: string(row.generationMode) || undefined,
      requestedQuestions: optionalAiCount(row.requestedQuestions),
      generatedQuestions: optionalAiCount(row.generatedQuestions),
      providerRequests: optionalAiCount(row.providerRequests) })),
    pagination: { page: aiCount(pagination.page), pageSize: aiCount(pagination.pageSize), totalPages: aiCount(pagination.totalPages), totalRecords: aiCount(pagination.totalRecords) },
  };
}
function filterItems<T extends { raw?: DataRow; name?: string; role?: Role; status?: string }>(items: T[], filters?: ListFilters): T[] {
  if (!filters) return items;
  const search = (filters.search || '').trim().toLowerCase();
  return items.filter(item => {
    const row = item.raw || item as DataRow;
    return (!search || JSON.stringify(row).toLowerCase().includes(search))
      && (!filters.role || row.role === filters.role)
      && (!filters.status || row.status === filters.status)
      && (!filters.department || row.department === filters.department)
      && (!filters.gradeLevel || row.gradeLevel === filters.gradeLevel);
  });
}

export const authApi = {
  async loginSecuritySettings(): Promise<LoginSecuritySettings> {
    const data = await get('/auth/login-security');
    const settings = object(data.settings);
    if (typeof settings.recaptchaEnabled !== 'boolean') throw new Error('The server returned invalid sign-in security settings.');
    return { recaptchaEnabled: settings.recaptchaEnabled };
  },
  async login(input: LoginInput): Promise<LoginResult> {
    return normalizeLogin((await api.post('/auth/login', input)).data);
  },
  async verifyOtp(input: VerifyOtpInput): Promise<AuthSession> {
    const result = normalizeLogin((await api.post('/auth/login/verify-otp', { challengeToken: input.challengeToken, otpCode: input.otpCode })).data);
    if ('challengeToken' in result) throw new Error('Login verification did not complete.');
    return result;
  },
  async resendOtp(challengeToken: string): Promise<LoginChallenge> {
    const result = normalizeLogin(await post('/auth/login/resend-otp', { challengeToken }));
    if (!('challengeToken' in result)) throw new Error('The server did not return a verification challenge.');
    return result;
  },
  async me(): Promise<User> { return normalizeUser((await get('/mobile/me')).user); },
  async profile(): Promise<User> { return normalizeUser((await get('/auth/profile')).user); },
  async updateProfile(input: ProfileUpdateInput): Promise<User> {
    return normalizeUser((await put('/auth/profile', profileUpdateBody(input))).user);
  },
  async logout(): Promise<void> { await post('/auth/logout'); },
  async presence(): Promise<void> { await post('/auth/presence'); },
  async changePassword(input: { currentPassword: string; newPassword: string; confirmNewPassword: string }): Promise<void> {
    await post('/auth/change-password', input);
  },
  async sessions(): Promise<DataRow[]> { return rows(await get('/auth/sessions'), 'sessions'); },
  async revokeSession(sessionId: string): Promise<void> { await api.delete(`/auth/sessions/${encoded(sessionId)}`); },
  async forgotPassword(email: string): Promise<void> { await post('/auth/forgot-password', { email }); },
};

export const notificationApi = {
  async list(limit = 50): Promise<{ notifications: Notification[]; unreadCount: number }> {
    const data = await get('/notifications', { limit });
    return { notifications: rows(data, 'notifications').map(notification), unreadCount: number(data.unreadCount) };
  },
  async markViewed(notificationId: string): Promise<void> { await patch(`/notifications/${encoded(notificationId)}/view`); },
  async markAllViewed(): Promise<void> { await patch('/notifications/view-all'); },
};

export const edumatchApi = {
  async adminProfile(): Promise<User> {
    const user = normalizeUser((await get('/admin/profile')).user);
    if (user.role !== 'admin') throw new Error('The server returned an invalid admin profile.');
    return user;
  },
  async updateAdminProfile(input: ProfileUpdateInput): Promise<User> {
    const user = normalizeUser((await put('/admin/profile', profileUpdateBody(input))).user);
    if (user.role !== 'admin') throw new Error('The server returned an invalid admin profile.');
    return user;
  },
  async adminOtpSettings(): Promise<AdminOtpSettings> {
    return normalizeOtpSettings((await get('/admin/settings/otp')).settings);
  },
  async updateAdminOtpSettings(input: { enabled: boolean; currentPassword: string }): Promise<AdminOtpSettings> {
    return normalizeOtpSettings((await put('/admin/settings/otp', otpUpdateBody(input))).settings);
  },
  async recaptchaSettings(): Promise<RecaptchaSettings> {
    return normalizeRecaptchaSettings((await get('/admin/settings/recaptcha')).settings);
  },
  async updateRecaptchaSettings(input: { enabled: boolean; currentPassword: string }): Promise<RecaptchaSettings> {
    if (typeof input.enabled !== 'boolean' || typeof input.currentPassword !== 'string' || !input.currentPassword) {
      throw new Error('Choose a reCAPTCHA setting and enter your current password.');
    }
    return normalizeRecaptchaSettings((await put('/admin/settings/recaptcha', { enabled: input.enabled, currentPassword: input.currentPassword })).settings);
  },
  async users(role: Role, filters?: ListFilters): Promise<User[]> {
    let data: DataRow;
    let key: string;
    if (role === 'admin' || role === 'secretary') { data = await get(`/${role}/users`); key = 'users'; }
    else if (role === 'headteacher') { data = await get('/headteacher/teachers'); key = 'teachers'; }
    else if (role === 'teacher') { data = await get('/teacher/students', { subjectId: filters?.subjectId }); key = 'students'; }
    else { data = await get('/student/teachers'); key = 'teachers'; }
    // Legacy teacher student rows omit role; the endpoint itself determines it.
    const mapped = rows(data, key).map(row => normalizeUser({ ...row, role: row.role || (key === 'students' ? 'student' : 'teacher') }));
    return filterItems(mapped, filters);
  },
  async createUser(role: Role, input: CreateUserInput): Promise<User> {
    ensureRole(role, ['admin', 'secretary', 'headteacher', 'teacher']);
    const username = input.username?.trim();
    if (!username) throw new Error('Username is required.');
    const path = role === 'admin' || role === 'secretary' ? `/${role}/users`
      : role === 'headteacher' && input.role === 'teacher' ? '/headteacher/teachers' : `/${role}/students`;
    return normalizeUser((await post(path, { ...input, username })).user);
  },
  async updateUser(role: 'admin' | 'secretary' | 'headteacher', userId: string, input: Partial<CreateUserInput>): Promise<User> {
    const path = role === 'headteacher' ? `/headteacher/teachers/${encoded(userId)}` : `/${role}/users/${encoded(userId)}`;
    return normalizeUser((await put(path, input)).user);
  },
  async userDetail(role: 'admin' | 'secretary', userId: string): Promise<User> {
    return normalizeUser((await get(`/${role}/users/${encoded(userId)}`)).user);
  },
  async sections(role: Role): Promise<Section[]> {
    ensureRole(role, ['admin', 'secretary', 'headteacher', 'teacher']);
    return rows(await get(`/${role}/sections`), 'sections').map(row => ({ ...row, id: id(row), name: string(row.name) }));
  },
  async subjects(role: Role): Promise<Subject[]> {
    ensureRole(role, ['teacher', 'student']);
    const data = await get(`/${role}/subjects`);
    const pending = role === 'student' && data.pendingSubjects !== undefined ? rows(data, 'pendingSubjects') : [];
    return [...rows(data, 'subjects'), ...pending].map(subject);
  },
  async createSubject(input: { className: string; subject: string; description?: string }): Promise<Subject> {
    return subject(object((await post('/teacher/subjects', input)).subject));
  },
  async joinSubject(code: string): Promise<DataRow> { return post('/student/subjects/join', { code }); },
  async lessons(role: Role): Promise<Lesson[]> {
    ensureRole(role, ['teacher', 'headteacher', 'student']);
    return rows(await get(`/${role}/lessons`), 'lessons').map(lesson);
  },
  async createLesson(role: 'teacher' | 'headteacher', input: FormData): Promise<Lesson> {
    return lesson(object((await post(`/${role}/lessons`, input)).lesson));
  },
  async assessments(role: Role): Promise<Assessment[]> {
    ensureRole(role, ['teacher', 'headteacher', 'student']);
    return rows(await get(`/${role}/assessments`), 'assessments').map(assessment);
  },
  async createAssessment(role: 'teacher' | 'headteacher', input: DataRow | FormData): Promise<DataRow> {
    return object((await post(`/${role}/assessments`, input)).assessment);
  },
  async lessonProgress(lessonId: string, progress: { progressPercent: number; engagementSeconds: number; reachedEnd?: boolean }): Promise<DataRow> {
    return object((await patch(`/student/lessons/${encoded(lessonId)}/progress`, progress)).progress);
  },
  async records(role: Role, filters?: ListFilters): Promise<ResourceItem[]> {
    if (role === 'secretary') {
      const path = filters?.archived ? '/secretary/students/archived' : '/secretary/students';
      return filterItems(rows(await get(path, { schoolYear: filters?.schoolYear }), 'students').map(userItem), filters);
    }
    if (role === 'student') return this.grades(role, filters);
    if (role === 'headteacher' && filters?.teacherId) {
      return rows(await get(`/headteacher/teachers/${encoded(filters.teacherId)}/students`), 'students').map(userItem);
    }
    const users = await this.users(role, filters);
    return users.map(row => userItem(row));
  },
  async approvals(role: Role): Promise<Approval[]> {
    if (role === 'admin') {
      const [exports, accounts] = await Promise.all([
        get('/admin/export-requests/archived-pdf', { limit: 50 }), get('/admin/student-account-requests', { limit: 50 }),
      ]);
      return [...rows(exports, 'requests').map(row => approvalItem(row, 'export')),
        ...rows(accounts, 'requests').map(row => approvalItem(row, 'account'))];
    }
    if (role === 'teacher') return rows(await get('/teacher/enrollment-requests'), 'requests').map(row => approvalItem(row, 'enrollment'));
    if (role === 'secretary') {
      const data = await get('/secretary/students/archived/export-requests/current');
      return data.request ? [approvalItem(object(data.request), 'export')] : [];
    }
    if (role === 'student') {
      const data = await get('/student/account-requests/current');
      return data.request ? [approvalItem(object(data.request), 'account')] : [];
    }
    return [];
  },
  async reviewApproval(role: Role, request: Approval, decision: 'approved' | 'rejected', note = '', confirmation = ''): Promise<void> {
    if (role === 'teacher' && request.kind === 'enrollment') {
      await patch(`/teacher/enrollment-requests/${encoded(request.id)}/${decision === 'approved' ? 'accept' : 'reject'}`);
      return;
    }
    ensureRole(role, ['admin']);
    if (request.kind === 'export') await patch(`/admin/export-requests/${encoded(request.id)}/review`, { decision, note });
    else if (request.kind === 'account') await patch(`/admin/student-account-requests/${encoded(request.id)}/review`, { decision, note, confirmation });
    else throw new Error('This approval is unavailable for your role.');
  },
  async requestAccountAction(input: { action: 'deactivate' | 'delete'; reason: string }): Promise<DataRow> {
    return object((await post('/student/account-requests', input)).request);
  },
  async requestArchivedExport(filters: { schoolYear?: string; department?: string; gradeLevel?: string; searchTerm?: string }): Promise<DataRow> {
    return object((await post('/secretary/students/archived/export-requests', filters)).request);
  },
  async archiveSchoolYear(schoolYear: string): Promise<DataRow> {
    return post('/secretary/students/end-school-year', { schoolYear });
  },
  async academic(role: Role): Promise<ResourceItem[]> {
    if (role === 'student') {
      const data = await get('/student/subjects');
      const insights = object(data.insights);
      const performance = Array.isArray(insights.subjectPerformance) ? rows(insights, 'subjectPerformance') : [];
      return performance.map(row => ({ id: id(row.subjectId), title: string(row.subjectName || row.name) || 'Subject progress',
        subtitle: row.finalPercentage === null || row.finalPercentage === undefined ? 'Awaiting sufficient graded evidence'
          : `Final percentage: ${number(row.finalPercentage)}%`, status: string(row.performanceLevel || row.recommendationStatus || row.status),
        description: string(row.explanation || row.recommendationExplanation), raw: row }));
    }
    if (role === 'teacher' || role === 'secretary') return this.records(role);
    if (role === 'headteacher') {
      const teachers = await this.users(role);
      const results = await Promise.all(teachers.map(async teacher => rows(
        await get(`/headteacher/teachers/${encoded(teacher.id)}/students`), 'students').map(row => userItem(row))));
      return [...new Map(results.flat().map(row => [row.id, row])).values()];
    }
    return this.records('admin', { role: 'student' });
  },
  async announcements(role: Role): Promise<ResourceItem[]> {
    if (role === 'student') return rows(await get('/notifications/announcements'), 'announcements').map(notificationItem);
    const { notifications } = await notificationApi.list();
    return notifications.map(row => notificationItem(row));
  },
  async publishAnnouncement(role: Role, targetId: string, input: PublishAnnouncementInput): Promise<void> {
    if (role === 'teacher') {
      if (!input.requestId) throw new Error('An announcement request ID is required so retries cannot create duplicate posts.');
      await post(`/teacher/subjects/${encoded(targetId)}/announcements`, { title: input.title, content: input.content, requestId: input.requestId });
    } else if (role === 'headteacher') {
      await post(`/headteacher/teachers/${encoded(targetId)}/announcements`, { subject: input.title, content: input.content, urgent: input.urgent === true });
    } else {
      ensureRole(role, ['admin', 'secretary']);
      await post(`/${role}/users/${encoded(targetId)}/messages`, { subject: input.title, content: input.content, urgent: input.urgent === true });
    }
  },
  async grades(role: Role, filters?: ListFilters): Promise<ResourceItem[]> {
    if (role === 'teacher') return rows(await get('/teacher/students/assessment-results', filters), 'results').map(gradeItem);
    if (role === 'student') {
      const [exams, activities] = await Promise.all([get('/student/submissions/me'), get('/student/activity-submissions')]);
      const combined = [...rows(exams, 'submissions'), ...rows(activities, 'submissions')];
      return [...new Map(combined.map(row => [id(row), row])).values()].map(gradeItem);
    }
    return this.academic(role);
  },
  async reviewGrade(input: ReviewGradeInput): Promise<DataRow> {
    const { assessmentId, submissionId, ...body } = input;
    return object((await patch(`/teacher/assessments/${encoded(assessmentId)}/submissions/${encoded(submissionId)}/review`, body)).submission);
  },
  async assessmentWeights(subjectId: string): Promise<AssessmentWeights> {
    return object((await get(`/teacher/subjects/${encoded(subjectId)}/assessment-weights`)).weights) as unknown as AssessmentWeights;
  },
  async saveAssessmentWeights(subjectId: string, weights: AssessmentWeights): Promise<AssessmentWeights> {
    return object((await patch(`/teacher/subjects/${encoded(subjectId)}/assessment-weights`, weights)).weights) as unknown as AssessmentWeights;
  },
  async saveActivityResponse(assessmentId: string, input: ActivityResponseInput | FormData, submit = false): Promise<DataRow> {
    return object((await post(`/student/assessments/${encoded(assessmentId)}/activity-response/${submit ? 'submit' : 'draft'}`, input)).submission);
  },
  async activityResponse(assessmentId: string): Promise<DataRow | null> {
    return rows(await get('/student/activity-submissions'), 'submissions')
      .find(row => id(row.assessmentId) === assessmentId) || null;
  },
  async unsubmitActivity(assessmentId: string): Promise<DataRow> {
    return object((await post(`/student/assessments/${encoded(assessmentId)}/activity-response/unsubmit`)).submission);
  },
  async exam(assessmentId: string): Promise<DataRow> { return get(`/student/assessments/${encoded(assessmentId)}`); },
  async startExam(assessmentId: string): Promise<DataRow> { return post(`/student/assessments/${encoded(assessmentId)}/start`); },
  async saveExamProgress(assessmentId: string, answers: DataRow[]): Promise<DataRow> {
    return patch(`/student/assessments/${encoded(assessmentId)}/progress`, { answers });
  },
  async submitExam(assessmentId: string, answers: DataRow[]): Promise<DataRow> {
    return post(`/student/assessments/${encoded(assessmentId)}/submissions`, { answers });
  },
  async attendance(role: Role, filters?: AttendanceFilters): Promise<AttendanceOverview> {
    const path = role === 'admin' ? '/admin/attendance/report' : `/${role}/attendance`;
    const data = await get(path, filters);
    const key = Array.isArray(data.records) ? 'records' : 'recentRecords';
    return { summary: object(data.summary), records: rows(data, key).map(attendanceRecord),
      students: Array.isArray(data.studentSummaries) ? rows(data, 'studentSummaries') : undefined,
      teachers: Array.isArray(data.teacherSummaries) ? rows(data, 'teacherSummaries') : undefined };
  },
  async attendanceRoster(params: AttendanceFilters): Promise<AttendanceRoster> {
    const data = await get('/teacher/attendance/roster', params);
    return { attendanceScope: data.attendanceScope === 'advisory_class' ? 'advisory_class' : 'handled_class',
      subject: subject(object(data.subject)), section: { ...object(data.section), id: id(data.section), name: string(object(data.section).name) },
      dateKey: string(data.dateKey) || params.date || '', attendance: data.attendance ? attendanceRecord(object(data.attendance)) : null,
      students: rows(data, 'students').map(row => ({ ...row, id: id(row), name: string(row.name), attendanceStatus: string(row.attendanceStatus) as AttendanceStatus | '' })) };
  },
  async saveAttendance(input: SaveAttendanceInput): Promise<AttendanceRecord> {
    return attendanceRecord(object((await post('/teacher/attendance', input)).record));
  },
  async lockAttendance(recordId: string): Promise<AttendanceRecord> {
    return attendanceRecord(object((await patch(`/teacher/attendance/${encoded(recordId)}/lock`)).record));
  },
  async aiUsage(role: Role, options: { days?: AiUsageDays; page?: number; pageSize?: number } = {}): Promise<AiUsageAnalytics> {
    ensureRole(role, ['admin']);
    const data = await get('/admin/ai-usage', { days: options.days ?? 30, page: options.page ?? 1, pageSize: options.pageSize ?? 5 });
    return aiUsageAnalytics(data.aiUsage);
  },
  async dashboard(role: Role, user?: User): Promise<Dashboard> {
    if (role === 'admin') {
      const data = await get('/admin/analytics');
      const analytics = object(data.analytics);
      return { metrics: [{ label: 'Students', value: number(analytics.totalStudents) }, { label: 'Teachers', value: number(analytics.totalTeachers) },
        { label: 'Subjects', value: number(analytics.totalSubjects) }, { label: 'Assessments', value: number(analytics.totalAssessments) }],
        activity: Array.isArray(data.recentActivities) ? rows(data, 'recentActivities').map(row => ({ id: id(row),
          title: string(row.message || row.title) || 'School activity', subtitle: string(row.type),
          description: string(row.description), createdAt: string(row.occurredAt || row.createdAt), raw: row })) : [] };
    }
    if (role === 'secretary') {
      const [data, attendance] = await Promise.all([get('/secretary/students'), this.attendance(role)]);
      const students = rows(data, 'students');
      return { metrics: [{ label: 'Students', value: students.length }, { label: 'Attendance records', value: number(attendance.summary.totalRecords) },
        { label: 'Present', value: number(attendance.summary.presentCount) }, { label: 'Absent', value: number(attendance.summary.absentCount) }],
        activity: students.map(userItem) };
    }
    if (role === 'headteacher') {
      const data = await get('/headteacher/teachers'); const summary = object(data.summary);
      return { metrics: [{ label: 'Teachers', value: number(summary.totalTeachers) }, { label: 'Students', value: number(summary.totalStudents) },
        { label: 'Lessons', value: number(summary.totalLessons) }, { label: 'Assessments', value: number(summary.totalAssessments) }],
        activity: rows(data, 'teachers').map(userItem) };
    }
    if (role === 'teacher') {
      const [subjects, students, requests] = await Promise.all([this.subjects(role), this.users(role), this.approvals(role)]);
      return { metrics: [{ label: 'Classes', value: subjects.length }, { label: 'Students', value: students.length },
        { label: 'Enrollment requests', value: requests.length }, { label: 'Lessons', value: subjects.reduce((sum, row) => sum + number(row.lessonCount), 0) }],
        activity: requests };
    }
    const attendance = await this.attendance(role);
    const subjects = user && !isGradeTenStudent(user) ? [] : await this.subjects(role);
    return { metrics: [{ label: 'Classes', value: subjects.filter(item => item.enrollmentStatus !== 'pending').length }, { label: 'Attendance records', value: number(attendance.summary.totalRecords) },
      { label: 'Present', value: number(attendance.summary.presentCount) }, { label: 'Late', value: number(attendance.summary.lateCount) }],
      activity: attendance.records.map(row => ({ id: row.id, title: row.title || string(row.subject?.name) || 'Attendance',
        subtitle: row.dateKey, status: row.status, raw: row })) };
  },
  async auditLogs(filters?: ListFilters & { category?: string; method?: string; result?: string }): Promise<Paginated<DataRow>> {
    const data = await get('/admin/audit-logs', filters);
    return { items: rows(data, 'logs'), pagination: object(data.pagination), summary: object(data.summary) };
  },
  async loginAttempts(filters?: ListFilters): Promise<Paginated<DataRow>> {
    const data = await get('/admin/login-attempts', filters);
    return { items: rows(data, 'attempts'), pagination: object(data.pagination), summary: object(data.summary) };
  },
};

/** These mutations only request decisions; validation, deduplication and locking run on the server. */
export const attendanceSessions = {
  async create(input: CreateAttendanceSessionInput): Promise<AttendanceSessionQr> {
    return await post('/mobile/attendance/sessions', input) as unknown as AttendanceSessionQr;
  },
  async list(subjectId?: string): Promise<AttendanceSession[]> {
    return rows(await get('/mobile/attendance/sessions', { subjectId }), 'sessions') as unknown as AttendanceSession[];
  },
  async read(sessionId: string): Promise<AttendanceSessionDetail> {
    return await get(`/mobile/attendance/sessions/${encoded(sessionId)}`) as unknown as AttendanceSessionDetail;
  },
  async rotate(sessionId: string): Promise<AttendanceSessionQr> {
    return await post(`/mobile/attendance/sessions/${encoded(sessionId)}/rotate`) as unknown as AttendanceSessionQr;
  },
  async cancel(sessionId: string): Promise<{ session: AttendanceSession }> {
    return await post(`/mobile/attendance/sessions/${encoded(sessionId)}/cancel`) as unknown as { session: AttendanceSession };
  },
  async scan(qrPayload: string): Promise<AttendanceScanResult> {
    return await post('/mobile/attendance/scan', { qrPayload }) as unknown as AttendanceScanResult;
  },
  async finalize(sessionId: string, overrides?: { studentId: string; status: AttendanceStatus }[]): Promise<{ session: AttendanceSession; record: AttendanceRecord }> {
    return await post(`/mobile/attendance/sessions/${encoded(sessionId)}/finalize`, { overrides }) as unknown as { session: AttendanceSession; record: AttendanceRecord };
  },
};
