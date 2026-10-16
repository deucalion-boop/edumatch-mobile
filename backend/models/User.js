const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { USER_ROLES, DEPARTMENTS, ROLE_HEADTEACHER } = require('../constants/userRoles');

const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    username: {
      type: String,
      default: '',
      trim: true,
      maxlength: 50,
    },
    password: {
      type: String,
      required: false,
      validate: {
        validator(value) {
          if (!value) return true;
          const normalized = String(value);
          // Allow persisted bcrypt hashes while enforcing the application password bounds.
          if (BCRYPT_HASH_REGEX.test(normalized)) return true;
          return normalized.length >= 8 && normalized.length <= 16;
        },
        message: 'Password must be between 8 and 16 characters',
      },
      select: false,
    },
    forcePasswordChange: {
      type: Boolean,
      default: false,
    },
    temporaryPasswordIssuedAt: {
      type: Date,
      default: null,
    },
    hasCompletedTeacherTour: {
      type: Boolean,
      default: false,
    },
    hasCompletedStudentTour: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      required: true,
      default: 'student',
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'inactive', 'suspended'],
      default: 'active',
      index: true,
    },
    invite: {
      tokenHash: {
        type: String,
        default: '',
        select: false,
        index: true,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
      sentAt: {
        type: Date,
        default: null,
      },
      usedAt: {
        type: Date,
        default: null,
      },
    },
    resetPassword: {
      tokenHash: {
        type: String,
        default: '',
        select: false,
        index: true,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
      requestedAt: {
        type: Date,
        default: null,
      },
      usedAt: {
        type: Date,
        default: null,
      },
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    lockUntil: {
      type: Date,
      default: null,
      select: false,
    },
    lastLoginAt: {
      type: Date,
      default: null,
      select: false,
    },
    lastActivityAt: {
      type: Date,
      default: null,
      select: false,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    strand: {
      type: String,
      enum: ['', 'STEM', 'HUMSS', 'ABM', 'TVL'],
      default: '',
      trim: true,
    },
    subject: {
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
    sectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: undefined,
      index: true,
    },
    advisorySectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: undefined,
    },
    managedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    profileImage: {
      type: String,
      default: '',
      trim: true,
    },
    contactNumber: {
      type: String,
      default: '',
      trim: true,
    },
    gradeLevel: {
      type: String,
      enum: ['', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
      default: '',
      trim: true,
    },
    enrollment: {
      teacherId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        index: true,
      },
      status: {
        type: String,
        enum: ['', 'pending', 'approved', 'accepted', 'rejected'],
        default: '',
        index: true,
      },
      track: {
        type: String,
        default: '',
        trim: true,
      },
      trackId: {
        type: String,
        default: '',
        trim: true,
      },
      requestedAt: {
        type: Date,
        default: null,
      },
      approvedAt: {
        type: Date,
        default: null,
      },
      progress: {
        masteryProgress: {
          type: Number,
          default: 0,
          min: 0,
          max: 100,
        },
        averageScore: {
          type: Number,
          default: 0,
          min: 0,
          max: 100,
        },
        completedAssessments: {
          type: Number,
          default: 0,
          min: 0,
        },
        lastCalculatedAt: {
          type: Date,
          default: null,
        },
      },
    },
    archive: {
      isArchived: {
        type: Boolean,
        default: false,
        index: true,
      },
      schoolYear: {
        type: String,
        default: '',
        trim: true,
        index: true,
      },
      archivedAt: {
        type: Date,
        default: null,
      },
      archivedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      reason: {
        type: String,
        enum: ['', 'inactive', 'completed'],
        default: '',
        trim: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ role: 1, 'archive.isArchived': 1, 'archive.schoolYear': 1 });

userSchema.index(
  { advisorySectionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      advisorySectionId: { $exists: true },
    },
  }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) {
    return;
  }
  if (!this.password) {
    return;
  }

  const saltRounds = 10;
  this.password = await bcrypt.hash(this.password, saltRounds);
});

userSchema.pre('validate', async function ensureSingleHeadTeacherPerDepartment() {
  const normalizedRole = String(this.role || '').trim().toLowerCase();
  const isHeadTeacherRole = normalizedRole === ROLE_HEADTEACHER || normalizedRole === 'head_teacher';
  if (!isHeadTeacherRole) return;

  const normalizedDepartment = String(this.department || '').trim();
  if (!normalizedDepartment) return;
  if (!this.isNew && !this.isModified('role') && !this.isModified('department')) return;

  const existingHeadTeacher = await this.constructor.findOne({
    _id: { $ne: this._id },
    role: ROLE_HEADTEACHER,
    department: normalizedDepartment,
  }).select('_id').lean();

  if (existingHeadTeacher) {
    this.invalidate('department', 'This department already has a Head Teacher assigned');
  }
});

userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  if (!this.password) {
    return false;
  }
  return bcrypt.compare(plainPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
