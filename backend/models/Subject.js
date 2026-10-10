const mongoose = require('mongoose');
const { STRANDS } = require('../constants/strandSubjects');
const { DEPARTMENTS } = require('../constants/userRoles');

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    className: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    track: {
      type: String,
      required: true,
      trim: true,
      enum: STRANDS,
      index: true,
    },
    subjectCategory: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    department: {
      type: String,
      enum: ['', ...DEPARTMENTS],
      default: '',
      trim: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    teacherId: {
      // User accounts live in Supabase, where their primary keys are
      // 32-character text values rather than MongoDB ObjectIds.
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

subjectSchema.index({ teacherId: 1, name: 1, track: 1, className: 1 }, { unique: true });

module.exports = mongoose.model('Subject', subjectSchema);
