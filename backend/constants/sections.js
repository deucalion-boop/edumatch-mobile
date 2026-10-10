const DEFAULT_SECTION_NAMES = [
  'Charity',
  'Humility',
  'Creativity',
  'Credibility',
  'Curiosity',
  'Dignity',
  'Einstein',
  'Generosity',
  'Integrity',
  'Loyalty',
  'Purity',
  'Simplicity',
  'Sincerity',
  'Unity',
];

function normalizeSectionName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

module.exports = {
  DEFAULT_SECTION_NAMES,
  normalizeSectionName,
};
