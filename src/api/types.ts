/** Canonical server roles. Principal accounts use the admin role. */
export type Role = 'admin' | 'secretary' | 'headteacher' | 'teacher' | 'student';
export type DataRow = Record<string, unknown>;
export interface AdminOtpSettings { enabled: boolean; scope: 'school' }
export interface CaptchaSettings { enabled: true; scope: 'school' }
export interface LoginSecuritySettings { captchaEnabled: true }
export type CaptchaAction = 'login' | 'forgot-password';
export interface CaptchaChallenge { challengeId: string; question: string; expiresAt: string }
export interface CaptchaVerification { verificationToken: string; expiresAt: string }
export type AttendanceStatus = 'Present' | 'Late' | 'Absent' | 'Excused';
export type AttendanceScope = 'handled_class' | 'advisory_class';

export interface User extends DataRow {
  id: string;
  name: string;
  email: string;
  username?: string;
  role: Role;
  status?: string;
  department?: string;
  subject?: string;
  strand?: string;
  gradeLevel?: string;
  sectionId?: string;
  sectionName?: string;
  contactNumber?: string;
  profileImage?: string;
  forcePasswordChange?: boolean;
  advisorySectionId?: string;
}

export interface LoginChallenge {
  requiresOtp: true;
  challengeToken: string;
  deliveryHint: string;
  expiresAt: string | null;
  resendAvailableAt: string | null;
}

export interface AuthSession {
  requiresOtp?: false;
  token: string;
  user: User;
  redirectPath?: string;
}

export type LoginResult = LoginChallenge | AuthSession;
export interface LoginInput {
  username: string;
  password: string;
  captchaToken: string;
  remember?: boolean;
}
export interface VerifyOtpInput {
  challengeToken: string;
  otpCode: string;
}

export interface ListFilters {
  search?: string;
  role?: Role;
  status?: string;
  page?: number;
  limit?: number;
  subjectId?: string;
  studentId?: string;
  teacherId?: string;
  schoolYear?: string;
  department?: string;
  gradeLevel?: string;
  archived?: boolean;
  sort?: 'highest' | 'lowest' | 'recent';
  passFail?: 'pass' | 'fail';
}

/** Pagination is supplied only by endpoints that support it (audit and login logs). */
export interface Paginated<T> {
  items: T[];
  pagination: DataRow;
  summary?: DataRow;
}

/** Presentation wrapper; raw retains the full server response for detail workflows. */
export interface ResourceItem {
  id: string;
  title: string;
  subtitle: string;
  description?: string;
  status?: string;
  createdAt?: string;
  raw: DataRow;
}

export interface Metric {
  label: string;
  value: number | string;
}
export interface Dashboard {
  metrics: Metric[];
  activity: ResourceItem[];
}

export type AiUsageDays = 7 | 30 | 90;
export type AiCreatorRole = 'teacher' | 'headteacher';
export interface AiUsageCounts {
  requests: number;
  successfulDrafts: number;
  failedRequests: number;
}
export interface AiUsageTrend extends AiUsageCounts { date: string }
export interface AiUsageCreator extends AiUsageCounts {
  id: string;
  name: string;
  role: AiCreatorRole;
  department?: string;
}
export interface AiUsageGeneration {
  id: string;
  creatorId: string;
  creatorName: string;
  creatorRole: AiCreatorRole;
  createdAt: string;
  succeeded: boolean;
  durationMs: number;
  provider?: string;
  model?: string;
  subject?: string;
  generationMode?: string;
  requestedQuestions?: number;
  generatedQuestions?: number;
  providerRequests?: number;
}
export interface AiUsageAnalytics {
  period: { days: AiUsageDays; start: string; end: string };
  summary: AiUsageCounts & { activeCreators: number; localFallbacks: number };
  trend: AiUsageTrend[];
  creators: AiUsageCreator[];
  recent: AiUsageGeneration[];
  pagination: { page: number; pageSize: number; totalPages: number; totalRecords: number };
}

export interface Approval extends ResourceItem {
  kind: 'export' | 'account' | 'enrollment';
  action?: string;
  studentEmail?: string;
}

export interface Section extends DataRow {
  id: string;
  name: string;
  gradeLevel?: string;
  department?: string;
}

export interface Subject extends DataRow {
  id: string;
  name: string;
  className: string;
  code: string;
  track?: string;
  description?: string;
  enrollmentStatus?: string;
  teacherId?: string;
  approvedStudentsCount?: number;
  pendingRequestsCount?: number;
}

export interface Attachment extends DataRow {
  id: string;
  fileName: string;
  url: string;
  downloadUrl?: string;
  fileType?: string;
  size?: number;
}
export interface Lesson extends DataRow {
  id: string;
  title: string;
  description: string;
  subject: string;
  subjectId: string;
  className?: string;
  track?: string;
  attachments: Attachment[];
  downloadUrl?: string;
  createdAt?: string;
  progress?: DataRow;
}

export interface Assessment extends DataRow {
  id: string;
  title: string;
  subject: string;
  subjectId: string;
  assessmentMode: string;
  challengeDescription?: string;
  submissionDeadline?: string | null;
  activityPoints?: number | null;
  attachments: Attachment[];
  allowedSubmissionTypes?: string[];
  isLocked?: boolean;
  lockReason?: string;
  isDeadlinePassed?: boolean;
}

export interface Notification extends DataRow {
  id: string;
  type: string;
  title: string;
  message: string;
  subject?: string;
  preview?: string;
  senderName?: string;
  senderRole?: string;
  urgent?: boolean;
  isViewed: boolean;
  createdAt?: string | null;
  meta?: DataRow;
}

export interface AttendanceEntry {
  studentId: string;
  status: AttendanceStatus;
  studentName?: string;
  markedAt?: string;
}
export interface AttendanceRecord extends DataRow {
  id: string;
  dateKey: string;
  attendanceScope?: AttendanceScope;
  status?: AttendanceStatus;
  subject?: DataRow;
  section?: DataRow;
  teacher?: DataRow;
  title?: string;
  isLocked: boolean;
  entries?: AttendanceEntry[];
  summary?: DataRow;
}

export interface AttendanceOverview {
  summary: DataRow;
  records: AttendanceRecord[];
  students?: DataRow[];
  teachers?: DataRow[];
}
export interface AttendanceFilters {
  subjectId?: string;
  scope?: AttendanceScope;
  date?: string;
  from?: string;
  to?: string;
  limit?: number;
}
export interface AttendanceRosterStudent extends DataRow {
  id: string;
  name: string;
  attendanceStatus: AttendanceStatus | '';
}
export interface AttendanceRoster {
  attendanceScope: AttendanceScope;
  subject: Subject;
  section: Section;
  dateKey: string;
  attendance: AttendanceRecord | null;
  students: AttendanceRosterStudent[];
}
export interface SaveAttendanceInput {
  subjectId?: string;
  scope?: AttendanceScope;
  date: string;
  entries: AttendanceEntry[];
}

export interface AttendanceSession extends DataRow {
  id: string;
  subjectId: string;
  dateKey: string;
  status: 'open' | 'finalized' | 'cancelled';
  expiresAt: string;
  lateAfter: string;
  attendanceRecordId: string | null;
  scanCount: number;
}
export interface CreateAttendanceSessionInput {
  subjectId: string;
  dateKey: string;
  durationMinutes?: number;
  lateAfterMinutes?: number;
}
export interface AttendanceSessionQr {
  session: AttendanceSession;
  qrPayload: string;
}
export interface AttendanceSessionRosterRow {
  studentId: string;
  studentName: string;
  status: AttendanceStatus | null;
  scannedAt: string | null;
}
export interface AttendanceSessionDetail {
  session: AttendanceSession;
  roster: AttendanceSessionRosterRow[];
}
export interface AttendanceScanResult {
  attendance: {
    sessionId: string;
    subjectId: string;
    dateKey: string;
    status: AttendanceStatus;
    scannedAt: string;
  };
  duplicate: boolean;
}

export interface ReviewGradeInput {
  assessmentId: string;
  submissionId: string;
  action: 'grade' | 'return_for_revision';
  gradeValue?: number;
  teacherFeedback?: string;
}
export interface AssessmentWeights {
  activity: number;
  quiz: number;
  exam: number;
  minimumEvidenceCount: number;
}
export interface ActivityResponseInput {
  responseText: string;
  links?: string[];
  retainedAttachmentIds?: string[];
}
export interface PublishAnnouncementInput {
  title: string;
  content: string;
  requestId?: string;
  urgent?: boolean;
}
export interface CreateUserInput {
  name: string;
  email: string;
  username: string;
  role?: Role;
  status?: string;
  department?: string;
  subject?: string;
  strand?: string;
  gradeLevel?: string;
  contactNumber?: string;
  sectionId?: string;
  advisorySectionId?: string;
  teacherId?: string;
}
