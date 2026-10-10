const ROLE_ADMIN = 'admin';
const ROLE_SECRETARY = 'secretary';
const ROLE_HEADTEACHER = 'headteacher';
const ROLE_TEACHER = 'teacher';
const ROLE_STUDENT = 'student';

const USER_ROLES = [
  ROLE_STUDENT,
  ROLE_TEACHER,
  ROLE_HEADTEACHER,
  ROLE_SECRETARY,
  ROLE_ADMIN,
];

const DEPARTMENTS = [
  'Mathematics',
  'English',
  'Science',
  'TLE',
  'Filipino',
  'Araling Panlipunan',
  'Edukasyon sa Pagpapakatao (ESP)',
  'MAPEH',
];

const DEPARTMENT_ROLE_SET = new Set([ROLE_HEADTEACHER, ROLE_TEACHER]);

module.exports = {
  ROLE_ADMIN,
  ROLE_SECRETARY,
  ROLE_HEADTEACHER,
  ROLE_TEACHER,
  ROLE_STUDENT,
  USER_ROLES,
  DEPARTMENTS,
  DEPARTMENT_ROLE_SET,
};
