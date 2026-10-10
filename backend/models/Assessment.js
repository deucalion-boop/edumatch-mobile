const mongoose = require('mongoose');
const {
  GRADING_PERIODS,
  ASSESSMENT_MODES,
  ASSIGNMENT_SCOPES,
} = require('../constants/assessmentConfig');
const SUBJECT_CATEGORIES = ['Math', 'Science', 'English', 'AP', 'Business', 'Technical'];
const TOS_LEARNING_AREAS = ['Language and Communication', 'Mathematics and Quantitative Reasoning', 'Science and Scientific Reasoning', 'Social Science and Humanities', 'Business and Entrepreneurship', 'Technology and Practical/Vocational Reasoning'];
const BLOOM_LEVELS = ['Remembering', 'Understanding', 'Applying', 'Analyzing', 'Evaluating', 'Creating'];

const questionSchema = new mongoose.Schema(
  {
    questionText: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['multiple-choice', 'true-false', 'short-answer', 'essay'],
      default: 'multiple-choice',
    },
    options: {
      type: [String],
      default: [],
    },
    correctAnswer: {
      type: String,
      default: '',
    },
    points: {
      type: Number,
      default: 1,
      min: 0,
    },
    explanation: {
      type: String,
      default: '',
      trim: true,
    },
    instructions: { type: String, default: '', trim: true },
    expectedAnswer: { type: String, default: '', trim: true },
    rubric: { type: String, default: '', trim: true },
    learningArea: { type: String, enum: ['', ...TOS_LEARNING_AREAS], default: '' },
    competency: { type: String, default: '', trim: true, maxlength: 300 },
    cognitiveLevel: { type: String, enum: ['', ...BLOOM_LEVELS], default: '' },
    minWords: { type: Number, default: null, min: 0, max: 10000 },
    maxWords: { type: Number, default: null, min: 1, max: 10000 },
  },
  {
    _id: false,
  }
);

const assessmentAttachmentSchema = new mongoose.Schema(
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
      lowercase: true,
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

const assessmentSchema = new mongoose.Schema(
  {
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson',
      default: null,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    examType: {
      type: String,
      required: true,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: null,
      index: true,
    },
    subjectCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
      index: true,
    },
    subjectCategory: {
      type: String,
      enum: SUBJECT_CATEGORIES,
      default: 'Technical',
      trim: true,
      index: true,
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },
    numberOfItems: {
      type: Number,
      required: true,
      min: 1,
    },
    activityPoints: {
      type: Number,
      default: null,
      min: 1,
      max: 100,
    },
    allowedSubmissionTypes: {
      type: [String],
      enum: ['written', 'link', 'file'],
      default: ['written', 'link', 'file'],
    },
    allowResubmission: {
      type: Boolean,
      default: true,
    },
    allowLateSubmissions: {
      type: Boolean,
      default: false,
    },
    examDurationMinutes: {
      type: Number,
      required: true,
      min: 1,
      max: 300,
      default: 30,
    },
    maxViolations: {
      type: Number,
      min: 1,
      max: 20,
      default: 3,
    },
    violationAction: {
      type: String,
      enum: ['pause', 'terminate', 'auto-submit'],
      default: 'auto-submit',
    },
    submissionDeadline: {
      type: Date,
      default: null,
      index: true,
    },
    challengeDescription: {
      type: String,
      default: '',
      trim: true,
    },
    attachments: {
      type: [assessmentAttachmentSchema],
      default: [],
    },
    assessmentMode: {
      type: String,
      enum: ASSESSMENT_MODES,
      default: 'activity',
      trim: true,
      index: true,
    },
    gradingPeriod: {
      type: String,
      enum: ['', ...GRADING_PERIODS],
      default: '',
      trim: true,
      index: true,
    },
    countsTowardRecommendation: {
      type: Boolean,
      default: false,
      index: true,
    },
    requiresLessonCompletion: {
      type: Boolean,
      default: true,
    },
    assignmentScope: {
      type: String,
      enum: ASSIGNMENT_SCOPES,
      default: 'handled_class',
      trim: true,
    },
    assignedStudentIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
      index: true,
    },
    questions: {
      type: [questionSchema],
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Assessment', assessmentSchema);
