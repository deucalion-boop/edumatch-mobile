const mongoose = require('mongoose');

const loginAttemptSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    username: {
      type: String,
      default: '',
      trim: true,
      index: true,
      maxlength: 120,
    },
    name: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      index: true,
      maxlength: 200,
    },
    role: {
      type: String,
      default: '',
      trim: true,
      index: true,
      maxlength: 50,
    },
    outcome: {
      type: String,
      enum: ['success', 'failed'],
      required: true,
      index: true,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    ipAddress: {
      type: String,
      default: '',
      trim: true,
      index: true,
      maxlength: 120,
    },
    userAgent: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  }
);

loginAttemptSchema.index({ createdAt: -1 });
loginAttemptSchema.index({ outcome: 1, createdAt: -1 });
loginAttemptSchema.index({ role: 1, createdAt: -1 });

module.exports = mongoose.model('LoginAttempt', loginAttemptSchema);
