// AI analytics stores operational fields only, never prompts, answers or credentials.
const TEXT_FIELDS = {
  provider: 50,
  model: 160,
  subject: 160,
  department: 160,
  difficulty: 30,
  examType: 80,
  generationMode: 80,
};
const COUNT_FIELDS = ['requestedQuestions', 'generatedQuestions', 'providerRequests'];

function sanitizeAiGenerationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sanitized = {};
  for (const [key, limit] of Object.entries(TEXT_FIELDS)) {
    if (typeof value[key] !== 'string') continue;
    const text = value[key].trim().slice(0, limit);
    if (text) sanitized[key] = text;
  }
  for (const key of COUNT_FIELDS) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) continue;
    sanitized[key] = Math.floor(value[key]);
  }
  return sanitized;
}

module.exports = { sanitizeAiGenerationMetadata };
