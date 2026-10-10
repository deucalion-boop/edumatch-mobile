const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    actorName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    actorEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      maxlength: 200,
    },
    actorRole: {
      type: String,
      default: '',
      trim: true,
      maxlength: 50,
      index: true,
    },
    actorIdentifier: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
      index: true,
    },
    category: {
      type: String,
      default: 'System',
      trim: true,
      maxlength: 80,
      index: true,
    },
    actionLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    method: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 10,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
      index: true,
    },
    routePath: {
      type: String,
      default: '',
      trim: true,
      maxlength: 220,
    },
    targetId: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
      index: true,
    },
    targetLabel: {
      type: String,
      default: '',
      trim: true,
      maxlength: 220,
    },
    succeeded: {
      type: Boolean,
      default: false,
      index: true,
    },
    statusCode: {
      type: Number,
      default: 0,
      index: true,
    },
    ipAddress: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
      index: true,
    },
    userAgent: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    durationMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    metadata: {
      params: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      query: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
      bodyKeys: {
        type: [String],
        default: [],
      },
      fileCount: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ succeeded: 1, createdAt: -1 });
auditLogSchema.index({ method: 1, createdAt: -1 });
auditLogSchema.index({ actorRole: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
