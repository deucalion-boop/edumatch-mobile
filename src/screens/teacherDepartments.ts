import type { User } from '../api/types';
import { DEPARTMENTS } from '../auth/roles';

type DepartmentAccount = Pick<User, 'role' | 'department'>;

export function teacherDepartmentOptions(headTeachers: DepartmentAccount[], creator: DepartmentAccount) {
  const departmentHeads = creator.role === 'headteacher' ? [creator] : headTeachers;
  const assignedDepartments = new Set(departmentHeads
    .filter(account => account.role === 'headteacher')
    .map(account => account.department));
  return DEPARTMENTS.filter(department => assignedDepartments.has(department));
}
