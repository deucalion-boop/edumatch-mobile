const mongoose = require('mongoose');
const { STRANDS } = require('../constants/strandSubjects');

const lessonSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    track: {
      type: String,
      required: true,
      trim: true,
      enum: STRANDS,
      index: true,
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
      default: '',
      trim: true,
      index: true,
    },
    pdfPath: {
      type: String,
      required: true,
    },
    pdfOriginalName: {
      type: String,
      required: true,
    },
    attachments: [
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
    ],
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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Lesson', lessonSchema);
