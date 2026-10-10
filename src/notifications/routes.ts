import type { Role } from '../api/types';
import { FEATURES } from '../auth/roles';

export function notificationRoute(data: unknown, role: Role): string | null {
  if (!data || typeof data !== 'object') return null;
  const route = (data as Record<string, unknown>).route;
  if (typeof route !== 'string') return null;
  if (route === '/notifications') return `/${role}/notifications`;
  const allowed = [`/${role}`, ...['workspace', 'records', 'announcements', 'account', ...FEATURES[role]].map((feature) => `/${role}/${feature}`)];
  return allowed.includes(route) ? route : null;
}
