const path = require('path');

require('dotenv').config({
  path: [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '.env.local'),
  ],
  quiet: true,
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const User = require('./models/User');
const Lesson = require('./models/Lesson');
const Assessment = require('./models/Assessment');
const Submission = require('./models/Submission');
const Settings = require('./models/Settings');
const Subject = require('./models/Subject');
const UserModel = require('./models/User');
const SubjectEnrollment = require('./models/SubjectEnrollment');
const Section = require('./models/Section');
const Recommendation = require('./models/Recommendation');
const Session = require('./models/Session');
const OtpChallenge = require('./models/OtpChallenge');
const authRoutes = require('./routes/authRoutes');
const captchaRoutes = require('./routes/captchaRoutes');
const adminRoutes = require('./routes/adminRoutes');
const userRoutes = require('./routes/userRoutes');
const teacherRoutes = require('./routes/teacherRoutes');
const studentRoutes = require('./routes/studentRoutes');
const headteacherRoutes = require('./routes/headteacherRoutes');
const secretaryRoutes = require('./routes/secretaryRoutes');
const storageRoutes = require('./routes/storageRoutes');
const recommendationRoutes = require('./routes/recommendationRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const auditLogMiddleware = require('./middlewares/auditLogMiddleware');
const { notFoundMiddleware, errorMiddleware } = require('./middlewares/errorMiddleware');
const { validateMailApiEnvironment } = require('./services/gmailService');
const { ensureDefaultSections } = require('./services/sectionService');
const { isSupabaseStorageConfigured, getSupabaseStorageConfig } = require('./services/supabaseStorageService');
const { apiLimiter, redisReady } = require('./middlewares/rateLimiters');
const { ensureDefaultSupabaseAdmin } = require('./services/supabaseAccountService');
const { resolveTrustProxy, validateRuntimeSecurity } = require('./utils/securityConfig');
const { verifyPrivateStorageBucket } = require('./services/supabaseStorageService');

const app = express();
const PORT = process.env.PORT || 5000;
const DEFAULT_ADMIN_NAME = String(process.env.ADMIN_NAME || 'EduMatch Administrator').trim() || 'EduMatch Administrator';
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@edumatch.local').trim().toLowerCase() || 'admin@edumatch.local';
const DEFAULT_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = new Set(
  String(process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);
if (!isProduction) {
  allowedOrigins.add('http://localhost:5173');
  allowedOrigins.add('http://127.0.0.1:5173');
}

app.set('trust proxy', resolveTrustProxy());
const supabaseOrigin = (() => {
  try {
    const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
    return configuredUrl ? new URL(configuredUrl).origin : '';
  } catch (_error) {
    return '';
  }
})();
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      imgSrc: ["'self'", 'data:', 'blob:', ...(supabaseOrigin ? [supabaseOrigin] : [])],
      mediaSrc: ["'self'", 'data:', 'blob:', ...(supabaseOrigin ? [supabaseOrigin] : [])],
      connectSrc: ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(String(origin).replace(/\/+$/, ''))) return callback(null, true);
    const error = new Error('Origin is not allowed by CORS');
    error.statusCode = 403;
    return callback(error);
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
}));
// Both `node server.js` and imported Express hosts must complete the same
// startup checks before handling requests. Concurrent cold-start requests share it.
app.use((_req, _res, next) => {
  initializeApplication().then(() => next(), next);
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  const safePath = String(req.path || '')
    .replace(/\/(invite|reset)\/[^/]+/gi, '/$1/[REDACTED]');
  console.log(`[HTTP] ${req.method} ${safePath}`);
  next();
});

app.use('/api', apiLimiter);
app.use('/api', auditLogMiddleware);
// Local uploads are served only through the expiring signed storage route.

app.get('/api/health', (_req, res) => {
  res.status(200).json({ success: true, message: 'EduMatch backend is running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/captcha', captchaRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/headteacher', headteacherRoutes);
app.use('/api/secretary', secretaryRoutes);
app.use('/api/recommendation', recommendationRoutes);
app.use('/api/notifications', notificationRoutes);

// EduMatch mobile extension (managed by edumatch-mobile).
const { createMobileRouter, loadExistingBackend } = require('./mobile');
app.use('/api/mobile', createMobileRouter(loadExistingBackend(__dirname)));
// End EduMatch mobile extension.

app.use(notFoundMiddleware);
app.use(errorMiddleware);

function dedupeIdsByCreatedAt(entries) {
  const sorted = [...entries].sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  const keeper = sorted[0];
  const duplicates = sorted.slice(1);
  return { keeper, duplicates };
}

async function cleanupDuplicateData() {
  console.log('[CLEANUP] Checking for duplicate records...');

  const duplicateUsersByEmail = await User.aggregate([
    {
      $project: {
        emailKey: { $toLower: { $trim: { input: '$email' } } },
        createdAt: 1,
      },
    },
    {
      $group: {
        _id: '$emailKey',
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', createdAt: '$createdAt' } },
      },
    },
    { $match: { _id: { $ne: '' }, count: { $gt: 1 } } },
  ]);

  for (const group of duplicateUsersByEmail) {
    const { keeper, duplicates } = dedupeIdsByCreatedAt(group.docs);
    const duplicateIds = duplicates.map((doc) => doc._id);
    if (duplicateIds.length === 0) continue;

    await Promise.all([
      Lesson.updateMany({ createdBy: { $in: duplicateIds } }, { $set: { createdBy: keeper._id } }),
      Assessment.updateMany({ createdBy: { $in: duplicateIds } }, { $set: { createdBy: keeper._id } }),
      Submission.updateMany({ studentId: { $in: duplicateIds } }, { $set: { studentId: keeper._id } }),
      User.updateMany({ 'enrollment.teacherId': { $in: duplicateIds } }, { $set: { 'enrollment.teacherId': keeper._id } }),
      User.deleteMany({ _id: { $in: duplicateIds } }),
    ]);
  }

  const duplicateLessons = await Lesson.aggregate([
    {
      $project: {
        createdBy: 1,
        createdAt: 1,
        titleKey: { $toLower: { $trim: { input: '$title' } } },
        trackKey: { $toLower: { $trim: { input: '$track' } } },
      },
    },
    {
      $group: {
        _id: {
          createdBy: '$createdBy',
          titleKey: '$titleKey',
          trackKey: '$trackKey',
        },
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', createdAt: '$createdAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const group of duplicateLessons) {
    const { keeper, duplicates } = dedupeIdsByCreatedAt(group.docs);
    const duplicateIds = duplicates.map((doc) => doc._id);
    if (duplicateIds.length === 0) continue;
    await Assessment.updateMany({ lessonId: { $in: duplicateIds } }, { $set: { lessonId: keeper._id } });
    await Lesson.deleteMany({ _id: { $in: duplicateIds } });
  }

  const duplicateAssessments = await Assessment.aggregate([
    {
      $project: {
        createdAt: 1,
        createdBy: 1,
        lessonId: 1,
        examTypeKey: { $toLower: { $trim: { input: '$examType' } } },
        titleKey: { $toLower: { $trim: { input: '$title' } } },
      },
    },
    {
      $group: {
        _id: {
          createdBy: '$createdBy',
          lessonId: '$lessonId',
          examTypeKey: '$examTypeKey',
          titleKey: '$titleKey',
        },
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', createdAt: '$createdAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const group of duplicateAssessments) {
    const { keeper, duplicates } = dedupeIdsByCreatedAt(group.docs);
    const duplicateIds = duplicates.map((doc) => doc._id);
    if (duplicateIds.length === 0) continue;
    await Submission.deleteMany({ assessmentId: { $in: duplicateIds } });
    await Assessment.deleteMany({ _id: { $in: duplicateIds } });
  }

  const duplicateSubmissions = await Submission.aggregate([
    {
      $group: {
        _id: {
          studentId: '$studentId',
          assessmentId: '$assessmentId',
        },
        count: { $sum: 1 },
        docs: { $push: { _id: '$_id', createdAt: '$createdAt', submittedAt: '$submittedAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const group of duplicateSubmissions) {
    const sorted = [...group.docs].sort(
      (a, b) => new Date(b.submittedAt || b.createdAt || 0).getTime() - new Date(a.submittedAt || a.createdAt || 0).getTime()
    );
    const duplicateIds = sorted.slice(1).map((doc) => doc._id);
    if (duplicateIds.length > 0) {
      await Submission.deleteMany({ _id: { $in: duplicateIds } });
    }
  }

  console.log('[CLEANUP] Duplicate cleanup completed.');
}

async function ensureDefaultAdminAccount() {
  await ensureDefaultSupabaseAdmin({
    name: DEFAULT_ADMIN_NAME,
    email: DEFAULT_ADMIN_EMAIL,
    username: DEFAULT_ADMIN_USERNAME,
    password: DEFAULT_ADMIN_PASSWORD,
  });
  console.log('[BOOTSTRAP] Administrator account is available; existing accounts are preserved.');
}

async function cleanupLegacyAiSettingsFields() {
  const result = await Settings.updateMany(
    {
      $or: [
        { aiGeneratorEnabled: { $exists: true } },
        { aiConfig: { $exists: true } },
        { openaiApiKey: { $exists: true } },
        { openaiModel: { $exists: true } },
        { 'aiConfig.provider': { $exists: true } },
        { 'aiConfig.model': { $exists: true } },
        { 'aiConfig.baseUrl': { $exists: true } },
        { 'aiConfig.apiKeyEncrypted': { $exists: true } },
      ],
    },
    {
      $unset: {
        aiGeneratorEnabled: '',
        aiConfig: '',
        openaiApiKey: '',
        openaiModel: '',
        'aiConfig.provider': '',
        'aiConfig.model': '',
        'aiConfig.baseUrl': '',
        'aiConfig.apiKeyEncrypted': '',
      },
    }
  );

  const modifiedCount = Number(result?.modifiedCount || 0);
  if (modifiedCount > 0) {
    console.log(`[CLEANUP] Removed legacy AI fields from ${modifiedCount} settings document(s).`);
  } else {
    console.log('[CLEANUP] No legacy AI fields found in settings.');
  }
}

async function listCollectionIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (error?.code === 26 || /ns not found/i.test(String(error?.message || ''))) {
      return [];
    }
    throw error;
  }
}

async function dropIndexIfConflicting(model, indexName, isExpectedDefinition) {
  const indexes = await listCollectionIndexes(model);
  const existingIndex = indexes.find((index) => index?.name === indexName);
  if (!existingIndex) return;
  if (isExpectedDefinition(existingIndex)) return;

  await model.collection.dropIndex(indexName);
  console.log(`[BOOTSTRAP] Dropped stale ${model.modelName}.${indexName} index so the updated definition can be applied.`);
}

async function reconcileCriticalIndexes() {
  await dropIndexIfConflicting(
    UserModel,
    'advisorySectionId_1',
    (index) => index?.key?.advisorySectionId === 1
      && index?.unique === true
      && index?.partialFilterExpression?.advisorySectionId?.$exists === true
  );

  await dropIndexIfConflicting(
    Section,
    'name_1',
    (index) => index?.key?.name === 1 && index?.unique === true
  );
}

async function syncApplicationIndexes() {
  const indexedModels = [
    Settings,
    UserModel,
    Lesson,
    Assessment,
    Submission,
    Subject,
    SubjectEnrollment,
    Section,
    Recommendation,
    Session,
    OtpChallenge,
  ];

  for (const model of indexedModels) {
    await model.syncIndexes();
  }

  console.log('[BOOTSTRAP] Application indexes synced.');
}

let applicationReady;

function initializeApplication() {
  if (!applicationReady) {
    applicationReady = prepareApplication().catch((error) => {
      applicationReady = undefined;
      error.statusCode = 503;
      throw error;
    });
  }
  return applicationReady;
}

async function prepareApplication() {
  validateRuntimeSecurity();

  console.log(`[ENV] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`[ENV] PORT=${PORT}`);
  const mailValidation = validateMailApiEnvironment();
  if (!mailValidation.ok) {
    console.warn(`[MAIL] ${mailValidation.reason}`);
  } else {
    console.log(`[MAIL] API endpoint configured: ${mailValidation.mailApiUrl}`);
  }
  if (isSupabaseStorageConfigured()) {
    const storageConfig = getSupabaseStorageConfig();
    console.log(`[STORAGE] Using Supabase Storage bucket "${storageConfig.bucket}" (${storageConfig.bucketPublic ? 'public' : 'private'}).`);
  } else {
    console.log('[STORAGE] Using local uploads in backend/uploads.');
  }

  await redisReady;
  await verifyPrivateStorageBucket();
  await ensureDefaultAdminAccount();
}

async function bootstrap() {
  await initializeApplication();
  return app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error.message);
  process.exit(1);
});

module.exports = app;
module.exports.app = app;
module.exports.bootstrap = bootstrap;
