import type { Role, User } from '../api/types';
import { isGradeTenStudent } from '../auth/studentAccess';

export const roleNames: Record<Role, string> = {
  admin: 'Admin / Principal', secretary: 'Secretary', headteacher: 'Head Teacher', teacher: 'Teacher', student: 'Student',
};
export type Feature = 'approvals' | 'academic' | 'ai-usage' | 'attendance' | 'grades' | 'subjects' | 'lessons' | 'records' | 'announcements' | 'notifications';
export const featureNames: Record<Feature, string> = {
  approvals: 'Approvals', academic: 'Academic monitoring', 'ai-usage': 'AI assessment analytics', attendance: 'Attendance', grades: 'Grades & feedback',
  subjects: 'Subjects', lessons: 'Lessons & activities', records: 'User Management', announcements: 'Announcements', notifications: 'Notifications',
};
export const roleFeatures: Record<Role, { feature: Feature; detail: string; icon: string }[]> = {
  admin: [
    { feature: 'approvals', detail: 'Review account and export requests', icon: 'checkmark-done-outline' },
    { feature: 'academic', detail: 'Monitor school academic performance', icon: 'stats-chart-outline' },
    { feature: 'ai-usage', detail: 'Track AI usage when creating assessments', icon: 'sparkles-outline' },
    { feature: 'records', detail: 'Create and manage school user accounts', icon: 'folder-open-outline' },
    { feature: 'attendance', detail: 'Review school attendance records', icon: 'calendar-outline' },
    { feature: 'announcements', detail: 'Send school messages', icon: 'megaphone-outline' },
  ],
  secretary: [
    { feature: 'records', detail: 'Find and manage school user accounts', icon: 'folder-open-outline' },
    { feature: 'attendance', detail: 'Track attendance records', icon: 'calendar-outline' },
    { feature: 'approvals', detail: 'Track export request decisions', icon: 'document-text-outline' },
    { feature: 'announcements', detail: 'Send messages to school accounts', icon: 'megaphone-outline' },
  ],
  headteacher: [
    { feature: 'academic', detail: 'Monitor your department', icon: 'stats-chart-outline' },
    { feature: 'grades', detail: 'Review academic results', icon: 'ribbon-outline' },
    { feature: 'lessons', detail: 'Review teaching materials', icon: 'book-outline' },
    { feature: 'attendance', detail: 'Monitor department attendance', icon: 'calendar-outline' },
    { feature: 'announcements', detail: 'Message your teachers', icon: 'megaphone-outline' },
  ],
  teacher: [
    { feature: 'attendance', detail: 'Create QR sessions and finalize attendance', icon: 'qr-code-outline' },
    { feature: 'grades', detail: 'Grade submissions and give feedback', icon: 'ribbon-outline' },
    { feature: 'subjects', detail: 'View your classes and enrollment codes', icon: 'library-outline' },
    { feature: 'lessons', detail: 'Open lesson materials and activities', icon: 'book-outline' },
    { feature: 'approvals', detail: 'Review subject enrollment requests', icon: 'checkmark-done-outline' },
    { feature: 'announcements', detail: 'Publish to your subjects', icon: 'megaphone-outline' },
  ],
  student: [
    { feature: 'attendance', detail: 'Scan a class QR and check your attendance', icon: 'qr-code-outline' },
    { feature: 'subjects', detail: "Enter your teacher's class code to join", icon: 'library-outline' },
    { feature: 'lessons', detail: 'Read lessons and complete activities', icon: 'book-outline' },
    { feature: 'grades', detail: 'View results and teacher feedback', icon: 'ribbon-outline' },
    { feature: 'academic', detail: 'See your academic progress', icon: 'stats-chart-outline' },
    { feature: 'announcements', detail: 'Read updates from your school', icon: 'megaphone-outline' },
  ],
};

export function availableFeatures(user: User) {
  const features = roleFeatures[user.role];
  return user.role === 'student' && !isGradeTenStudent(user)
    ? features.filter(item => item.feature === 'attendance' || item.feature === 'subjects' || item.feature === 'announcements')
    : features;
}

export function routeFor(role: Role, feature: Feature): `/${Role}/${Feature}` { return `/${role}/${feature}`; }

export function displayDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function rawText(row: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return fallback;
}
