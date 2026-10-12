'use strict';

const express = require('express');
const { captchaChallengeLimiter, captchaVerifyLimiter } = require('../middlewares/rateLimiters');
const captcha = require('../services/mathCaptchaService');

const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/challenge', captchaChallengeLimiter, wrap(async (req, res) => {
  const result = await captcha.issueChallenge(req.query.action || 'login');
  res.json({ success: true, ...result });
}));

router.post('/verify', captchaVerifyLimiter, wrap(async (req, res) => {
  const result = await captcha.verifyChallenge(req.body || {});
  if (!result) {
    return res.status(400).json({ success: false, message: 'Incorrect, expired or already used CAPTCHA. Refresh the question and try again.' });
  }
  return res.json({ success: true, ...result });
}));

module.exports = router;
