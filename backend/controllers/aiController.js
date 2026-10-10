const path = require('path');
const OpenAI = require('openai');
const Lesson = require('../models/Lesson');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { extractTextFromPdf } = require('../utils/pdfTextExtractor');
const { readStoredFileBuffer } = require('../utils/fileStorage');
const { sendSuccess } = require('../utils/responseHelper');
const { getAiRuntimeConfigFromEnv } = require('../utils/aiRuntimeConfig');
const { inferSubjectCategory, normalizeSubjectCategory } = require('../services/recommendationService');
const {
  buildAssessmentPolicy,
  parseSubmissionDeadline,
  parseExamDurationMinutes,
} = require('../services/assessmentPolicyService');
const { ROLE_HEADTEACHER, ROLE_TEACHER } = require('../constants/userRoles');
const { normalizeStrand, getSubjectsByStrand, isSubjectAllowedForStrand, getSubjectCategory } = require('../constants/strandSubjects');
const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { findSupabaseLesson } = require('../services/supabaseContentService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function assertFutureSubmissionDeadline(value) {
  const parsed = parseSubmissionDeadline(value);
  if (!parsed) return null;
  if (parsed.getTime() <= Date.now()) {
    const error = new Error('submissionDeadline must be a future date and time');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

async function resolveAssessmentOwnerContext(req, lessonId, teacherId) {
  const requesterRole = String(req.user?.role || '').trim().toLowerCase();

  if (requesterRole === ROLE_HEADTEACHER) {
    const normalizedTeacherId = String(teacherId || '').trim();
    if (!normalizedTeacherId) {
      const error = new Error('teacherId is required for Head Teacher AI generation');
      error.statusCode = 400;
      throw error;
    }

    const teacher = await findSupabaseAccount('id', normalizedTeacherId);

    if (
      !teacher
      || String(teacher.role || '') !== ROLE_TEACHER
      || String(teacher.managedBy || '') !== String(req.user._id || '')
      || String(teacher.department || '') !== String(req.user?.department || '')
    ) {
      const error = new Error('The selected teacher is not managed by this Head Teacher');
      error.statusCode = 404;
      throw error;
    }

    const lesson = lessonId
      ? await findSupabaseLesson(lessonId, teacher._id)
      : null;
    if (lessonId && !lesson) {
      const error = new Error('Lesson not found for the selected teacher');
      error.statusCode = 404;
      throw error;
    }

    return { ownerTeacher: teacher, lesson };
  }

  const lesson = lessonId
    ? await findSupabaseLesson(lessonId, req.user._id)
    : null;
  if (lessonId && !lesson) {
    const error = new Error('Lesson not found for this teacher');
    error.statusCode = 404;
    throw error;
  }

  return { ownerTeacher: req.user, lesson };
}

function resolveAssessmentSubjectCategory({ subjectCategory, examType, title, lessonTrack }) {
  return normalizeSubjectCategory(subjectCategory)
    || inferSubjectCategory({ subjectCategory, examType, title, lessonTrack })
    || 'Technical';
}

function parseJsonPayload(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;

  const normalizeJsonLikeText = (value) => String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();

  const safeParse = (value) => {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  };

  const directParsed = safeParse(normalizeJsonLikeText(trimmed));
  if (directParsed) return directParsed;

  const candidates = [];
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    const parsed = safeParse(normalizeJsonLikeText(candidate));
    if (parsed) {
      if (Array.isArray(parsed)) {
        return { title: '', questions: parsed };
      }
      return parsed;
    }
  }

  return null;
}

function sanitizeQuestion(question, fallbackIndex) {
  const type = ['multiple-choice', 'true-false', 'short-answer'].includes(question?.type)
    ? question.type
    : 'multiple-choice';

  let options = Array.isArray(question?.options) ? question.options.map((item) => String(item)) : [];
  if (type === 'true-false') {
    options = ['True', 'False'];
  }
  if (type === 'short-answer') {
    options = [];
  }

  return {
    questionText: String(question?.questionText || `Question ${fallbackIndex + 1}`).trim(),
    type,
    options,
    correctAnswer: String(question?.correctAnswer || '').trim(),
    points: Number(question?.points || 1),
    explanation: String(question?.explanation || '').trim(),
  };
}

function extractQuestionsFromLooseText(rawText, numberOfItems, examType) {
  const source = String(rawText || '').replace(/\r/g, '').trim();
  if (!source) return [];

  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const blocks = [];
  let current = [];
  const questionStartRegex = /^((\d+[\).:-]\s+)|(q(uestion)?\s*\d+[\).:-]\s+))/i;

  for (const line of lines) {
    if (questionStartRegex.test(line)) {
      if (current.length > 0) blocks.push(current);
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  if (blocks.length === 0) return [];

  const targetCount = Math.max(1, Math.min(100, Number(numberOfItems) || blocks.length));
  const fallbackType = toExamQuestionType(examType);
  const optionRegex = /^([A-Da-d][\).:-]\s+|[-*]\s+)/;
  const answerRegex = /^(answer|correct answer)\s*[:\-]\s*(.+)$/i;

  return blocks.slice(0, targetCount).map((block, index) => {
    const normalizedFirstLine = block[0].replace(questionStartRegex, '').trim();
    const questionText = normalizedFirstLine || block[0];
    const options = [];
    let correctAnswer = '';

    for (let i = 1; i < block.length; i += 1) {
      const line = block[i];
      const answerMatch = line.match(answerRegex);
      if (answerMatch) {
        correctAnswer = String(answerMatch[2] || '').trim();
        continue;
      }
      if (optionRegex.test(line)) {
        options.push(line.replace(optionRegex, '').trim());
      }
    }

    let type = fallbackType;
    if (options.length >= 2) type = 'multiple-choice';
    if (options.length === 2 && options.every((opt) => /^(true|false)$/i.test(opt))) type = 'true-false';
    if (type === 'short-answer') {
      return {
        questionText,
        type: 'short-answer',
        options: [],
        correctAnswer,
        points: 1,
        explanation: '',
      };
    }

    return {
      questionText,
      type,
      options,
      correctAnswer,
      points: 1,
      explanation: '',
    };
  });
}

function toExamQuestionType(examType) {
  const normalized = String(examType || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized.includes('mixed')) return 'mixed';
  if (normalized.includes('true-false')) return 'true-false';
  if (normalized.includes('identification') || normalized.includes('essay') || normalized.includes('short-answer')) {
    return 'short-answer';
  }
  return 'multiple-choice';
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 30);
}

function cleanSnippet(text, maxLength = 140) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function getAiRuntimeConfig() {
  const envConfig = getAiRuntimeConfigFromEnv();

  return {
    provider: envConfig.provider,
    model: envConfig.model,
    baseUrl: envConfig.baseUrl,
    apiKey: envConfig.apiKey,
    maxTokens: Number(envConfig.maxTokens || 1024),
    temperature: Number(envConfig.temperature ?? 0.3),
    isEnabled: envConfig.isEnabled,
    promptTemplate: '',
    verification: {
      status: envConfig.apiKey && envConfig.model ? 'verified' : 'unverified',
      isActive: Boolean(envConfig.apiKey && envConfig.model),
      verifiedAt: null,
      lastAttemptAt: null,
      lastError: '',
      providerStatusCode: 0,
      consecutiveGenerationFailures: 0,
      logs: [],
    },
  };
}

function getAiConfigurationStatus(aiConfig) {
  const hasApiKeyConfigured = Boolean(String(aiConfig?.apiKey || '').trim());
  const hasModelConfigured = Boolean(String(aiConfig?.model || '').trim());
  const isConfigured = hasApiKeyConfigured && hasModelConfigured;
  const isVerifiedActive = isConfigured;
  const canGenerate = Boolean(aiConfig?.isEnabled && isConfigured && isVerifiedActive);

  const missingRequiredFields = [];
  if (!hasApiKeyConfigured) missingRequiredFields.push('apiKey');
  if (!hasModelConfigured) missingRequiredFields.push('model');

  let configurationMessage = '';
  if (!aiConfig?.isEnabled) {
    configurationMessage = 'AI generator is currently disabled by server configuration.';
  } else if (!isConfigured) {
    configurationMessage = 'AI Generator is not configured. Set AI_PROVIDER, AI_MODEL_NAME, and AI_API_KEY in backend .env.';
  }

  return {
    hasApiKeyConfigured,
    hasModelConfigured,
    isConfigured,
    isVerifiedActive,
    canGenerate,
    missingRequiredFields,
    configurationMessage,
  };
}

async function requestAiOutput({ config, prompt }) {
  if (!config?.apiKey || !config?.model) return '';

  if (config.provider === 'gemini') {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: config.temperature,
          maxOutputTokens: Math.min(4096, config.maxTokens || 1024),
        },
      }),
    });
    if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n') || '';
    return String(text || '').trim();
  }

  if (config.provider === 'huggingface') {
    const endpoint = `https://api-inference.huggingface.co/models/${encodeURIComponent(config.model)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: Math.min(1024, config.maxTokens || 512),
          temperature: config.temperature,
        },
      }),
    });
    if (!response.ok) throw new Error(`Hugging Face request failed (${response.status})`);
    const payload = await response.json();
    if (Array.isArray(payload) && payload[0]?.generated_text) {
      return String(payload[0].generated_text || '').trim();
    }
    return String(payload?.generated_text || '').trim();
  }

  if (config.provider === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
        max_tokens: Math.min(4096, config.maxTokens || 1024),
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
    const payload = await response.json();
    return String(payload?.choices?.[0]?.message?.content || '').trim();
  }

  const openAiBaseUrl = config.provider === 'openai'
    ? (config.baseUrl || 'https://api.openai.com/v1')
    : config.baseUrl;
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: openAiBaseUrl || undefined });
  const aiResponse = await client.responses.create({
    model: config.model,
    input: prompt,
    temperature: config.temperature,
  });
  return String(aiResponse?.output_text || '').trim();
}

function isPdfLikeAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || attachment?.mimetype || '').toLowerCase();
  const extension = String(attachment?.extension || path.extname(attachment?.originalName || attachment?.originalname || '') || '').toLowerCase();
  return mimeType === 'application/pdf' || extension === '.pdf';
}

function resolveLessonPdfPath(lesson) {
  const attachments = Array.isArray(lesson?.attachments) ? lesson.attachments : [];
  const pdfAttachment = attachments.find((attachment) => isPdfLikeAttachment(attachment));
  if (pdfAttachment?.storedPath) return String(pdfAttachment.storedPath);
  return String(lesson?.pdfPath || '');
}

function buildLocalQuestions({ lessonTitle, examType, difficulty, numberOfItems, sourceText }) {
  const targetCount = Math.max(1, Math.min(100, Number(numberOfItems) || 1));
  const questionType = toExamQuestionType(examType);
  const sentences = splitSentences(sourceText);
  const pool = sentences.length > 0 ? sentences : [String(lessonTitle || 'the lesson topic')];
  const questions = [];

  const getTypeForIndex = (index) => {
    if (questionType !== 'mixed') return questionType;
    const cycle = ['multiple-choice', 'true-false', 'short-answer'];
    return cycle[index % cycle.length];
  };

  for (let i = 0; i < targetCount; i += 1) {
    const resolvedType = getTypeForIndex(i);
    const basis = pool[i % pool.length];
    const promptCore = cleanSnippet(basis, difficulty === 'hard' ? 180 : 120);
    if (resolvedType === 'true-false') {
      const isTrue = i % 2 === 0;
      questions.push({
        questionText: `True or False: ${isTrue ? promptCore : `The lesson states the opposite of: ${promptCore}`}`,
        type: 'true-false',
        options: ['True', 'False'],
        correctAnswer: isTrue ? 'True' : 'False',
        points: 1,
        explanation: 'Answer based on the linked lesson content.',
      });
      continue;
    }

    if (resolvedType === 'short-answer') {
      questions.push({
        questionText: `In 1-2 sentences, explain this lesson point: ${promptCore}`,
        type: 'short-answer',
        options: [],
        correctAnswer: cleanSnippet(basis, 180),
        points: 1,
        explanation: 'Use the lesson content to justify your response.',
      });
      continue;
    }

    const distractorA = cleanSnippet(pool[(i + 1) % pool.length], 80);
    const distractorB = cleanSnippet(pool[(i + 2) % pool.length], 80);
    const distractorC = cleanSnippet(pool[(i + 3) % pool.length], 80);
    const correct = cleanSnippet(basis, 80);
    const options = [correct, distractorA, distractorB, distractorC]
      .map((opt) => opt || 'Not enough lesson context provided')
      .slice(0, 4);
    const uniqueOptions = [...new Set(options)];
    while (uniqueOptions.length < 4) {
      uniqueOptions.push(`Lesson detail ${uniqueOptions.length + 1}`);
    }
    questions.push({
      questionText: `Which statement best matches the lesson content about: ${promptCore}?`,
      type: 'multiple-choice',
      options: uniqueOptions,
      correctAnswer: correct,
      points: 1,
      explanation: 'Correct option is directly derived from the lesson text.',
    });
  }

  return questions;
}

const getAiStatus = asyncHandler(async (_req, res) => {
  const aiConfig = getAiRuntimeConfig();
  const configurationStatus = getAiConfigurationStatus(aiConfig);

  return sendSuccess(res, 200, 'AI status fetched successfully', {
    canGenerate: configurationStatus.canGenerate,
    isConfigured: configurationStatus.isConfigured,
    isVerifiedActive: configurationStatus.isVerifiedActive,
    hasApiKeyConfigured: configurationStatus.hasApiKeyConfigured,
    hasModelConfigured: configurationStatus.hasModelConfigured,
    missingRequiredFields: configurationStatus.missingRequiredFields,
    configurationMessage: configurationStatus.configurationMessage,
    generationMode: configurationStatus.isConfigured ? 'provider-configured' : 'not-configured',
    hasPaidAiKey: configurationStatus.hasApiKeyConfigured,
    model: aiConfig.model || '',
    provider: aiConfig.provider || 'custom',
    isEnabled: Boolean(aiConfig.isEnabled),
    verification: aiConfig.verification,
  });
});

const generateAssessmentWithAi = asyncHandler(async (req, res) => {
  const {
    lessonId,
    subjectId,
    teacherId,
    topic,
    examType,
    subject,
    subjectCategory,
    difficulty,
    numberOfItems,
    assessmentMode,
    gradingPeriod,
    assignmentScope,
    examDurationMinutes: examDurationMinutesRaw,
    title,
    submissionDeadline: submissionDeadlineRaw,
    deadline: deadlineRaw,
    deadlineAt: deadlineAtRaw,
  } = req.body;

  if ((!lessonId && !subjectId) || !examType || !difficulty || !numberOfItems || !String(subject || '').trim()) {
    const error = new Error('lessonId or subjectId, examType, subject, difficulty, and numberOfItems are required');
    error.statusCode = 400;
    throw error;
  }
  const examDurationMinutes = parseExamDurationMinutes(examDurationMinutesRaw, { required: true });
  const assessmentPolicy = buildAssessmentPolicy({
    assessmentMode,
    examType,
    gradingPeriod,
    assignmentScope,
  });

  const aiConfig = getAiRuntimeConfig();
  const configurationStatus = getAiConfigurationStatus(aiConfig);

  if (!aiConfig.isEnabled) {
    const error = new Error('AI generator is currently disabled by server configuration.');
    error.statusCode = 403;
    throw error;
  }
  if (!configurationStatus.canGenerate) {
    const error = new Error(configurationStatus.configurationMessage || 'AI generator is not available.');
    error.statusCode = 422;
    throw error;
  }

  const { ownerTeacher, lesson } = await resolveAssessmentOwnerContext(req, lessonId, teacherId);
  const selectedClass = !lessonId && subjectId
    ? {
      _id: String(subjectId),
      id: String(subjectId),
      name: String(subject || ownerTeacher?.subject || '').trim(),
      className: String(topic || '').trim(),
      code: '',
      track: normalizeStrand(ownerTeacher?.strand || '') || 'GENERAL',
    }
    : null;
  if (!lessonId && !selectedClass) {
    const error = new Error('Selected class was not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedTopic = String(topic || '').trim();
  const normalizedSubject = String(subject || lesson?.subject || selectedClass?.name || ownerTeacher?.subject || ownerTeacher?.department || '').trim();
  if (!normalizedSubject) {
    const error = new Error('subject is required');
    error.statusCode = 400;
    throw error;
  }
  if (String(req.user?.role || '').trim().toLowerCase() === ROLE_TEACHER) {
    const teacherSubject = String(ownerTeacher?.subject || '').trim();
    if (teacherSubject && normalizedSubject !== teacherSubject) {
      const error = new Error(`You can only generate exams for your assigned subject: ${teacherSubject}`);
      error.statusCode = 403;
      throw error;
    }
  }
  const lessonStrand = normalizeStrand(lesson?.track || selectedClass?.track || ownerTeacher?.strand || '');
  if (lessonStrand && !isSubjectAllowedForStrand({ strand: lessonStrand, subject: normalizedSubject })) {
    const allowedSubjects = getSubjectsByStrand(lessonStrand);
    const error = new Error(`subject is invalid for strand ${lessonStrand}. Allowed subjects: ${allowedSubjects.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  const submissionDeadline = assertFutureSubmissionDeadline(
    submissionDeadlineRaw ?? deadlineRaw ?? deadlineAtRaw
  );

  let extractedText = '';
  const sourceTitle = String(
    lesson?.title
    || normalizedTopic
    || title
    || selectedClass?.className
    || selectedClass?.name
    || 'Assessment Topic'
  ).trim();

  if (lesson) {
    const lessonPdfPath = resolveLessonPdfPath(lesson);
    if (!lessonPdfPath) {
      const error = new Error('No PDF attachment found for the lesson');
      error.statusCode = 400;
      throw error;
    }
    const lessonFileBuffer = await readStoredFileBuffer(lessonPdfPath);
    extractedText = await extractTextFromPdf(lessonFileBuffer);

    if (!extractedText || extractedText.trim().length < 50) {
      const error = new Error('Unable to extract enough text from the lesson PDF for AI generation');
      error.statusCode = 400;
      throw error;
    }
  } else {
    if (!normalizedTopic) {
      const error = new Error('topic is required when generating without a linked lesson');
      error.statusCode = 400;
      throw error;
    }
    extractedText = [
      `Topic: ${normalizedTopic}`,
      `Subject: ${normalizedSubject}`,
      selectedClass?.className ? `Class: ${selectedClass.className}` : '',
      selectedClass?.code ? `Class Code: ${selectedClass.code}` : '',
      title ? `Assessment Title: ${String(title).trim()}` : '',
      'Generate questions aligned to this class context and topic.',
    ].filter(Boolean).join('\n');
  }

  const runtimeTemplate = aiConfig.promptTemplate
    || 'You are an exam generator. Generate {{numberOfItems}} questions. Difficulty: {{difficulty}}. Exam type: {{examType}}.';
  const promptHeader = runtimeTemplate
    .replace(/\{\{numberOfItems\}\}/g, String(Number(numberOfItems)))
    .replace(/\{\{difficulty\}\}/g, String(difficulty))
    .replace(/\{\{examType\}\}/g, String(examType))
    .replace(/\{\{lessonTitle\}\}/g, sourceTitle || 'Lesson');
  const prompt = `${promptHeader}
Return ONLY valid JSON with this format:
{
  "title": "string",
  "questions": [
    {
      "questionText": "string",
      "type": "multiple-choice|true-false|short-answer",
      "options": ["string"],
      "correctAnswer": "string",
      "points": 1,
      "explanation": "string"
    }
  ]
}
${lesson ? 'Lesson text:' : 'Topic and class context:'}
${extractedText.slice(0, 15000)}`;
  let generationMode = `${aiConfig.provider || 'provider'}-api`;
  let parsedTitle = '';
  let sanitizedQuestions = [];

  try {
    const rawOutput = await requestAiOutput({ config: aiConfig, prompt });
    const targetCount = Number(numberOfItems);
    let parsed = parseJsonPayload(rawOutput);
    let repairedOutput = '';

    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      const repairPrompt = `Convert the following draft into STRICT valid JSON only.
Return exactly:
{
  "title": "string",
  "questions": [
    {
      "questionText": "string",
      "type": "multiple-choice|true-false|short-answer",
      "options": ["string"],
      "correctAnswer": "string",
      "points": 1,
      "explanation": "string"
    }
  ]
}
Keep exactly ${targetCount} questions.
Draft:
${String(rawOutput || '').slice(0, 12000)}`;
      repairedOutput = await requestAiOutput({ config: aiConfig, prompt: repairPrompt });
      parsed = parseJsonPayload(repairedOutput);
    }

    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      const looseQuestions = extractQuestionsFromLooseText(rawOutput, targetCount, examType);
      const repairedLooseQuestions = looseQuestions.length > 0
        ? looseQuestions
        : extractQuestionsFromLooseText(repairedOutput, targetCount, examType);
      if (repairedLooseQuestions.length > 0) {
        parsed = {
          title: String(title || `${sourceTitle} - ${examType}`).trim(),
          questions: repairedLooseQuestions,
        };
      }
    }

    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      const error = new Error('Provider returned an invalid assessment payload.');
      error.statusCode = 502;
      error.code = 'INVALID_PROVIDER_PAYLOAD';
      throw error;
    }

    sanitizedQuestions = parsed.questions
      .slice(0, Number(numberOfItems))
      .map((question, index) => sanitizeQuestion(question, index));
    parsedTitle = String(parsed.title || '').trim();

  } catch (providerError) {
    const rawMessage = String(providerError?.message || '');
    const providerErrorCode = String(providerError?.code || '').trim().toUpperCase();
    const isInvalidPayloadError = providerErrorCode === 'INVALID_PROVIDER_PAYLOAD'
      || /invalid assessment payload/i.test(rawMessage)
      || /malformed json payload/i.test(rawMessage);

    if (isInvalidPayloadError) {
      sanitizedQuestions = buildLocalQuestions({
        lessonTitle: sourceTitle,
        examType,
        difficulty,
        numberOfItems,
        sourceText: extractedText,
      });
      parsedTitle = String(title || `${sourceTitle} - ${examType}`).trim();
      generationMode = 'provider-local-fallback';

      // Continue request lifecycle using deterministic local fallback questions.
    }
    if (!isInvalidPayloadError) {
      const isJsonSyntaxError = providerError?.name === 'SyntaxError'
        || /Expected\s+'.*'\s+after/i.test(rawMessage)
        || /JSON/i.test(rawMessage)
        || /position\s+\d+/i.test(rawMessage);
      const error = new Error(
        isJsonSyntaxError
          ? 'Provider returned malformed JSON payload. Please retry generation.'
          : (rawMessage || 'AI provider generation failed')
      );
      error.statusCode = providerError?.statusCode || 502;
      throw error;
    }
  }

  const normalizedTitle = String(title || parsedTitle || `${sourceTitle} - ${examType}`).trim();
  const normalizedSubjectCategory = resolveAssessmentSubjectCategory({
    subjectCategory: subjectCategory || getSubjectCategory(normalizedSubject),
    examType,
    title: normalizedTitle,
    lessonTrack: lesson?.track || selectedClass?.track || ownerTeacher?.strand || '',
  });

  return sendSuccess(res, 200, 'Assessment draft generated successfully', {
    draftAssessment: {
      title: normalizedTitle,
      lessonId: lessonId || '',
      subjectId: String(selectedClass?._id || subjectId || ''),
      examType,
      subject: normalizedSubject,
      subjectCategory: normalizedSubjectCategory,
      difficulty,
      numberOfItems: Number(numberOfItems),
      examDurationMinutes,
      submissionDeadline: submissionDeadline || null,
      assessmentMode: assessmentPolicy.assessmentMode,
      gradingPeriod: assessmentPolicy.gradingPeriod,
      countsTowardRecommendation: assessmentPolicy.countsTowardRecommendation,
      assignmentScope: assessmentPolicy.assignmentScope,
      teacherId: String(ownerTeacher?._id || req.user?._id || ''),
      questions: sanitizedQuestions,
    },
    generationMode,
    usedPaidAi: true,
  });
});

module.exports = {
  getAiStatus,
  generateAssessmentWithAi,
};
