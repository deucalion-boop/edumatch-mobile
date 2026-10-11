const { findSupabaseAccount } = require('../services/supabaseAccountService');
const { uploadFile } = require('../services/storageService');
const { resolveStoredFileUrl } = require('../utils/fileStorage');
const { isAllowedProfileImage } = require('../utils/uploadMiddleware');
const { sendSuccess } = require('../utils/responseHelper');
const { assertGmailEmail } = require('../utils/emailPolicy');
const { USER_ROLES } = require('../constants/userRoles');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function profileError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function currentAccount(req, requiredRole) {
  const id = String(req.user?._id || '').trim();
  if (!id) throw profileError('Authentication is required', 401);
  if (requiredRole && req.user?.role !== requiredRole) throw profileError('Admin access is required', 403);
  if (!USER_ROLES.includes(req.user?.role)) throw profileError('Account access is required', 403);
  const user = await findSupabaseAccount('id', id);
  if (!user) throw profileError(requiredRole === 'admin' ? 'Admin account was not found' : 'Account was not found', 404);
  if (requiredRole && user.role !== requiredRole) throw profileError('Admin access is required', 403);
  if (!USER_ROLES.includes(user.role)) throw profileError('Account access is required', 403);
  if (user.status !== 'active') throw profileError('Your account is not active', 403);
  return user;
}

function profileResponse(user, req) {
  const storedImage = String(user.profileImage || '').trim();
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    username: user.username || '',
    role: user.role,
    status: user.status,
    strand: user.strand || '',
    subject: user.subject || '',
    department: user.department || '',
    gradeLevel: user.gradeLevel || '',
    sectionId: String(user.sectionId?._id || user.sectionId?.id || user.sectionId || ''),
    advisorySectionId: String(user.advisorySectionId?._id || user.advisorySectionId?.id || user.advisorySectionId || ''),
    profileImage: storedImage ? resolveStoredFileUrl(req, storedImage) : '',
    contactNumber: user.contactNumber || '',
    hasCompletedTeacherTour: user.hasCompletedTeacherTour === true,
    hasCompletedStudentTour: user.hasCompletedStudentTour === true,
    forcePasswordChange: user.forcePasswordChange === true,
    temporaryPasswordIssuedAt: user.temporaryPasswordIssuedAt || null,
    createdAt: user.createdAt || null,
  };
}

function createProfileHandlers({ requiredRole } = {}) {
const getProfile = asyncHandler(async (req, res) => {
  const user = await currentAccount(req, requiredRole);
  return sendSuccess(res, 200, 'Profile loaded successfully', { user: profileResponse(user, req) });
});

const updateProfile = asyncHandler(async (req, res) => {
  const user = await currentAccount(req, requiredRole);
  const body = req.body || {};
  const hasName = Object.hasOwn(body, 'name');
  const hasEmail = Object.hasOwn(body, 'email');
  const file = req.file;
  if (!hasName && !hasEmail && !file) {
    throw profileError('Provide a name, email, or profile picture to update', 400);
  }

  let name = user.name;
  if (hasName) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw profileError('Name is required', 400);
    }
    name = body.name.trim();
  }
  const email = hasEmail ? assertGmailEmail(typeof body.email === 'string' ? body.email : '') : user.email;
  const emailChanged = email !== user.email;
  if (emailChanged) {
    const existing = await findSupabaseAccount('email', email);
    if (existing && String(existing._id) !== String(user._id)) {
      throw profileError('Email already exists', 409);
    }
  }

  let storedPath = user.profileImage;
  if (file) {
    if (!isAllowedProfileImage(file)) {
      throw profileError('Only JPG, JPEG, PNG, or WEBP images are allowed', 400);
    }
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) {
      throw profileError('Profile picture is empty or invalid', 400);
    }
    if (file.buffer.length > MAX_PROFILE_IMAGE_BYTES || Number(file.size) > MAX_PROFILE_IMAGE_BYTES) {
      throw profileError('Profile picture must be 5 MB or smaller', 400);
    }
    const uploaded = await uploadFile({ file, folder: `profile-images/${user.role}/${user._id}` });
    storedPath = String(uploaded?.storedPath || '').trim();
    if (!storedPath) throw profileError('Unable to save the profile picture', 500);
  }

  // Only these profile fields are editable; identity, settings and credentials
  // from either JSON or multipart body fields are ignored.
  user.name = name;
  user.email = email;
  user.profileImage = storedPath;
  if (emailChanged) {
    // Old invitation/reset links were delivered to the previous address. The
    // account service also revokes sessions and open login challenges on save.
    user.invite = { tokenHash: '', expiresAt: null, sentAt: null, usedAt: null };
    user.resetPassword = { tokenHash: '', expiresAt: null, requestedAt: null, usedAt: null };
  }
  await user.save();
  return sendSuccess(res, 200, 'Profile updated successfully', {
    user: profileResponse(user, req),
    requiresSignIn: emailChanged,
  });
});

return { getProfile, updateProfile };
}

const { getProfile: getMyProfile, updateProfile: updateMyProfile } = createProfileHandlers();
module.exports = { createProfileHandlers, getMyProfile, updateMyProfile };
