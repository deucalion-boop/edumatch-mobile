const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const { uploadProfileImage, uploadStudentSubmissionFiles } = require('../utils/uploadMiddleware');
const {
  getMySubjects,
  joinSubjectByCode,
  getStudentLessons,
  updateStudentLessonProgress,
  getStudentTeachers,
  downloadStudentLessonPdf,
  downloadStudentLessonAttachment,
  getAvailableAssessments,
  getAssessmentForExam,
  startAssessmentSession,
  saveAssessmentProgress,
  logAssessmentActivity,
  submitAssessment,
  getMySubmissions,
  getMyActivitySubmissions,
  saveActivityResponseDraft,
  turnInActivityResponse,
  unsubmitActivityResponse,
  getStudentProfile,
  updateStudentProfile,
  updateStudentTourPreference,
} = require('../controllers/studentController');
const {
  getStudentAttendanceHistory,
} = require('../controllers/attendanceController');

const router = express.Router();
const { uploadLimiter } = require('../middlewares/rateLimiters');
const {
  getMyAccountRequest,
  getMySettings,
  submitMyAccountRequest,
  updateMySettings,
} = require('../controllers/studentSettingsController');

router.use(authMiddleware, roleMiddleware('student'));

router.get('/profile', getStudentProfile);
router.put('/profile', uploadLimiter, uploadProfileImage.single('profileImage'), updateStudentProfile);
router.patch('/tour-preference', updateStudentTourPreference);
router.get('/settings', getMySettings);
router.put('/settings', updateMySettings);
router.get('/account-requests/current', getMyAccountRequest);
router.post('/account-requests', submitMyAccountRequest);
router.get('/subjects', getMySubjects);
router.post('/subjects/join', joinSubjectByCode);
router.get('/attendance', getStudentAttendanceHistory);
router.get('/lessons', getStudentLessons);
router.patch('/lessons/:id/progress', updateStudentLessonProgress);
router.get('/teachers', getStudentTeachers);
router.get('/lessons/:id/download', downloadStudentLessonPdf);
router.get('/lessons/:id/attachments/:attachmentId/download', downloadStudentLessonAttachment);
router.get('/assessments', getAvailableAssessments);
router.get('/assessments/:id', getAssessmentForExam);
router.post('/assessments/:id/start', startAssessmentSession);
router.patch('/assessments/:id/progress', saveAssessmentProgress);
router.post('/assessments/:id/activity', logAssessmentActivity);
router.post('/assessments/:id/submissions', submitAssessment);
router.get('/submissions/me', getMySubmissions);
router.get('/activity-submissions', getMyActivitySubmissions);
router.post('/assessments/:id/activity-response/draft', uploadLimiter, uploadStudentSubmissionFiles.fields([{ name: 'attachments', maxCount: 5 }]), saveActivityResponseDraft);
router.post('/assessments/:id/activity-response/submit', uploadLimiter, uploadStudentSubmissionFiles.fields([{ name: 'attachments', maxCount: 5 }]), turnInActivityResponse);
router.post('/assessments/:id/activity-response/unsubmit', unsubmitActivityResponse);

module.exports = router;
