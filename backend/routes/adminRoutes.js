const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const { uploadProfileImage } = require('../utils/uploadMiddleware');
const {
  createUser,
  sendUserMessage,
  getAuditLogs,
  getLoginAttempts,
  getArchivedPdfExportRequests,
  reviewArchivedPdfExportRequest,
  sendUserInvite,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
  saveSecuritySettings,
  getSecuritySettings,
  getSystemSettings,
  saveSystemSettings,
  clearSystemCache,
  getRawSettingsDebug,
  getAnalytics,
  getAiUsage,
} = require('../controllers/adminController');
const { getAdminAttendanceReport } = require('../controllers/attendanceController');
const { getSectionDirectory } = require('../controllers/sectionController');
const { accountSecurityLimiter, inviteLimiter, uploadLimiter } = require('../middlewares/rateLimiters');
const { getAdminProfile, updateAdminProfile } = require('../controllers/adminProfileController');
const { getAdminOtpSettings, saveAdminOtpSettings } = require('../controllers/adminSecurityController');
const { getCaptchaSettings, saveCaptchaSettings } = require('../controllers/captchaSettingsController');
const {
  getStudentAccountRequests,
  reviewStudentAccountRequest,
} = require('../controllers/studentSettingsController');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('admin'));

router.get('/profile', getAdminProfile);
router.put('/profile', uploadLimiter, uploadProfileImage.single('profileImage'), updateAdminProfile);
router.get('/settings/otp', getAdminOtpSettings);
router.put('/settings/otp', accountSecurityLimiter, saveAdminOtpSettings);
router.get('/settings/captcha', getCaptchaSettings);
router.put('/settings/captcha', accountSecurityLimiter, saveCaptchaSettings);
// Preserve existing endpoint URLs for clients upgrading to math CAPTCHA.
router.get('/settings/recaptcha', getCaptchaSettings);
router.put('/settings/recaptcha', accountSecurityLimiter, saveCaptchaSettings);

router.route('/users').post(createUser).get(getUsers);
router.route('/users/:id').get(getUserById).put(uploadLimiter, uploadProfileImage.single('profileImage'), updateUser).delete(deleteUser);
router.post('/users/:id/messages', sendUserMessage);
router.get('/audit-logs', getAuditLogs);
router.get('/login-attempts', getLoginAttempts);
router.get('/export-requests/archived-pdf', getArchivedPdfExportRequests);
router.patch('/export-requests/:id/review', reviewArchivedPdfExportRequest);
router.get('/student-account-requests', getStudentAccountRequests);
router.patch('/student-account-requests/:id/review', reviewStudentAccountRequest);
router.post('/users/:id/send-invite', inviteLimiter, sendUserInvite);
router.get('/analytics', getAnalytics);
router.get('/ai-usage', getAiUsage);
router.get('/attendance/report', getAdminAttendanceReport);
router.get('/sections', getSectionDirectory);
router.get('/settings/security', getSecuritySettings);
router.put('/settings/security', saveSecuritySettings);
router.get('/settings/system', getSystemSettings);
router.put('/settings/system', saveSystemSettings);
router.post('/settings/system/clear-cache', clearSystemCache);
router.get('/debug/settings/raw', getRawSettingsDebug);

module.exports = router;
