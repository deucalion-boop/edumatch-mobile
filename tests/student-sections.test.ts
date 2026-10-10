import test from 'node:test';
import assert from 'node:assert/strict';
import { studentSectionOptions } from '../src/screens/studentSections';
import type { Section } from '../src/api/types';

const sections: Section[] = [
  { id: 'own-section', name: 'Charity', isActive: true, adviser: { id: 'teacher-one' } },
  { id: 'other-section', name: 'Humility', isActive: true, adviser: { id: 'teacher-two' } },
  { id: 'inactive-section', name: 'Unity', isActive: false, adviser: null },
];

test('fresh teacher login can use the section directory when its profile omits the advisory ID', () => {
  const options = studentSectionOptions(sections, { id: 'teacher-one', role: 'teacher' });
  assert.deepEqual(options.map(section => section.id), ['own-section']);
});

test('legacy section responses can use an assigned advisory ID from the profile', () => {
  const options = studentSectionOptions([{ id: 'own-section', name: 'Charity' }], {
    id: 'teacher-one', role: 'teacher', advisorySectionId: 'own-section',
  });
  assert.deepEqual(options.map(section => section.id), ['own-section']);
});

test('current directory assignments take precedence over stale profile assignments', () => {
  const options = studentSectionOptions(sections, {
    id: 'teacher-one', role: 'teacher', advisorySectionId: 'other-section',
  });
  assert.deepEqual(options.map(section => section.id), ['own-section']);
});

test('an unassigned teacher cannot choose other teachers sections or an inactive section', () => {
  assert.deepEqual(studentSectionOptions(sections, { id: 'unassigned', role: 'teacher' }), []);
  assert.deepEqual(studentSectionOptions(sections, { id: 'unassigned', role: 'teacher', advisorySectionId: 'inactive-section' }), []);
});

test('administrators and secretaries can choose every active section', () => {
  for (const role of ['admin', 'secretary'] as const) {
    assert.deepEqual(studentSectionOptions(sections, { id: 'staff', role }).map(section => section.id), ['own-section', 'other-section']);
  }
});
