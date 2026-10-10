const BASE_STRAND_SUBJECT_MAP = {
  STEM: ['Mathematics', 'Science', 'Physics', 'Chemistry', 'Technology'],
  HUMSS: ['English', 'Communication', 'Literature', 'Social Sciences'],
  ABM: ['Business Mathematics', 'Accounting', 'Entrepreneurship', 'Finance'],
  TVL: ['Technical Skills', 'ICT', 'Vocational Skills'],
};
const GENERAL_SUBJECTS = Array.from(
  new Set(Object.values(BASE_STRAND_SUBJECT_MAP).flat())
);
const STRANDS = ['STEM', 'HUMSS', 'ABM', 'TVL', 'GENERAL'];

const STRAND_SUBJECT_MAP = {
  ...BASE_STRAND_SUBJECT_MAP,
  GENERAL: GENERAL_SUBJECTS,
};

const SUBJECT_TO_CATEGORY = {
  Mathematics: 'Math',
  Science: 'Science',
  Physics: 'Science',
  Chemistry: 'Science',
  Technology: 'Technical',
  English: 'English',
  Communication: 'English',
  Literature: 'English',
  'Social Sciences': 'AP',
  'Business Mathematics': 'Business',
  Accounting: 'Business',
  Entrepreneurship: 'Business',
  Finance: 'Business',
  'Technical Skills': 'Technical',
  ICT: 'Technical',
  'Vocational Skills': 'Technical',
};

function normalizeStrand(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return STRANDS.includes(normalized) ? normalized : '';
}

function getSubjectsByStrand(strand) {
  const normalized = normalizeStrand(strand);
  if (!normalized) return [];
  return [...(STRAND_SUBJECT_MAP[normalized] || [])];
}

function isSubjectAllowedForStrand({ strand, subject }) {
  const allowed = getSubjectsByStrand(strand);
  const normalizedSubject = String(subject || '').trim();
  return allowed.includes(normalizedSubject);
}

function getSubjectCategory(subject) {
  const normalizedSubject = String(subject || '').trim();
  return SUBJECT_TO_CATEGORY[normalizedSubject] || '';
}

module.exports = {
  STRANDS,
  STRAND_SUBJECT_MAP,
  SUBJECT_TO_CATEGORY,
  normalizeStrand,
  getSubjectsByStrand,
  isSubjectAllowedForStrand,
  getSubjectCategory,
};
