function buildDefaultSchoolYearLabel(now = new Date()) {
  const resolvedDate = now instanceof Date ? now : new Date(now);
  const year = resolvedDate.getFullYear();
  const month = resolvedDate.getMonth();
  const startYear = month >= 5 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

function normalizeSchoolYearLabel(input, fallback = '') {
  const normalized = String(input || fallback || '')
    .trim()
    .replace(/\s+/g, '');

  if (!normalized) {
    return buildDefaultSchoolYearLabel();
  }

  const matchedRange = normalized.match(/^(\d{4})[-/](\d{4})$/);
  if (!matchedRange) {
    return normalized;
  }

  const startYear = Number(matchedRange[1]);
  const endYear = Number(matchedRange[2]);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    return normalized;
  }

  return `${startYear}-${endYear}`;
}

function buildExcludeArchivedStudentsFilter() {
  return {
    'archive.isArchived': { $ne: true },
  };
}

function buildArchivedStudentsFilter({ schoolYear = '' } = {}) {
  const normalizedSchoolYear = String(schoolYear || '').trim();
  return {
    'archive.isArchived': true,
    ...(normalizedSchoolYear ? { 'archive.schoolYear': normalizedSchoolYear } : {}),
  };
}

function isArchivedStudent(student) {
  return student?.archive?.isArchived === true;
}

module.exports = {
  buildDefaultSchoolYearLabel,
  normalizeSchoolYearLabel,
  buildExcludeArchivedStudentsFilter,
  buildArchivedStudentsFilter,
  isArchivedStudent,
};
