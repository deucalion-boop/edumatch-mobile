const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenId: { type: String, required: true, unique: true, index: true },
  ipAddress: { type: String, default: '', maxlength: 120 },
  userAgent: { type: String, default: '', maxlength: 500 },
  remember: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  revokedAt: { type: Date, default: null, index: true },
  revokedReason: { type: String, default: '', maxlength: 120 },
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);
