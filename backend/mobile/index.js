'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { captchaPage } = require('./lib/captcha');
const { publicUser, identityAuth } = require('./lib/profile');
const { createDashboardService } = require('./lib/dashboard');
const { createAttendanceService } = require('./lib/attendance');
const { createDeviceService } = require('./lib/devices');

function loadExistingBackend(backendRoot) {
  const requireBackend = createRequire(path.join(path.resolve(backendRoot), 'package.json'));
  return {
    express: requireBackend('express'),
    authMiddleware: requireBackend('./middlewares/authMiddleware'),
    client: requireBackend('./services/supabaseStorageService').getSupabaseStorageClient(),
    resolveStoredFileUrl: requireBackend('./utils/fileStorage').resolveStoredFileUrl,
    controllers: {
      admin: requireBackend('./controllers/adminController'), secretary: requireBackend('./controllers/secretaryController'),
      headteacher: requireBackend('./controllers/headteacherController'), teacher: requireBackend('./controllers/teacherController'),
      student: requireBackend('./controllers/studentController'), notifications: requireBackend('./controllers/notificationController'),
    },
  };
}

function createMobileRouter(options) {
  const { express, authMiddleware, client, resolveStoredFileUrl, controllers } = options;
  const router = express.Router();
  const attendance = createAttendanceService(client);
  const devices = createDeviceService(client, options.projectId || process.env.EXPO_PROJECT_ID);
  const dashboard = createDashboardService(controllers);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const send = (res, result, status = 200) => res.status(status).json({ success: true, ...result });

  router.get('/captcha', captchaPage);
  router.get('/me', identityAuth(authMiddleware), wrap(async (req, res) =>
    send(res, { user: publicUser(req.user, req, resolveStoredFileUrl) })));
  router.use(authMiddleware);
  router.get('/bootstrap', wrap(async (req, res) => send(res, {
    user: publicUser(req.user, req, resolveStoredFileUrl), dashboard: await dashboard(req),
  })));
  router.post('/devices', wrap(async (req, res) => send(res, await devices.register(req.user, req.body || {}, req.session))));
  router.delete('/devices/:installationId', wrap(async (req, res) => send(res, await devices.unregister(req.user, req.params.installationId, req.session))));
  router.get('/attendance/sessions', wrap(async (req, res) => send(res, await attendance.list(req.user, req.query))));
  router.post('/attendance/sessions', wrap(async (req, res) => send(res, await attendance.create(req.user, req.body || {}), 201)));
  router.get('/attendance/sessions/:id', wrap(async (req, res) => send(res, await attendance.detail(req.user, req.params.id))));
  router.post('/attendance/sessions/:id/rotate', wrap(async (req, res) => send(res, await attendance.rotate(req.user, req.params.id))));
  router.post('/attendance/sessions/:id/finalize', wrap(async (req, res) => send(res, await attendance.finalize(req.user, req.params.id, req.body || {}))));
  router.post('/attendance/sessions/:id/cancel', wrap(async (req, res) => send(res, await attendance.cancel(req.user, req.params.id))));
  router.post('/attendance/scan', wrap(async (req, res) => send(res, await attendance.scan(req.user, req.body || {}))));
  return router;
}

module.exports = { createMobileRouter, loadExistingBackend };
