import type { Role } from '../api/types';
export const ROLES: Role[] = ['admin', 'secretary', 'headteacher', 'teacher', 'student'];
export const ROLE_LABELS: Record<Role, string> = { admin: 'Principal / Admin', secretary: 'Secretary', headteacher: 'Head Teacher', teacher: 'Teacher', student: 'Student' };
// Keep these choices aligned with backend/constants/userRoles.js.
export const DEPARTMENTS = [
  'Mathematics', 'English', 'Science', 'TLE', 'Filipino', 'Araling Panlipunan',
  'Edukasyon sa Pagpapakatao (ESP)', 'MAPEH',
] as const;
export function normalizeRole(value: unknown): Role {
  const normalized = String(value || '').toLowerCase().replace(/[ _-]/g, '');
  const role = normalized === 'principal' ? 'admin' : normalized;
  if (!ROLES.includes(role as Role)) throw new Error('This account role is not supported. Contact your administrator.');
  return role as Role;
}
export function homeForRole(role: Role) { return `/${role}` as const; }
export const FEATURES: Record<Role, readonly string[]> = {
  admin: ['approvals', 'academic', 'subjects', 'attendance', 'notifications'],
  secretary: ['approvals', 'subjects', 'attendance', 'notifications'],
  headteacher: ['academic', 'grades', 'lessons', 'attendance', 'notifications'],
  teacher: ['approvals', 'grades', 'subjects', 'lessons', 'attendance', 'notifications'],
  student: ['academic', 'grades', 'subjects', 'lessons', 'attendance', 'notifications'],
};
