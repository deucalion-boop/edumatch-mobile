const multer = require('multer');
const path = require('path');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const LESSON_FILE_EXTENSIONS = ['.pdf'];
const SUBMISSION_FILE_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.jpg', '.jpeg', '.png', '.webp', '.zip'];

const memoryStorage = multer.memoryStorage();

function buildSafeFileError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isAllowedLessonFile(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const mime = String(file?.mimetype || '').toLowerCase();
  return LESSON_FILE_EXTENSIONS.includes(extension)
    && (mime === 'application/pdf' || mime === 'application/x-pdf');
}

function isAllowedProfileImage(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const mime = String(file?.mimetype || '').toLowerCase();
  const expectedMimeByExtension = {
    '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'],
  };
  return Boolean(expectedMimeByExtension[extension]?.includes(mime));
}

const lessonUpload = multer({
  storage: memoryStorage,
  fileFilter: (_req, file, cb) => {
    if (!isAllowedLessonFile(file)) {
      return cb(buildSafeFileError('Only PDF lesson plan files are allowed'));
    }

    return cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

const uploadProfileImage = multer({
  storage: memoryStorage,
  fileFilter: (_req, file, cb) => {
    if (!isAllowedProfileImage(file)) {
      return cb(buildSafeFileError('Only JPG, JPEG, PNG, or WEBP images are allowed'));
    }

    return cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

function isDocumentOrImageMime(mimeValue) {
  const mime = String(mimeValue || '').toLowerCase();
  return mime.startsWith('image/')
    || mime === 'application/pdf'
    || mime === 'application/msword'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.ms-powerpoint'
    || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || mime === 'application/vnd.ms-excel'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mime === 'text/plain'
    || mime === 'application/zip'
    || mime === 'application/x-zip-compressed';
}

function isAllowedCommonAttachment(file) {
  const extension = path.extname(file?.originalname || '').toLowerCase();
  const mime = String(file?.mimetype || '').toLowerCase();
  const allowedMimes = {
    '.pdf': ['application/pdf'],
    '.doc': ['application/msword'],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.ppt': ['application/vnd.ms-powerpoint'],
    '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    '.xls': ['application/vnd.ms-excel'],
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.txt': ['text/plain'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.png': ['image/png'],
    '.webp': ['image/webp'],
    '.zip': ['application/zip', 'application/x-zip-compressed'],
  };
  return SUBMISSION_FILE_EXTENSIONS.includes(extension) && Boolean(allowedMimes[extension]?.includes(mime));
}

function buildCommonAttachmentUpload(message) {
  return multer({
    storage: memoryStorage,
    fileFilter: (_req, file, cb) => {
      if (!isAllowedCommonAttachment(file)) {
        return cb(buildSafeFileError(message));
      }

      return cb(null, true);
    },
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 5,
    },
  });
}

const uploadStudentSubmissionFiles = buildCommonAttachmentUpload(
  'Only common document, image, and zip files are allowed for student submissions'
);

const uploadTeacherAssessmentFiles = multer({
  storage: memoryStorage,
  fileFilter: (req, file, cb) => {
    if (!isAllowedCommonAttachment(file)) {
      if (!Array.isArray(req.rejectedAssessmentAttachments)) req.rejectedAssessmentAttachments = [];
      req.rejectedAssessmentAttachments.push({
        fileName: String(file?.originalname || 'Attachment'),
        fileType: String(file?.mimetype || 'application/octet-stream'),
        reason: 'Unsupported file type',
      });
      return cb(null, false);
    }

    return cb(null, true);
  },
  limits: {
    // Assessment files are validated individually at 10MB by the controller.
    // This higher parser ceiling lets one oversized file be skipped without
    // discarding the other valid files in the multipart request.
    fileSize: 25 * 1024 * 1024,
    files: 10,
  },
});

module.exports = {
  lessonUpload,
  uploadProfileImage,
  uploadStudentSubmissionFiles,
  uploadTeacherAssessmentFiles,
  isAllowedLessonFile,
  isAllowedProfileImage,
  isAllowedCommonAttachment,
  isDocumentOrImageMime,
};
