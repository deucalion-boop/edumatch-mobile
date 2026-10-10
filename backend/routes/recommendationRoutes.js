const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const roleMiddleware = require('../middlewares/roleMiddleware');
const { getRecommendation, recomputeRecommendation } = require('../controllers/recommendationController');

const router = express.Router();

router.use(authMiddleware, roleMiddleware('student', 'teacher', 'admin'));
router.get('/:studentId', getRecommendation);
router.post('/recompute/:studentId', recomputeRecommendation);

module.exports = router;
