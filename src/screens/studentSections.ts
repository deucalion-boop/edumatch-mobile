import type { Section, User } from '../api/types';

export function studentSectionOptions(sections: Section[], creator: Pick<User, 'id' | 'role' | 'advisorySectionId'>): Section[] {
  const activeSections = sections.filter(section => section.isActive !== false);
  if (creator.role !== 'teacher') return activeSections;

  // Fresh login profiles may omit the advisory ID; the directory includes its adviser.
  const assignedSectionId = activeSections.find(section => {
    const adviser = section.adviser as { id?: string } | null | undefined;
    return !!creator.id && adviser?.id === creator.id;
  })?.id || creator.advisorySectionId;
  return activeSections.filter(section => section.id === assignedSectionId);
}
