const OpenAI = require('openai');
const Settings = require('../models/Settings');
const Submission = require('../models/Submission');
const Recommendation = require('../models/Recommendation');
const { getSubjectCategory } = require('../constants/strandSubjects');
const {
  GRADING_PERIODS,
  normalizeGradingPeriod,
  gradingPeriodOrder,
} = require('../constants/assessmentConfig');
const { getAiRuntimeConfigFromEnv } = require('../utils/aiRuntimeConfig');
const { isRecommendationAssessment } = require('./assessmentPolicyService');

const SUBJECT_CATEGORIES = ['Math', 'Science', 'English', 'AP', 'Business', 'Technical'];
const FINAL_SUBMISSION_STATUSES = ['completed', 'auto_submitted', 'terminated'];
const DEFAULT_EVENT_NAME = 'Strand Recommendation Updated';
const NO_RECOMMENDATION_MESSAGE = 'Complete the 1st, 2nd, and 3rd grading assessments to generate recommendation';
const RECOMMENDATION_IN_PROGRESS_MESSAGE = 'Recommendation In Progress. Complete the remaining grading assessments to unlock your strand recommendation.';
const RECOMMENDATION_ENCOURAGEMENT_MESSAGE = "Hi there! It looks like you're exploring your interests and strengths. You've shown potential in Math, Science, and English, which are all great skills to build on. The STEM strand is a great fit for you because it combines these subjects, and you'll have the chance to develop problem-solving and critical thinking skills. This strand matches you because it plays to your strengths and can help you grow in areas you enjoy.";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toPercent(score, total) {
  const safeScore = Number(score || 0);
  const safeTotal = Number(total || 0);
  if (!Number.isFinite(safeScore) || !Number.isFinite(safeTotal) || safeTotal <= 0) return 0;
  return clamp(Number(((safeScore / safeTotal) * 100).toFixed(2)), 0, 100);
}

function normalizeSubjectCategory(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'math' || raw === 'mathematics') return 'Math';
  if (raw === 'science') return 'Science';
  if (raw === 'english') return 'English';
  if (raw === 'ap' || raw.includes('araling') || raw.includes('panlipunan') || raw.includes('social')) return 'AP';
  if (raw === 'business' || raw.includes('finance') || raw.includes('account')) return 'Business';
  if (raw === 'technical' || raw.includes('practical') || raw.includes('hands-on') || raw.includes('handson')) return 'Technical';
  return '';
}

function inferSubjectCategory({ subjectCategory, subject, examType, title, lessonTrack } = {}) {
  const direct = normalizeSubjectCategory(subjectCategory);
  if (direct) return direct;
  const fromSubject = normalizeSubjectCategory(getSubjectCategory(subject));
  if (fromSubject) return fromSubject;

  const haystack = [examType, title, lessonTrack].map((item) => String(item || '').toLowerCase()).join(' ');
  if (/(math|algebra|geometry|calculus|statistics|trigonometry|numerical|logic)/i.test(haystack)) return 'Math';
  if (/(science|biology|chemistry|physics|earth science|research)/i.test(haystack)) return 'Science';
  if (/(english|grammar|reading|literature|communication|writing)/i.test(haystack)) return 'English';
  if (/(ap|araling panlipunan|social studies|history|civics|humanities)/i.test(haystack)) return 'AP';
  if (/(business|finance|economics|accounting|entrepreneur)/i.test(haystack)) return 'Business';
  if (/(technical|tvl|programming|coding|welding|cookery|automotive|electronics|skills|practical)/i.test(haystack)) return 'Technical';
  if (/(abm)/i.test(haystack)) return 'Business';
  if (/(humss)/i.test(haystack)) return 'AP';
  if (/(stem)/i.test(haystack)) return 'Science';
  return 'Technical';
}

function getAttemptWeight(index) {
  return Math.max(0.35, 1 - (index * 0.03));
}

function computeCategoryScores(attempts) {
  const totals = new Map();
  const weights = new Map();

  attempts.forEach((attempt, index) => {
    const category = normalizeSubjectCategory(attempt.subjectCategory) || 'Technical';
    const percentage = clamp(Number(attempt.percentage || 0), 0, 100);
    const recencyWeight = getAttemptWeight(index);
    totals.set(category, Number(totals.get(category) || 0) + (percentage * recencyWeight));
    weights.set(category, Number(weights.get(category) || 0) + recencyWeight);
  });

  const categoryScores = {};
  SUBJECT_CATEGORIES.forEach((category) => {
    const total = Number(totals.get(category) || 0);
    const weight = Number(weights.get(category) || 0);
    categoryScores[category] = weight > 0 ? clamp(Number((total / weight).toFixed(2)), 0, 100) : 0;
  });

  return categoryScores;
}

function computeSubjectPerformance(attempts) {
  const grouped = new Map();

  attempts.forEach((attempt) => {
    const key = String(attempt.subjectId || `${attempt.subjectName}:${attempt.subjectCode || ''}`).trim();
    if (!key) return;

    const current = grouped.get(key) || {
      subjectId: attempt.subjectId || null,
      subjectName: String(attempt.subjectName || '').trim(),
      subjectCode: String(attempt.subjectCode || '').trim(),
      subjectCategory: normalizeSubjectCategory(attempt.subjectCategory) || 'Technical',
      percentages: [],
      latestCompletedAt: null,
    };

    current.percentages.push(clamp(Number(attempt.percentage || 0), 0, 100));
    const completedAt = attempt.completedAt ? new Date(attempt.completedAt) : null;
    if (completedAt && !Number.isNaN(completedAt.getTime())) {
      if (!current.latestCompletedAt || completedAt.getTime() > new Date(current.latestCompletedAt).getTime()) {
        current.latestCompletedAt = completedAt;
      }
    }

    grouped.set(key, current);
  });

  return [...grouped.values()]
    .map((item) => {
      const completedAssessments = item.percentages.length;
      const averageScore = completedAssessments
        ? clamp(Number((item.percentages.reduce((sum, value) => sum + value, 0) / completedAssessments).toFixed(2)), 0, 100)
        : 0;
      return {
        subjectId: item.subjectId,
        subjectName: item.subjectName,
        subjectCode: item.subjectCode,
        subjectCategory: item.subjectCategory,
        completedAssessments,
        averageScore,
        progress: averageScore,
        latestCompletedAt: item.latestCompletedAt,
      };
    })
    .sort((left, right) => {
      const latestDelta = new Date(right.latestCompletedAt || 0).getTime() - new Date(left.latestCompletedAt || 0).getTime();
      if (latestDelta !== 0) return latestDelta;
      return Number(right.averageScore || 0) - Number(left.averageScore || 0);
    });
}

function computeStrandScores(categoryScores) {
  const safe = (category, fallback = 0) => clamp(Number(categoryScores?.[category] ?? fallback), 0, 100);
  const rawScores = {
    STEM: (safe('Math') * 0.45) + (safe('Science') * 0.4) + (safe('Technical') * 0.15),
    HUMSS: (safe('English') * 0.45) + (safe('AP') * 0.45) + (safe('Science') * 0.1),
    ABM: (safe('Business') * 0.5) + (safe('Math') * 0.35) + (safe('English') * 0.15),
    TVL: (safe('Technical') * 0.7) + (safe('Science') * 0.15) + (safe('Math') * 0.15),
  };

  return {
    STEM: clamp(Number(rawScores.STEM.toFixed(2)), 0, 100),
    HUMSS: clamp(Number(rawScores.HUMSS.toFixed(2)), 0, 100),
    ABM: clamp(Number(rawScores.ABM.toFixed(2)), 0, 100),
    TVL: clamp(Number(rawScores.TVL.toFixed(2)), 0, 100),
  };
}

function computeConfidence({ attemptsCount, topScore, secondScore }) {
  const spread = Number((topScore - secondScore).toFixed(2));
  if (!Number.isFinite(spread) || spread <= 3) return 'Low';
  if (spread <= 9) return 'Medium';
  return 'High';
}

function getCompletedGradingPeriods(assessmentAttempts) {
  const uniquePeriods = new Set(
    (Array.isArray(assessmentAttempts) ? assessmentAttempts : [])
      .map((attempt) => String(attempt?.gradingPeriod || '').trim())
      .filter(Boolean)
  );
  return GRADING_PERIODS.filter((period) => uniquePeriods.has(period));
}

function getMissingGradingPeriods(completedPeriods) {
  const completed = new Set(Array.isArray(completedPeriods) ? completedPeriods : []);
  return GRADING_PERIODS.filter((period) => !completed.has(period));
}

function computeRecommendationProgress({ assessmentAttempts, isRecommendationReady }) {
  const completedPeriods = getCompletedGradingPeriods(assessmentAttempts);
  if (completedPeriods.length <= 0) return 0;
  if (isRecommendationReady) return 100;
  return clamp(Math.round((completedPeriods.length / GRADING_PERIODS.length) * 100), 0, 99);
}

function buildRecommendationFromGradeRecords(records = []) {
  const gradeRecords = Array.isArray(records) ? records : [];
  const evidenceRecords = gradeRecords.map((record) => {
    const periodGrades = [record?.p1, record?.p2, record?.p3]
      .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
      .map(Number);
    const evidenceGrade = record?.finalGrade !== null && record?.finalGrade !== undefined
      ? Number(record.finalGrade)
      : (periodGrades.length ? Number((periodGrades.reduce((sum, value) => sum + value, 0) / periodGrades.length).toFixed(2)) : null);
    return { ...record, evidenceGrade };
  }).filter((record) => record.evidenceGrade !== null);

  const categoryBuckets = new Map();
  evidenceRecords.forEach((record) => {
    const category = normalizeSubjectCategory(record.subjectCategory)
      || inferSubjectCategory({ subject: record.subjectName, subjectCategory: record.subjectCategory });
    const values = categoryBuckets.get(category) || [];
    values.push(record.evidenceGrade);
    categoryBuckets.set(category, values);
  });
  const categoryScores = Object.fromEntries(SUBJECT_CATEGORIES.map((category) => {
    const values = categoryBuckets.get(category) || [];
    return [category, values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0];
  }));
  const strandScores = computeStrandScores(categoryScores);
  const rankedStrands = Object.entries(strandScores).sort((left, right) => Number(right[1]) - Number(left[1]));
  const completedGradingPeriods = GRADING_PERIODS.filter((period, index) => (
    gradeRecords.length > 0 && gradeRecords.every((record) => record?.[`p${index + 1}`] !== null && record?.[`p${index + 1}`] !== undefined)
  ));
  const completedSlots = gradeRecords.reduce((total, record) => total + Number(record?.completedPeriods || 0), 0);
  const requiredSlots = gradeRecords.length * GRADING_PERIODS.length;
  const isRecommendationReady = gradeRecords.length > 0
    && evidenceRecords.length > 0
    && completedSlots === requiredSlots;
  const recommendationProgressPercent = requiredSlots > 0
    ? Math.min(isRecommendationReady ? 100 : 99, Math.round(completedSlots / requiredSlots * 100))
    : 0;
  const recommendedName = isRecommendationReady ? String(rankedStrands[0]?.[0] || '') : '';
  const confidence = isRecommendationReady ? computeConfidence({
    attemptsCount: completedSlots,
    topScore: Number(rankedStrands[0]?.[1] || 0),
    secondScore: Number(rankedStrands[1]?.[1] || 0),
  }) : null;

  return {
    gradeRecords,
    subjectPerformance: evidenceRecords.map((record) => ({
      subjectId: record.subjectId,
      subjectName: record.subjectName,
      subjectCode: record.subjectCode,
      subjectCategory: record.subjectCategory,
      p1: record.p1,
      p2: record.p2,
      p3: record.p3,
      finalGrade: record.finalGrade,
      averageScore: record.evidenceGrade,
      completedAssessments: record.completedPeriods,
      latestCompletedAt: record.latestGradedAt,
    })),
    strandScores,
    requiredGradingPeriods: GRADING_PERIODS,
    completedGradingPeriods,
    missingGradingPeriods: GRADING_PERIODS.filter((period) => !completedGradingPeriods.includes(period)),
    assessmentAttemptsCount: completedSlots,
    recommendationProgressPercent,
    recommendationStatus: isRecommendationReady ? 'ready' : (completedSlots > 0 ? 'in_progress' : 'not_started'),
    isRecommendationReady,
    recommendedStrand: isRecommendationReady
      ? { name: recommendedName, confidence, generatedAt: new Date().toISOString(), topTwoStrands: rankedStrands.slice(0, 2).map(([name]) => name) }
      : { name: '', confidence: null, generatedAt: null, topTwoStrands: [] },
    confidence,
    recommendationExplanation: isRecommendationReady
      ? `The ranking uses the complete P1, P2, P3, and Final Grade records for ${gradeRecords.length} subject${gradeRecords.length === 1 ? '' : 's'}.`
      : RECOMMENDATION_IN_PROGRESS_MESSAGE,
  };
}

function fallbackExplanation({ recommendedStrand, confidence, topCategories, topTwoStrands, attemptsCount }) {
  return RECOMMENDATION_ENCOURAGEMENT_MESSAGE;
}

function shouldReplaceLegacyExplanation(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized.startsWith('hi there! as your academic guidance assistant')
    || normalized.includes('remember, this is just a recommendation')
    || normalized.includes("ultimately, the decision is yours");
}

function buildStoredRecommendationFallback(recommendation) {
  return RECOMMENDATION_ENCOURAGEMENT_MESSAGE;
}

async function requestAiExplanation({ prompt, settings }) {
  const envConfig = getAiRuntimeConfigFromEnv();
  const provider = envConfig.provider;
  const model = envConfig.model;
  const apiKey = envConfig.apiKey;
  const isEnabled = envConfig.isEnabled;
  if (!isEnabled || !provider || !model || !apiKey) return '';

  const temperature = Number(envConfig.temperature ?? 0.2);
  const maxTokens = Number(envConfig.maxTokens || 350);
  const baseUrl = String(envConfig.baseUrl || '').trim();

  if (provider === 'gemini') {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: Math.min(512, maxTokens),
        },
      }),
    });
    if (!response.ok) return '';
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => String(part?.text || '')).join('\n') || '';
    return text.trim();
  }

  if (provider === 'huggingface') {
    const endpoint = `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: Math.min(256, maxTokens),
          temperature,
        },
      }),
    });
    if (!response.ok) return '';
    const payload = await response.json();
    if (Array.isArray(payload) && payload[0]?.generated_text) return String(payload[0].generated_text).trim();
    return String(payload?.generated_text || '').trim();
  }

  if (provider === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: Math.min(512, maxTokens),
      }),
    });
    if (!response.ok) return '';
    const payload = await response.json();
    return String(payload?.choices?.[0]?.message?.content || '').trim();
  }

  const openAiBaseUrl = provider === 'openai' ? (baseUrl || 'https://api.openai.com/v1') : baseUrl;
  const client = new OpenAI({ apiKey, baseURL: openAiBaseUrl || undefined });
  const aiResponse = await client.responses.create({
    model,
    input: prompt,
    temperature,
    max_output_tokens: Math.min(512, maxTokens),
  });
  return String(aiResponse?.output_text || '').trim();
}

async function buildRecommendationExplanation(input) {
  return RECOMMENDATION_ENCOURAGEMENT_MESSAGE;
}

async function loadAssessmentAttempts(studentId) {
  const submissions = await Submission.find({
    studentId,
    status: { $in: FINAL_SUBMISSION_STATUSES },
  })
    .populate({
      path: 'assessmentId',
      select: 'subjectId subject subjectCode subjectCategory examType title numberOfItems questions lessonId assessmentMode gradingPeriod countsTowardRecommendation',
      populate: { path: 'lessonId', select: 'track title subject subjectId subjectCode' },
    })
    .sort({ submittedAt: -1, createdAt: -1 })
    .lean();

  const latestByGradingPeriod = new Map();
  for (const row of submissions) {
    const assessment = row?.assessmentId;
    if (!assessment?._id || !isRecommendationAssessment(assessment)) continue;
    const gradingPeriod = String(assessment?.gradingPeriod || '').trim();
    if (!gradingPeriod || latestByGradingPeriod.has(gradingPeriod)) continue;
    const subjectCategory = inferSubjectCategory({
      subjectCategory: assessment.subjectCategory,
      subject: assessment.subject,
      examType: assessment.examType,
      title: assessment.title,
      lessonTrack: assessment?.lessonId?.track || assessment?.lessonId?.title || '',
    });
    const totalItems = Number(
      Array.isArray(assessment?.questions) && assessment.questions.length > 0
        ? assessment.questions.length
        : assessment?.numberOfItems || row?.totalPoints || 0
    );
    const percentage = toPercent(row?.score, row?.totalPoints);
    latestByGradingPeriod.set(gradingPeriod, {
      assessmentId: assessment._id,
      assessmentTitle: String(assessment.title || '').trim(),
      subjectId: assessment.subjectId || assessment?.lessonId?.subjectId || null,
      subjectName: String(assessment.subject || assessment?.lessonId?.subject || '').trim(),
      subjectCode: String(assessment.subjectCode || assessment?.lessonId?.subjectCode || '').trim(),
      subjectCategory,
      score: Number(row?.score || 0),
      totalItems: Math.max(0, totalItems),
      percentage,
      gradingPeriod,
      completedAt: row?.submittedAt || row?.createdAt || new Date(),
    });
  }

  return [...latestByGradingPeriod.values()]
    .sort((left, right) => gradingPeriodOrder(right.gradingPeriod) - gradingPeriodOrder(left.gradingPeriod))
    .slice(0, GRADING_PERIODS.length);
}

function formatRecommendationPayload(recommendation) {
  const assessmentAttempts = (Array.isArray(recommendation?.assessmentAttempts)
    ? recommendation.assessmentAttempts
    : [])
    .filter((attempt) => Boolean(normalizeGradingPeriod(attempt?.gradingPeriod)))
    .map((attempt) => ({
      ...(typeof attempt?.toObject === 'function' ? attempt.toObject() : attempt),
      gradingPeriod: normalizeGradingPeriod(attempt?.gradingPeriod),
    }));
  const attemptsCount = assessmentAttempts.length;
  const subjectPerformance = computeSubjectPerformance(assessmentAttempts);
  const strandScores = computeStrandScores(computeCategoryScores(assessmentAttempts));
  const rankedStrands = Object.entries(strandScores)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  const completedGradingPeriods = getCompletedGradingPeriods(assessmentAttempts);
  const missingGradingPeriods = getMissingGradingPeriods(completedGradingPeriods);
  const isRecommendationReady = completedGradingPeriods.length === GRADING_PERIODS.length
    && subjectPerformance.length > 0
    && Number(rankedStrands[0]?.[1] || 0) > 0;
  const recommendedName = isRecommendationReady ? String(rankedStrands[0]?.[0] || '') : '';
  const topTwoStrands = isRecommendationReady
    ? rankedStrands.slice(0, 2).map(([name]) => name)
    : [];
  const confidence = isRecommendationReady
    ? computeConfidence({
      attemptsCount,
      topScore: Number(rankedStrands[0]?.[1] || 0),
      secondScore: Number(rankedStrands[1]?.[1] || 0),
    })
    : null;
  const recommendationProgressPercent = computeRecommendationProgress({
    assessmentAttempts,
    isRecommendationReady,
  });

  return {
    studentId: String(recommendation?.studentId || ''),
    assessmentAttempts,
    subjectPerformance,
    strandScores,
    requiredGradingPeriods: GRADING_PERIODS,
    completedGradingPeriods,
    missingGradingPeriods,
    recommendedStrand: isRecommendationReady
      ? {
        name: recommendedName,
        confidence,
        generatedAt: recommendation?.recommendedStrand?.generatedAt || null,
        topTwoStrands,
      }
      : {
        name: '',
        confidence: null,
        generatedAt: null,
        topTwoStrands: [],
      },
    confidence,
    recommendationExplanation: attemptsCount <= 0
      ? NO_RECOMMENDATION_MESSAGE
      : (isRecommendationReady ? RECOMMENDATION_ENCOURAGEMENT_MESSAGE : RECOMMENDATION_IN_PROGRESS_MESSAGE),
    updatedAt: recommendation?.updatedAt || null,
    lastReason: recommendation?.lastReason || '',
    assessmentAttemptsCount: attemptsCount,
    recommendationProgressPercent,
    recommendationStatus: isRecommendationReady ? 'ready' : (attemptsCount > 0 ? 'in_progress' : 'not_started'),
    isRecommendationReady,
  };
}

async function recomputeStudentRecommendation({ studentId, reason = 'New assessment completed' }) {
  const normalizedStudentId = String(studentId || '').trim();
  if (!normalizedStudentId) {
    const error = new Error('studentId is required');
    error.statusCode = 400;
    throw error;
  }

  const assessmentAttempts = await loadAssessmentAttempts(normalizedStudentId);
  const categoryScores = computeCategoryScores(assessmentAttempts);
  const subjectPerformance = computeSubjectPerformance(assessmentAttempts);
  const strandScores = computeStrandScores(categoryScores);

  const rankedStrands = Object.entries(strandScores)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([name, score]) => ({ name, score: Number(score) }));

  const topStrand = rankedStrands[0] || { name: 'TVL', score: 0 };
  const secondStrand = rankedStrands[1] || { name: topStrand.name, score: topStrand.score };
  const confidence = computeConfidence({
    attemptsCount: assessmentAttempts.length,
    topScore: topStrand.score,
    secondScore: secondStrand.score,
  });
  const topTwoStrands = [topStrand.name, secondStrand.name];
  const topCategories = Object.entries(categoryScores)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([label, score]) => ({ label, score: Number(score) }));
  const completedGradingPeriods = getCompletedGradingPeriods(assessmentAttempts);
  const hasEnoughData = completedGradingPeriods.length === GRADING_PERIODS.length
    && subjectPerformance.length > 0
    && Number(topStrand.score || 0) > 0;
  const recommendationExplanation = assessmentAttempts.length <= 0
    ? NO_RECOMMENDATION_MESSAGE
    : (hasEnoughData
    ? await buildRecommendationExplanation({
      recommendedStrand: topStrand.name,
      confidence,
      strandScores,
      topCategories,
      topTwoStrands,
      attemptsCount: assessmentAttempts.length,
    })
    : RECOMMENDATION_IN_PROGRESS_MESSAGE);

  const now = new Date();
  const recordsUpdate = {
    event: DEFAULT_EVENT_NAME,
    reason: String(reason || 'Recommendation recomputed'),
    timestamp: now,
  };

  const updated = await Recommendation.findOneAndUpdate(
    { studentId: normalizedStudentId },
    {
      $set: {
        studentId: normalizedStudentId,
        assessmentAttempts,
        subjectPerformance,
        strandScores,
        recommendedStrand: {
          name: hasEnoughData ? topStrand.name : null,
          confidence: hasEnoughData ? confidence : null,
          generatedAt: hasEnoughData ? now : null,
          topTwoStrands: hasEnoughData ? topTwoStrands : [],
        },
        recommendationExplanation,
        lastReason: recordsUpdate.reason,
      },
      $push: {
        records: {
          $each: [recordsUpdate],
          $slice: -100,
        },
      },
    },
    {
      upsert: true,
      returnDocument: 'after',
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  ).lean();

  return updated;
}

module.exports = {
  SUBJECT_CATEGORIES,
  NO_RECOMMENDATION_MESSAGE,
  normalizeSubjectCategory,
  inferSubjectCategory,
  buildRecommendationFromGradeRecords,
  formatRecommendationPayload,
  recomputeStudentRecommendation,
};
