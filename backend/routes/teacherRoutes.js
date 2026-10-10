const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const { lessonUpload, uploadProfileImage, uploadTeacherAssessmentFiles } = require('../utils/uploadMiddleware');
const {
  createTeacherClass,
  updateTeacherClass,
  deleteTeacherClass,
  createLesson,
  getTeacherLessons,
  updateTeacherLesson,
  copyTeacherLessonToClasses,
  getTeacherSubjects,
  getTeacherAssessments,
  updateTeacherAssessment,
  copyTeacherAssessmentToClasses,
  downloadTeacherLessonPdf,
  downloadTeacherLessonAttachment,
  createAssessment,
  updateAssessmentQuestions,
  getAssessmentResultsSummary,
  getTeacherStudents,
  createStudentInvite,
  getTeacherSubjectStudents,
  removeTeacherSubjectStudent,
  getTeacherStudentAssessmentResults,
  reviewActivitySubmission,
  getSubjectAssessmentWeights,
  updateSubjectAssessmentWeights,
  getEnrollmentRequests,
  approveEnrollmentRequest,
  rejectEnrollmentRequest,
  getTeacherProfile,
  updateTeacherProfile,
  updateTeacherTourPreference,
} = require('../controllers/teacherController');
const { getAiStatus, generateAssessmentWithAi } = require('../controllers/aiController');
const {
  getTeacherAttendanceRoster,
  listTeacherAttendanceRecords,
  saveTeacherAttendance,
  lockTeacherAttendance,
} = require('../controllers/attendanceController');
const { getSectionDirectory } = require('../controllers/sectionController');
const { aiLimiter, inviteLimiter, uploadLimiter } = require('../middlewares/rateLimiters');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('teacher'));

router.post(
  '/lessons',
  uploadLimiter,
  lessonUpload.fields([{ name: 'lessonPlanFile', maxCount: 1 }]),
  createLesson
);
router.post('/subjects', createTeacherClass);
router.post('/subjects/:subjectId/announcements', require('../controllers/studentAnnouncementController').publishAnnouncement);
router.get('/lessons', getTeacherLessons);
router.patch('/lessons/:id', updateTeacherLesson);
router.post('/lessons/:id/classes', copyTeacherLessonToClasses);
router.get('/subjects', getTeacherSubjects);
router.patch('/subjects/:subjectId', updateTeacherClass);
router.delete('/subjects/:subjectId', deleteTeacherClass);
router.get('/sections', getSectionDirectory);
router.get('/lessons/:id/download', downloadTeacherLessonPdf);
router.get('/lessons/:id/attachments/:attachmentId/download', downloadTeacherLessonAttachment);

router.post(
  '/assessments',
  uploadLimiter,
  uploadTeacherAssessmentFiles.fields([{ name: 'attachments', maxCount: 10 }]),
  createAssessment
);
router.get('/assessments', getTeacherAssessments);
router.patch(
  '/assessments/:id',
  uploadLimiter,
  uploadTeacherAssessmentFiles.fields([{ name: 'attachments', maxCount: 10 }]),
  updateTeacherAssessment
);
router.post('/assessments/:id/classes', copyTeacherAssessmentToClasses);
router.put('/assessments/:id/questions', updateAssessmentQuestions);
router.get('/assessments/:id/results', getAssessmentResultsSummary);
router.get('/students', getTeacherStudents);
router.post('/students', inviteLimiter, createStudentInvite);
router.get('/subjects/:subjectId/students', getTeacherSubjectStudents);
router.delete('/subjects/:subjectId/students/:studentId', removeTeacherSubjectStudent);
router.get('/students/assessment-results', getTeacherStudentAssessmentResults);
router.patch('/activities/:assessmentId/submissions/:submissionId/review', reviewActivitySubmission);
router.patch('/assessments/:assessmentId/submissions/:submissionId/review', reviewActivitySubmission);
router.get('/subjects/:subjectId/assessment-weights', getSubjectAssessmentWeights);
router.patch('/subjects/:subjectId/assessment-weights', updateSubjectAssessmentWeights);
router.get('/enrollment-requests', getEnrollmentRequests);
router.patch('/enrollment-requests/:studentId/accept', approveEnrollmentRequest);
router.patch('/enrollment-requests/:studentId/reject', rejectEnrollmentRequest);
router.get('/attendance/roster', getTeacherAttendanceRoster);
router.get('/attendance', listTeacherAttendanceRecords);
router.post('/attendance', saveTeacherAttendance);
router.patch('/attendance/:id/lock', lockTeacherAttendance);
router.get('/profile', getTeacherProfile);
router.put('/profile', uploadLimiter, uploadProfileImage.single('profileImage'), updateTeacherProfile);
router.patch('/tour-preference', updateTeacherTourPreference);

router.get('/ai/status', getAiStatus);
router.post('/assessments/ai-generate', aiLimiter, generateAssessmentWithAi);

module.exports = router;
