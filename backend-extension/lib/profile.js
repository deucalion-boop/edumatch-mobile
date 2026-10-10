'use strict';

function publicUser(user, req, resolveStoredFileUrl) {
  return {
    id: String(user._id || user.id), name: user.name, email: user.email,
    username: user.username || '', role: user.role, status: user.status,
    strand: user.strand || '', subject: user.subject || '', department: user.department || '',
    gradeLevel: user.gradeLevel || '', contactNumber: user.contactNumber || '',
    sectionId: String(user.sectionId?._id || user.sectionId || ''),
    advisorySectionId: String(user.advisorySectionId?._id || user.advisorySectionId || ''),
    profileImage: user.profileImage && resolveStoredFileUrl
      ? resolveStoredFileUrl(req, user.profileImage) : user.profileImage || '',
    forcePasswordChange: user.forcePasswordChange === true,
    hasCompletedTeacherTour: user.hasCompletedTeacherTour === true,
    hasCompletedStudentTour: user.hasCompletedStudentTour === true,
    temporaryPasswordIssuedAt: user.temporaryPasswordIssuedAt || null,
    createdAt: user.createdAt || null,
  };
}

// The existing security middleware permits /auth/sessions while a password change
// is required. Reuse that exact self-account authentication policy for /mobile/me.
// Copying the request keeps route metadata intact for audit/error middleware.
function identityAuth(authMiddleware) {
  return (req, res, next) => {
    const identityRequest = Object.create(req);
    Object.defineProperties(identityRequest, {
      baseUrl: { value: '/api/auth', writable: true },
      path: { value: '/sessions', writable: true },
    });
    return authMiddleware(identityRequest, res, (error) => {
      if (error) return next(error);
      req.user = identityRequest.user;
      req.token = identityRequest.token;
      req.session = identityRequest.session;
      return next();
    });
  };
}

module.exports = { publicUser, identityAuth };
