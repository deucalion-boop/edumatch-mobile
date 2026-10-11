import test from 'node:test';
import assert from 'node:assert/strict';
import { teacherDepartmentOptions } from '../src/screens/teacherDepartments';

test('teachers have no available departments until a Head Teacher exists', () => {
  assert.deepEqual(teacherDepartmentOptions([], { role: 'admin' }), []);
  assert.deepEqual(teacherDepartmentOptions([{ role: 'teacher', department: 'Science' }], { role: 'secretary' }), []);
});

test('administrators and secretaries can choose only configured departments with Head Teachers', () => {
  for (const role of ['admin', 'secretary'] as const) {
    assert.deepEqual(teacherDepartmentOptions([
      { role: 'headteacher', department: 'Science' },
      { role: 'headteacher', department: 'English' },
      { role: 'headteacher', department: 'Science' },
      { role: 'headteacher', department: 'Unsupported department' },
      { role: 'headteacher' },
      { role: 'teacher', department: 'Mathematics' },
    ], { role }), ['English', 'Science']);
  }
});

test('Head Teachers creating teachers stay within their own assigned department', () => {
  assert.deepEqual(teacherDepartmentOptions([
    { role: 'headteacher', department: 'Mathematics' },
  ], { role: 'headteacher', department: 'Science' }), ['Science']);
});

test('a Head Teacher without a supported department cannot choose another heads department', () => {
  for (const department of [undefined, '', 'Unsupported department']) {
    assert.deepEqual(teacherDepartmentOptions([
      { role: 'headteacher', department: 'Science' },
    ], { role: 'headteacher', department }), []);
  }
});
