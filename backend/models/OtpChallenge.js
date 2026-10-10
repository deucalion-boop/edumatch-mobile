const mongoose = require('mongoose');

const otpChallengeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  challengeTokenHash: { type: String, required: true, unique: true, index: true },
  otpHash: { type: String, required: true, select: false },
  remember: { type: Boolean, default: false },
  ipAddress: { type: String, default: '', maxlength: 120 },
  userAgent: { type: String, default: '', maxlength: 500 },
  failedAttempts: { type: Number, default: 0, min: 0 },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
