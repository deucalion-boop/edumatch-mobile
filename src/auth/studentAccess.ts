import type { User } from '../api/types';

export function isGradeTenStudent(user: Pick<User, 'role' | 'gradeLevel'>): boolean {
  return user.role === 'student' && /^(?:Grade\s+)?10$/i.test(String(user.gradeLevel ?? '').trim());
}
