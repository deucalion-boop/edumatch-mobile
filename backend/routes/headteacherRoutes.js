const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const { lessonUpload } = require('../utils/uploadMiddleware');
const {
  getManagedTeachers,
  createTeacherAccount,
  createStudentAccount,
  updateManagedTeacher,
  getManagedTeacherStudents,
  getManagedTeacherLessons,
  createManagedTeacherLesson,
  getManagedTeacherAssessments,
  createManagedTeacherAssessment,
  updateManagedTeacherAssessment,
  sendManagedTeacherAnnouncement,
} = require('../controllers/headteacherController');
const { getAiStatus, generateAssessmentWithAi } = require('../controllers/aiController');
const { getHeadTeacherAttendanceOverview } = require('../controllers/attendanceController');
const { getSectionDirectory } = require('../controllers/sectionController');
const { aiLimiter, inviteLimiter, uploadLimiter } = require('../middlewares/rateLimiters');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('headteacher'));

router.get('/teachers', getManagedTeachers);
router.get('/sections', getSectionDirectory);
router.get('/teachers/:id/students', getManagedTeacherStudents);
router.get('/attendance', getHeadTeacherAttendanceOverview);
router.get('/lessons', getManagedTeacherLessons);
router.post('/lessons', uploadLimiter, lessonUpload.fields([{ name: 'lessonPlanFile', maxCount: 1 }]), createManagedTeacherLesson);
router.get('/assessments', getManagedTeacherAssessments);
router.post('/assessments', createManagedTeacherAssessment);
router.put('/assessments/:id', updateManagedTeacherAssessment);
router.get('/ai/status', getAiStatus);
router.post('/assessments/ai-generate', aiLimiter, generateAssessmentWithAi);
router.post('/teachers', inviteLimiter, createTeacherAccount);
router.post('/students', inviteLimiter, createStudentAccount);
router.put('/teachers/:id', updateManagedTeacher);
router.post('/teachers/:id/announcements', sendManagedTeacherAnnouncement);

module.exports = router;
