const { sendSuccess } = require('../utils/responseHelper');
const { deleteSupabaseAccount, findSupabaseAccount } = require('../services/supabaseAccountService');
const { revokeUserSessions } = require('../services/supabaseAuthPersistenceService');
const {
  completeAccountRequest,
  createAccountRequest,
  getAccountRequestById,
  getLatestAccountRequest,
  getStudentSettings,
  listAccountRequests,
  reviewAccountRequest,
  saveStudentSettings,
} = require('../services/studentSettingsService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const getMySettings = asyncHandler(async (req, res) => sendSuccess(res, 200, 'Student settings fetched', {
  settings: await getStudentSettings(req.user._id),
}));

const updateMySettings = asyncHandler(async (req, res) => sendSuccess(res, 200, 'Student settings saved', {
  settings: await saveStudentSettings(req.user._id, req.body || {}),
}));

const getMyAccountRequest = asyncHandler(async (req, res) => sendSuccess(res, 200, 'Account request fetched', {
  request: await getLatestAccountRequest(req.user._id),
}));

const submitMyAccountRequest = asyncHandler(async (req, res) => {
  const request = await createAccountRequest({
    student: req.user,
    action: req.body?.action,
    reason: req.body?.reason,
  });
  return sendSuccess(res, 201, 'Your account request was submitted for administrator review', { request });
});

const getStudentAccountRequests = asyncHandler(async (req, res) => sendSuccess(res, 200, 'Student account requests fetched', {
  requests: await listAccountRequests(req.query?.limit),
}));

const reviewStudentAccountRequest = asyncHandler(async (req, res) => {
  const decision = String(req.body?.decision || '').trim().toLowerCase();
  let request = await getAccountRequestById(req.params.id);
  if (!request || request.status !== 'pending') throw Object.assign(new Error('Pending account request not found'), { statusCode: 404 });

  if (decision === 'approved' && request.action === 'delete') {
    const confirmation = String(req.body?.confirmation || '').trim().toLowerCase();
    if (!request.studentEmail || confirmation !== request.studentEmail.toLowerCase()) {
      throw Object.assign(new Error('Type the student email address to confirm permanent deletion'), { statusCode: 400 });
    }
  }

  if (decision === 'approved' && request.studentId) {
    const student = await findSupabaseAccount('id', request.studentId);
    if (student && request.action === 'deactivate') {
      student.status = 'inactive';
      student.tokenVersion = Number(student.tokenVersion || 0) + 1;
      await student.save();
      await revokeUserSessions(student._id, 'Student account deactivation approved');
    } else if (student && request.action === 'delete') {
      await revokeUserSessions(student._id, 'Student account deletion approved');
      await deleteSupabaseAccount(student._id);
    }
  }

  request = await reviewAccountRequest({
    requestId: req.params.id,
    reviewerId: req.user._id,
    decision,
    note: req.body?.note,
  });

  if (request.status === 'approved') request = await completeAccountRequest(request.id);

  return sendSuccess(res, 200, request.status === 'completed' ? 'Account request approved and completed' : 'Account request reviewed', { request });
});

module.exports = {
  getMyAccountRequest,
  getMySettings,
  getStudentAccountRequests,
  reviewStudentAccountRequest,
  submitMyAccountRequest,
  updateMySettings,
};
