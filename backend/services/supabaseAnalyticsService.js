const { getSupabaseStorageClient } = require('./supabaseStorageService');

const ANALYTICS_ROLES = ['student', 'teacher', 'headteacher', 'secretary'];

function analyticsError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseAnalyticsError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = 500;
  return normalized;
}

function dateValue(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function inRange(value, start, end = null) {
  const date = dateValue(value);
  return Boolean(date && date >= start && (!end || date < end));
}

function pctGrowth(current, previous) {
  if (!previous) return current > 0 ? 100 : (current < 0 ? -100 : 0);
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function buildRecentDayBuckets(dayCount = 30) {
  const buckets = [];
  const now = new Date();
  for (let index = dayCount - 1; index >= 0; index -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - index);
    buckets.push({
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }
  return buckets;
}

function formatTimeAgo(value) {
  const date = dateValue(value);
  if (!date) return 'Just now';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

async function readAnalyticsRows() {
  const client = getSupabaseStorageClient();
  const [usersResult, lessonsResult, assessmentsResult] = await Promise.all([
    client.from('users').select('id,name,email,role,status,department,created_at,updated_at'),
    client.from('lessons').select('id,title,subject,track,created_at,updated_at'),
    client.from('assessments').select('id,title,subject,difficulty,exam_type,created_at,updated_at'),
  ]);

  if (usersResult.error) throw analyticsError(usersResult.error, 'Failed to read user analytics from Supabase');
  if (lessonsResult.error) throw analyticsError(lessonsResult.error, 'Failed to read lesson analytics from Supabase');
  if (assessmentsResult.error) throw analyticsError(assessmentsResult.error, 'Failed to read assessment analytics from Supabase');

  return {
    users: usersResult.data || [],
    lessons: lessonsResult.data || [],
    assessments: assessmentsResult.data || [],
  };
}

function accountPeriodStats(users, role, periodStart, previousPeriodStart) {
  const scoped = users.filter((user) => !role || user.role === role);
  const current = scoped.filter((user) => (
    (user.status === 'active' && inRange(user.created_at, periodStart))
    || (user.status === 'inactive' && inRange(user.updated_at, periodStart))
  ));
  const previous = scoped.filter((user) => (
    (user.status === 'active' && inRange(user.created_at, previousPeriodStart, periodStart))
    || (user.status === 'inactive' && inRange(user.updated_at, previousPeriodStart, periodStart))
  ));
  const net = (rows) => rows.reduce((sum, user) => sum + (user.status === 'inactive' ? -1 : 1), 0);
  const currentNet = net(current);
  const previousNet = net(previous);
  return { current: currentNet, netChange: currentNet - previousNet, growth: pctGrowth(currentNet, previousNet) };
}

function detailUser(user) {
  return {
    id: String(user.id),
    name: user.name || 'Unnamed user',
    email: user.email || '-',
    department: user.department || '-',
    status: user.status || '-',
    createdAt: user.created_at || null,
  };
}

async function getSupabaseAnalytics() {
  const { users, lessons, assessments } = await readAnalyticsRows();
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - 30);
  const previousPeriodStart = new Date(periodStart);
  previousPeriodStart.setDate(previousPeriodStart.getDate() - 30);
  const trendBuckets = buildRecentDayBuckets(30);
  const activeUsers = users.filter((user) => user.status === 'active');

  const roleStats = Object.fromEntries(ANALYTICS_ROLES.map((role) => [
    role,
    accountPeriodStats(users, role, periodStart, previousPeriodStart),
  ]));
  const allUserStats = accountPeriodStats(users, null, periodStart, previousPeriodStart);
  const currentLessons = lessons.filter((lesson) => inRange(lesson.created_at, periodStart)).length;
  const previousLessons = lessons.filter((lesson) => inRange(lesson.created_at, previousPeriodStart, periodStart)).length;

  const roleSeries = ANALYTICS_ROLES.map((role) => ({
    label: role === 'headteacher' ? 'Head Teachers' : `${role[0].toUpperCase()}${role.slice(1)}s`,
    data: trendBuckets.map((bucket) => users.filter((user) => (
      user.role === role && String(user.created_at || '').slice(0, 10) === bucket.key
    )).length),
  }));

  const examTypeCounts = new Map();
  const difficultyData = { easy: 0, medium: 0, hard: 0 };
  assessments.forEach((assessment) => {
    const examType = String(assessment.exam_type || '').trim();
    if (examType) examTypeCounts.set(examType, (examTypeCounts.get(examType) || 0) + 1);
    const difficulty = String(assessment.difficulty || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(difficultyData, difficulty)) difficultyData[difficulty] += 1;
  });
  const examTypes = [...examTypeCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count);

  const subjectMap = new Map();
  lessons.forEach((lesson) => {
    const subject = String(lesson.subject || '').trim();
    if (!subject) return;
    const key = `${lesson.track || 'Unassigned'}::${subject}`;
    const current = subjectMap.get(key) || { subject, track: lesson.track || 'Unassigned', lessonCount: 0, assessmentCount: 0, submissionCount: 0, averageScore: 0, lastContentAt: null };
    current.lessonCount += 1;
    if (!current.lastContentAt || new Date(lesson.created_at) > new Date(current.lastContentAt)) current.lastContentAt = lesson.created_at;
    subjectMap.set(key, current);
  });
  assessments.forEach((assessment) => {
    const subject = String(assessment.subject || '').trim();
    if (!subject) return;
    let entry = [...subjectMap.values()].find((item) => item.subject === subject);
    if (!entry) {
      entry = { subject, track: 'Unassigned', lessonCount: 0, assessmentCount: 0, submissionCount: 0, averageScore: 0, lastContentAt: null };
      subjectMap.set(`Unassigned::${subject}`, entry);
    }
    entry.assessmentCount += 1;
  });
  const subjectPerformance = [...subjectMap.values()];
  const topSubjects = [...subjectPerformance]
    .sort((left, right) => right.assessmentCount - left.assessmentCount || right.lessonCount - left.lessonCount)
    .slice(0, 5);
  const atRiskSubjects = [...subjectPerformance]
    .filter((item) => item.lessonCount > 0 && (!item.lastContentAt || new Date(item.lastContentAt) < periodStart))
    .slice(0, 5);

  const trackMap = new Map();
  lessons.forEach((lesson) => {
    const track = String(lesson.track || '').trim();
    if (track) trackMap.set(track, trackMap.get(track) || { track, assessmentCount: 0, submissionCount: 0, averageScore: 0 });
  });
  subjectPerformance.forEach((item) => {
    if (!trackMap.has(item.track)) trackMap.set(item.track, { track: item.track, assessmentCount: 0, submissionCount: 0, averageScore: 0 });
    trackMap.get(item.track).assessmentCount += item.assessmentCount;
  });

  const recentActivities = [
    ...users.map((user) => ({ id: `user-${user.id}`, type: 'user', title: `New ${user.role || 'user'} account`, description: `${user.name || 'A user'} joined the platform.`, icon: 'fas fa-user-plus', occurredAt: user.created_at })),
    ...lessons.map((lesson) => ({ id: `lesson-${lesson.id}`, type: 'lesson', title: 'Lesson published', description: `${lesson.title || 'Untitled lesson'} was added to ${lesson.track || lesson.subject || 'the catalog'}.`, icon: 'fas fa-book-open', occurredAt: lesson.created_at })),
    ...assessments.map((assessment) => ({ id: `assessment-${assessment.id}`, type: 'assessment', title: 'Assessment created', description: `${assessment.title || 'Untitled assessment'} (${assessment.exam_type || 'exam'}) is now available.`, icon: 'fas fa-file-alt', occurredAt: assessment.created_at })),
  ].filter((item) => item.occurredAt)
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt))
    .slice(0, 10)
    .map((item) => ({ ...item, timeAgo: formatTimeAgo(item.occurredAt) }));

  const pendingApplications = users.filter((user) => user.status === 'pending').length;
  const activeByRole = (role) => activeUsers.filter((user) => user.role === role);
  const totalSubjects = new Set([...lessons, ...assessments].map((item) => String(item.subject || '').trim()).filter(Boolean)).size;

  return {
    analytics: {
      totalUsers: activeUsers.length,
      totalStudents: activeByRole('student').length,
      totalTeachers: activeByRole('teacher').length,
      totalHeadTeachers: activeByRole('headteacher').length,
      totalSecretaries: activeByRole('secretary').length,
      totalCourses: lessons.length,
      totalTracks: trackMap.size,
      totalSubjects,
      totalEnrollments: 0,
      totalLessons: lessons.length,
      totalAssessments: assessments.length,
      totalSubmissions: 0,
      totalActivities: assessments.length,
      studentGrowth: roleStats.student.growth,
      studentNetChange: roleStats.student.netChange,
      teacherGrowth: roleStats.teacher.growth,
      teacherNetChange: roleStats.teacher.netChange,
      headTeacherGrowth: roleStats.headteacher.growth,
      headTeacherNetChange: roleStats.headteacher.netChange,
      secretaryGrowth: roleStats.secretary.growth,
      secretaryNetChange: roleStats.secretary.netChange,
      totalUserGrowth: allUserStats.growth,
      totalUserNetChange: allUserStats.netChange,
      courseGrowth: pctGrowth(currentLessons, previousLessons),
      newStudents: roleStats.student.current,
      pendingApplications,
      pendingCourses: 0,
      pendingEnrollments: 0,
      approvalWorkload: { pendingApplications, pendingEnrollments: 0, totalPending: pendingApplications },
      avgSession: 'N/A',
      courseCompletion: 0,
      weeklyCompletionGrowth: 0,
      roleTrends: { labels: trendBuckets.map((bucket) => bucket.label), series: roleSeries },
      learningFunnel: { labels: ['Lessons', 'Assessments', 'Submissions'], values: [lessons.length, assessments.length, 0] },
      detailTables: {
        students: users.filter((user) => user.role === 'student').map(detailUser),
        teachers: users.filter((user) => user.role === 'teacher').map(detailUser),
        headTeachers: users.filter((user) => user.role === 'headteacher').map(detailUser),
        secretaries: users.filter((user) => user.role === 'secretary').map(detailUser),
        lessons: lessons.map((lesson) => ({ id: String(lesson.id), title: lesson.title || 'Untitled lesson', subject: lesson.subject || '-', track: lesson.track || '-', createdAt: lesson.created_at || null })),
        assessments: assessments.map((assessment) => ({ id: String(assessment.id), title: assessment.title || 'Untitled assessment', subject: assessment.subject || '-', difficulty: assessment.difficulty || '-', examType: assessment.exam_type || '-', createdAt: assessment.created_at || null })),
      },
      topSubjects,
      topTracks: [...trackMap.values()].sort((left, right) => right.assessmentCount - left.assessmentCount).slice(0, 5),
      atRiskSubjects,
    },
    aiAnalytics: {
      totalGeneratedExams: assessments.length,
      totalAiChallenges: assessments.length,
      recentChallenges: assessments.filter((assessment) => inRange(assessment.created_at, periodStart)).length,
      topExamType: examTypes[0]?.name || '',
      examTypes,
      difficultyData,
      attemptedExams: 0,
      unattemptedExams: assessments.length,
      completionRate: 0,
      mostEffectiveDifficulty: null,
      usageDistribution: { labels: ['Attempted', 'Not Yet Attempted'], values: [0, assessments.length] },
    },
    recentActivities,
  };
}

module.exports = { getSupabaseAnalytics };
