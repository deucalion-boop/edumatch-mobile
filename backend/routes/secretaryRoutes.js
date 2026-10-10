const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const {
  getDirectory,
  getStudentRecords,
  getArchivedStudentRecords,
  getArchivedPdfExportRequestStatus,
  requestArchivedPdfExport,
  consumeArchivedPdfExportApproval,
  endSchoolYearArchiveStudents,
} = require('../controllers/secretaryController');
const { getSecretaryAttendanceOverview } = require('../controllers/attendanceController');
const { getSectionDirectory } = require('../controllers/sectionController');
const { uploadProfileImage } = require('../utils/uploadMiddleware');
const { inviteLimiter, uploadLimiter } = require('../middlewares/rateLimiters');
const {
  createUser,
  sendUserMessage,
  sendUserInvite,
  getUsers,
  getUserById,
  updateUser,
  deleteUser,
} = require('../controllers/adminController');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('secretary'));

router.get('/directory', getDirectory);
router.route('/users').post(createUser).get(getUsers);
router.route('/users/:id').get(getUserById).put(uploadLimiter, uploadProfileImage.single('profileImage'), updateUser).delete(deleteUser);
router.post('/users/:id/messages', sendUserMessage);
router.post('/users/:id/send-invite', inviteLimiter, sendUserInvite);
router.get('/sections', getSectionDirectory);
router.get('/students/archived', getArchivedStudentRecords);
router.get('/students/archived/export-requests/current', getArchivedPdfExportRequestStatus);
router.post('/students/archived/export-requests', requestArchivedPdfExport);
router.post('/students/archived/export-requests/:id/consume', consumeArchivedPdfExportApproval);
router.post('/students/end-school-year', endSchoolYearArchiveStudents);
router.get('/students', getStudentRecords);
router.get('/attendance', getSecretaryAttendanceOverview);

module.exports = router;
