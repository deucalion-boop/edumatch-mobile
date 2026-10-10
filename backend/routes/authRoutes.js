const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const {
  login,
  verifyLoginOtp,
  resendLoginOtp,
  syncPresence,
  validateInvite,
  completeInvite,
  requestPasswordReset,
  validatePasswordReset,
  completePasswordReset,
} = require('../controllers/authController');
const { changePassword } = require('../controllers/passwordController');
const { inviteLimiter, loginLimiter, passwordResetLimiter } = require('../middlewares/rateLimiters');
const { listSessions, logout, revokeSession } = require('../controllers/securityController');

const router = express.Router();

router.post('/login', loginLimiter, login);
router.post('/login/verify-otp', loginLimiter, verifyLoginOtp);
router.post('/login/resend-otp', loginLimiter, resendLoginOtp);
router.post('/presence', authMiddleware, syncPresence);
router.post('/change-password', authMiddleware, changePassword);
router.get('/invite/:token', inviteLimiter, validateInvite);
router.post('/invite/:token/complete', inviteLimiter, completeInvite);
router.post('/forgot-password', passwordResetLimiter, requestPasswordReset);
router.get('/reset/:token', passwordResetLimiter, validatePasswordReset);
router.post('/reset/:token/complete', passwordResetLimiter, completePasswordReset);
router.post('/logout', authMiddleware, logout);
router.get('/sessions', authMiddleware, listSessions);
router.delete('/sessions/:id', authMiddleware, revokeSession);

module.exports = router;
