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
} = require('../controllers/adminController');
const { getAdminAttendanceReport } = require('../controllers/attendanceController');
const { getSectionDirectory } = require('../controllers/sectionController');
const { inviteLimiter, uploadLimiter } = require('../middlewares/rateLimiters');
const {
  getStudentAccountRequests,
  reviewStudentAccountRequest,
} = require('../controllers/studentSettingsController');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('admin'));

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
router.get('/attendance/report', getAdminAttendanceReport);
router.get('/sections', getSectionDirectory);
router.get('/settings/security', getSecuritySettings);
router.put('/settings/security', saveSecuritySettings);
router.get('/settings/system', getSystemSettings);
router.put('/settings/system', saveSystemSettings);
router.post('/settings/system/clear-cache', clearSystemCache);
router.get('/debug/settings/raw', getRawSettingsDebug);

module.exports = router;
