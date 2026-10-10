const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    questionIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    answer: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    _id: false,
  }
);

const activityLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    occurredAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);

const submissionAttachmentSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    storedPath: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      default: 'application/octet-stream',
      trim: true,
    },
    extension: {
      type: String,
      default: '',
      trim: true,
    },
    size: {
      type: Number,
      default: 0,
      min: 0,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

const submissionLinkSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

const submissionSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    assessmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assessment',
      required: true,
      index: true,
    },
    answers: {
      type: [answerSchema],
      default: [],
    },
    score: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    totalPoints: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: null,
    },
    examDurationMinutes: {
      type: Number,
      min: 1,
      max: 300,
      default: 30,
    },
    violationCount: {
      type: Number,
      min: 0,
      default: 0,
    },
    activityLog: {
      type: [activityLogSchema],
      default: [],
    },
    responseText: {
      type: String,
      default: '',
      trim: true,
    },
    attachments: {
      type: [submissionAttachmentSchema],
      default: [],
    },
    linkAttachments: {
      type: [submissionLinkSchema],
      default: [],
    },
    draftSavedAt: {
      type: Date,
      default: null,
    },
    gradedAt: {
      type: Date,
      default: null,
    },
    gradeValue: {
      type: Number,
      default: null,
      min: 0,
    },
    teacherFeedback: {
      type: String,
      default: '',
      trim: true,
    },
    aiEvaluations: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    aiScore: { type: Number, default: null, min: 0 },
    teacherAdjustedScore: { type: Number, default: null, min: 0 },
    scoringStatus: {
      type: String,
      enum: ['final', 'ai_assisted', 'pending_teacher_review', 'teacher_approved', 'teacher_overridden'],
      default: 'final',
    },
    isLate: {
      type: Boolean,
      default: false,
    },
    returnedAt: {
      type: Date,
      default: null,
    },
    autoSubmitted: {
      type: Boolean,
      default: false,
    },
    terminationReason: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['in_progress', 'completed', 'auto_submitted', 'terminated', 'returned_for_revision'],
      default: 'completed',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

submissionSchema.index({ studentId: 1, assessmentId: 1 }, { unique: true });

module.exports = mongoose.model('Submission', submissionSchema);
