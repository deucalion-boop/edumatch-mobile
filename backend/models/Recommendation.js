const mongoose = require('mongoose');
const { GRADING_PERIODS } = require('../constants/assessmentConfig');

const STRANDS = ['STEM', 'HUMSS', 'ABM', 'TVL'];
const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low'];
const SUBJECT_CATEGORIES = ['Math', 'Science', 'English', 'AP', 'Business', 'Technical'];

const assessmentAttemptSchema = new mongoose.Schema(
  {
    assessmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assessment',
      required: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: null,
      index: true,
    },
    subjectName: {
      type: String,
      default: '',
      trim: true,
    },
    subjectCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    subjectCategory: {
      type: String,
      enum: SUBJECT_CATEGORIES,
      required: true,
      trim: true,
    },
    score: {
      type: Number,
      required: true,
      min: 0,
    },
    totalItems: {
      type: Number,
      required: true,
      min: 0,
    },
    percentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    completedAt: {
      type: Date,
      required: true,
    },
    gradingPeriod: {
      type: String,
      enum: ['', ...GRADING_PERIODS],
      default: '',
      trim: true,
    },
    assessmentTitle: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    _id: false,
  }
);

const subjectPerformanceSchema = new mongoose.Schema(
  {
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: null,
      index: true,
    },
    subjectName: {
      type: String,
      default: '',
      trim: true,
    },
    subjectCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    subjectCategory: {
      type: String,
      enum: SUBJECT_CATEGORIES,
      default: 'Technical',
    },
    completedAssessments: {
      type: Number,
      default: 0,
      min: 0,
    },
    averageScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    latestCompletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

const recommendationLogSchema = new mongoose.Schema(
  {
    event: {
      type: String,
      default: 'Strand Recommendation Updated',
      trim: true,
    },
    reason: {
      type: String,
      default: '',
      trim: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);

const recommendationSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    assessmentAttempts: {
      type: [assessmentAttemptSchema],
      default: [],
    },
    subjectPerformance: {
      type: [subjectPerformanceSchema],
      default: [],
    },
    strandScores: {
      STEM: { type: Number, default: 0, min: 0, max: 100 },
      HUMSS: { type: Number, default: 0, min: 0, max: 100 },
      ABM: { type: Number, default: 0, min: 0, max: 100 },
      TVL: { type: Number, default: 0, min: 0, max: 100 },
    },
    recommendedStrand: {
      name: {
        type: String,
        enum: STRANDS,
        default: null,
      },
      confidence: {
        type: String,
        enum: CONFIDENCE_LEVELS,
        default: null,
      },
      generatedAt: {
        type: Date,
        default: null,
      },
      topTwoStrands: {
        type: [String],
        enum: STRANDS,
        default: [],
      },
    },
    recommendationExplanation: {
      type: String,
      default: '',
      trim: true,
    },
    lastReason: {
      type: String,
      default: '',
      trim: true,
    },
    records: {
      type: [recommendationLogSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Recommendation', recommendationSchema);
