const mongoose = require('mongoose');

const attendanceEntrySchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    studentName: {
      type: String,
      default: '',
      trim: true,
    },
    studentEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: undefined,
      index: true,
    },
    sectionName: {
      type: String,
      default: '',
      trim: true,
    },
    gradeLevel: {
      type: String,
      default: '',
      trim: true,
    },
    department: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['Present', 'Late', 'Absent', 'Excused'],
      required: true,
    },
    markedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  }
);

const attendanceSummarySchema = new mongoose.Schema(
  {
    totalStudents: {
      type: Number,
      default: 0,
      min: 0,
    },
    presentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lateCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    absentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    excusedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    _id: false,
  }
);

const attendanceSchema = new mongoose.Schema(
  {
    attendanceScope: {
      type: String,
      enum: ['handled_class', 'advisory_class'],
      default: 'handled_class',
      trim: true,
      index: true,
    },
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: undefined,
      index: true,
    },
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: undefined,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    dateKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    attendanceDate: {
      type: Date,
      required: true,
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
    className: {
      type: String,
      default: '',
      trim: true,
    },
    sectionName: {
      type: String,
      default: '',
      trim: true,
    },
    track: {
      type: String,
      default: '',
      trim: true,
    },
    teacherName: {
      type: String,
      default: '',
      trim: true,
    },
    teacherSubject: {
      type: String,
      default: '',
      trim: true,
    },
    teacherDepartment: {
      type: String,
      default: '',
      trim: true,
    },
    entries: {
      type: [attendanceEntrySchema],
      default: [],
    },
    summary: {
      type: attendanceSummarySchema,
      default: () => ({
        totalStudents: 0,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        excusedCount: 0,
      }),
    },
    isLocked: {
      type: Boolean,
      default: false,
      index: true,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

attendanceSchema.index(
  { attendanceScope: 1, subjectId: 1, dateKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      subjectId: { $exists: true },
    },
  }
);
attendanceSchema.index(
  { attendanceScope: 1, teacherId: 1, sectionId: 1, dateKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      attendanceScope: 'advisory_class',
      sectionId: { $exists: true },
    },
  }
);
attendanceSchema.index({ teacherId: 1, dateKey: -1 });
attendanceSchema.index({ 'entries.studentId': 1, dateKey: -1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
