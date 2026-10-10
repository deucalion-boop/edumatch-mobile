const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const {
  getMyNotifications,
  markAllNotificationsViewed,
  markNotificationViewed,
  clearAllNotifications,
} = require('../controllers/notificationController');

const router = express.Router();

router.use(authMiddleware);
router.get('/', getMyNotifications);
router.get('/announcements', require('../controllers/studentAnnouncementController').listAnnouncements);
router.get('/announcement', require('../controllers/studentAnnouncementController').getAnnouncement);
router.delete('/', clearAllNotifications);
router.patch('/view-all', markAllNotificationsViewed);
router.patch('/:id/view', markNotificationViewed);

module.exports = router;
