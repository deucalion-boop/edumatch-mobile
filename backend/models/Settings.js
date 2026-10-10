const mongoose = require('mongoose');

const backupHistoryEntrySchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true, trim: true },
    generatedAt: { type: Date, required: true, default: Date.now },
    collectionCount: { type: Number, default: 0, min: 0 },
    sizeBytes: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
    },
    security: {
      sessionTimeoutMinutes: {
        type: Number,
        default: 120,
        min: 5,
        max: 1440,
      },
      maxLoginAttempts: {
        type: Number,
        default: 5,
        min: 3,
        max: 10,
      },
      accountLockoutDurationMinutes: {
        type: Number,
        default: 30,
        min: 1,
        max: 1440,
      },
    },
    user: {
      emailVerificationRequired: {
        type: Boolean,
        default: true,
      },
    },
    maintenance: {
      maintenanceModeEnabled: {
        type: Boolean,
        default: false,
      },
      maintenanceMessage: {
        type: String,
        default: 'The system is currently under maintenance. Please check back later.',
        trim: true,
        maxlength: 500,
      },
      systemVersion: {
        type: String,
        default: 'v1.0.0',
        trim: true,
        maxlength: 50,
      },
      lastBackupAt: {
        type: Date,
        default: null,
      },
      lastBackupFileName: {
        type: String,
        default: '',
        trim: true,
      },
      backupHistory: {
        type: [backupHistoryEntrySchema],
        default: [],
      },
      lastCacheClearedAt: {
        type: Date,
        default: null,
      },
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Settings', settingsSchema);
