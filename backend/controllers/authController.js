const { assertGmailEmail } = require('../utils/emailPolicy');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendSuccess } = require('../utils/responseHelper');
const { sendEmailViaGmail } = require('../services/gmailService');
const { assertPasswordMeetsPolicy, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('../utils/passwordPolicy');
const { resolveStoredFileUrl } = require('../utils/fileStorage');
const { getAppSettings } = require('../services/supabaseSettingsService');
const {
  findSupabaseAccount,
  findSupabaseAccountByEmail,
  findSupabaseAccountByJsonToken,
  findSupabaseAccountByUsername,
} = require('../services/supabaseAccountService');
const {
  consumeOpenChallenges,
  createChallenge,
  createSession,
  deleteChallenge,
  findActiveChallenge,
  findOpenChallenge,
  recordLoginAttempt: persistLoginAttempt,
  revokeUserSessions,
  sessionExists,
} = require('../services/supabaseAuthPersistenceService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const RESET_TOKEN_TTL_MINUTES = 60;
const APP_NAME = 'EduMatch';
const DEFAULT_ACCESS_TOKEN_TTL = '1d';
const DEFAULT_REMEMBER_ME_TOKEN_TTL = '30d';
const LOGIN_OTP_TTL_MINUTES = 2;
const LOGIN_OTP_MAX_ATTEMPTS = 5;
const LOGIN_OTP_RESEND_COOLDOWN_SECONDS = 30;

async function createSessionAndSignToken(user, req, remember = false) {
  const rememberSession = remember === true;
  const tokenId = crypto.randomUUID();
  const ttlMs = rememberSession ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const ipAddress = resolveClientIpAddress(req).slice(0, 120);
  const userAgent = resolveClientUserAgent(req);
  const familiarDevice = await sessionExists(user._id, userAgent);
  await createSession({
    userId: user._id,
    tokenId,
    ipAddress,
    userAgent,
    remember: rememberSession,
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  if (String(user.role || '').toLowerCase() === 'admin' && !familiarDevice) {
    void sendAdminLoginAlert(user, { ipAddress, userAgent });
  }
  return jwt.sign(
    { id: user._id, jti: tokenId, tokenVersion: Number(user.tokenVersion || 0), remember: rememberSession },
    process.env.JWT_SECRET,
    {
      expiresIn: rememberSession ? DEFAULT_REMEMBER_ME_TOKEN_TTL : DEFAULT_ACCESS_TOKEN_TTL,
      algorithm: 'HS256',
      issuer: 'edumatch-api',
      audience: 'edumatch-web',
    }
  );
}

async function sendAdminLoginAlert(user, { ipAddress, userAgent }) {
  try {
    const text = `A new device signed in to your EduMatch administrator account. IP: ${ipAddress || 'unknown'}. Device: ${userAgent || 'unknown'}. If this was not you, reset your password and revoke the session immediately.`;
    const result = await sendEmailViaGmail({
      to: { email: user.email, name: user.name },
      subject: 'EduMatch security alert: new administrator sign-in',
      text,
      html: `<p>${text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])}</p>`,
    });
    if (!result?.sent) console.error('[SECURITY_ALERT] New-device alert was not delivered.');
  } catch (_error) {
    console.error('[SECURITY_ALERT] New-device alert was not delivered.');
  }
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

async function issueLoginOtp(user, req, remember) {
  const otpCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challengeToken = crypto.randomBytes(32).toString('hex');
  const challengeTokenHash = crypto.createHash('sha256').update(challengeToken).digest('hex');
  const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MINUTES * 60 * 1000);

  await createChallenge({
    userId: user._id,
    challengeTokenHash,
    otpHash: await bcrypt.hash(otpCode, 10),
    remember,
    ipAddress: resolveClientIpAddress(req).slice(0, 120),
    userAgent: resolveClientUserAgent(req),
    expiresAt,
  });

  const emailResult = await sendEmailViaGmail({
    to: { email: user.email, name: user.name },
    subject: 'EduMatch login verification code',
    text: `Your EduMatch verification code is ${otpCode}. It expires in ${LOGIN_OTP_TTL_MINUTES} minutes. Do not share this code.`,
    html: `<p>Your EduMatch verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${otpCode}</p><p>It expires in ${LOGIN_OTP_TTL_MINUTES} minutes. Do not share this code.</p>`,
  });
  if (!emailResult?.sent) {
    await deleteChallenge(challengeTokenHash);
    const error = new Error('Unable to send the verification code. Please try again.');
    error.statusCode = 502;
    throw error;
  }
  await consumeOpenChallenges(user._id, challengeTokenHash);
  return {
    challengeToken,
    expiresAt,
    resendAvailableAt: new Date(Date.now() + LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000),
  };
}

function buildLoginUser(user, req) {
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
    profileImage: normalizeProfileImageUrl(user, req),
    contactNumber: user.contactNumber || '',
    hasCompletedTeacherTour: user.hasCompletedTeacherTour === true,
    hasCompletedStudentTour: user.hasCompletedStudentTour === true,
    forcePasswordChange: user.forcePasswordChange === true,
    temporaryPasswordIssuedAt: user.temporaryPasswordIssuedAt || null,
    createdAt: user.createdAt || null,
  };
}

function normalizeProfileImageUrl(user, req) {
  const raw = String(user?.profileImage || '').trim();
  if (!raw) return '';
  return resolveStoredFileUrl(req, raw);
}

function resolveFrontendUrl() {
  return String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '') || 'http://localhost:5173';
}

function buildResetPasswordLink(token) {
  const baseUrl = resolveFrontendUrl();
  return `${baseUrl}/auth/reset-password/${encodeURIComponent(token)}`;
}

function resolveClientIpAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
}

function resolveClientUserAgent(req) {
  return String(req.headers['user-agent'] || '').trim().slice(0, 500);
}

async function recordLoginAttempt(req, { username = '', user = null, outcome = 'failed', reason = '' } = {}) {
  try {
    await persistLoginAttempt({
      userId: user?._id || null,
      username: String(username || user?.username || '').trim().slice(0, 120),
      name: String(user?.name || '').trim().slice(0, 200),
      email: String(user?.email || '').trim().toLowerCase().slice(0, 200),
      role: String(user?.role || '').trim().toLowerCase().slice(0, 50),
      outcome: outcome === 'success' ? 'success' : 'failed',
      reason: String(reason || '').trim().slice(0, 300),
      ipAddress: resolveClientIpAddress(req).slice(0, 120),
      userAgent: resolveClientUserAgent(req),
    });
  } catch (error) {
    console.error('[auth.login] Failed to record login attempt:', error);
  }
}

async function sendPasswordResetEmail({ email, name, resetLink }) {
  const safeName = String(name || '').trim() || 'there';
  const subject = `${APP_NAME} Password Reset`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111111; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Reset your password</h2>
      <p style="margin: 0 0 12px;">Hi ${safeName},</p>
      <p style="margin: 0 0 16px;">
        We received a request to reset your ${APP_NAME} password. Click the button below to set a new password.
      </p>
      <p style="margin: 0 0 20px;">
        <a href="${resetLink}" style="display: inline-block; padding: 10px 18px; background: #111111; color: #ffffff; text-decoration: none; border-radius: 6px;">
          Reset Password
        </a>
      </p>
      <p style="margin: 0 0 8px; font-size: 14px; color: #4b5563;">
        This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.
      </p>
      <p style="margin: 0; font-size: 12px; color: #6b7280;">${APP_NAME} Security Team</p>
    </div>
  `;
  const text = `Hi ${safeName},\n\nWe received a request to reset your ${APP_NAME} password.\n\nReset link: ${resetLink}\n\nThis link expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.\n`;

  return sendEmailViaGmail({
    to: { email, name: safeName },
    subject,
    html,
    text,
  });
}

async function verifyRecaptchaToken({ token, remoteIp }) {
  const recaptchaSecret = String(process.env.RECAPTCHA_SECRET_KEY || '').trim();
  const captchaToken = String(token || '').trim();
  if (!recaptchaSecret || !captchaToken) return false;

  const payload = new URLSearchParams({
    secret: recaptchaSecret,
    response: captchaToken,
  });
  if (remoteIp) {
    payload.append('remoteip', String(remoteIp));
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return false;
    const body = await response.json();
    const allowedHostnames = String(process.env.RECAPTCHA_ALLOWED_HOSTNAMES || '')
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean);
    const verifiedHostname = String(body?.hostname || '').trim().toLowerCase();
    return body?.success === true
      && (allowedHostnames.length === 0 || allowedHostnames.includes(verifiedHostname));
  } catch (_error) {
    return false;
  }
}

const login = asyncHandler(async (req, res) => {
  const { username, password, captchaToken, remember } = req.body;
  const normalizedUsername = String(username || '').trim();
  const rememberSession = remember === true || String(remember || '').trim().toLowerCase() === 'true';

  if (!normalizedUsername || !password) {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      outcome: 'failed',
      reason: 'Username and password are required',
    });
    const error = new Error('Username and password are required');
    error.statusCode = 400;
    throw error;
  }

  const isCaptchaValid = await verifyRecaptchaToken({
    token: captchaToken,
    remoteIp: resolveClientIpAddress(req),
  });
  if (!isCaptchaValid) {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      outcome: 'failed',
      reason: 'Please verify that you are not a robot',
    });
    const error = new Error('Please verify that you are not a robot');
    error.statusCode = 400;
    throw error;
  }

  const user = await findSupabaseAccountByUsername(normalizedUsername);

  if (!user) {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      outcome: 'failed',
      reason: 'Invalid username or password',
    });
    const error = new Error('Invalid username or password');
    error.statusCode = 401;
    throw error;
  }

  req.auditLogContext = {
    actorUserId: user._id,
    actorName: user.name,
    actorEmail: user.email,
    actorRole: user.role,
    actorIdentifier: user.username || normalizedUsername,
    targetId: user._id,
    targetLabel: user.name || user.username || user.email,
  };

  if (!user.password) {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      user,
      outcome: 'failed',
      reason: 'Account setup is incomplete. Please use your invite link to activate your account.',
    });
    const error = new Error('Account setup is incomplete. Please use your invite link to activate your account.');
    error.statusCode = 403;
    throw error;
  }

  const settings = await getAppSettings();
  const { maxLoginAttempts, accountLockoutDurationMinutes } = settings.security;
  const now = new Date();
  if (user.lockUntil && new Date(user.lockUntil).getTime() > now.getTime()) {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      user,
      outcome: 'failed',
      reason: 'Account is temporarily locked due to too many failed login attempts. Please try again later.',
    });
    const error = new Error('Account is temporarily locked due to too many failed login attempts. Please try again later.');
    error.statusCode = 423;
    throw error;
  }

  const passwordMatched = await user.comparePassword(password);

  if (!passwordMatched) {
    const currentAttempts = Number(user.failedLoginAttempts || 0) + 1;
    user.failedLoginAttempts = currentAttempts;
    if (currentAttempts >= maxLoginAttempts) {
      user.lockUntil = new Date(now.getTime() + accountLockoutDurationMinutes * 60 * 1000);
      user.failedLoginAttempts = 0;
    }
    await user.save();
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      user,
      outcome: 'failed',
      reason: 'Invalid username or password',
    });
    const error = new Error('Invalid username or password');
    error.statusCode = 401;
    throw error;
  }

  if (user.status === 'pending' || user.status === 'inactive' || user.status === 'suspended') {
    const loginBlockedMessage =
      user.status === 'pending'
        ? 'Account is pending activation. Use your invite email to finish account setup.'
        :
      user.status === 'suspended'
        ? 'Account is suspended. Please contact admin.'
        : 'Account is inactive. Please contact admin.';
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      user,
      outcome: 'failed',
      reason: loginBlockedMessage,
    });
    const error = new Error(
      loginBlockedMessage
    );
    error.statusCode = 403;
    throw error;
  }

  const { maintenanceModeEnabled, maintenanceMessage } = settings.maintenance;
  if (maintenanceModeEnabled && String(user.role || '').toLowerCase() !== 'admin') {
    await recordLoginAttempt(req, {
      username: normalizedUsername,
      user,
      outcome: 'failed',
      reason: maintenanceMessage,
    });
    const error = new Error(maintenanceMessage);
    error.statusCode = 503;
    throw error;
  }

  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  await user.save();

  assertGmailEmail(user.email);

  const challenge = await issueLoginOtp(user, req, rememberSession);
  return sendSuccess(res, 202, 'Verification code sent', {
    requiresOtp: true,
    challengeToken: challenge.challengeToken,
    expiresAt: challenge.expiresAt,
    resendAvailableAt: challenge.resendAvailableAt,
    deliveryHint: maskEmail(user.email),
  });
});

const resendLoginOtp = asyncHandler(async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '').trim();
  if (!/^[a-f0-9]{64}$/.test(challengeToken)) {
    const error = new Error('Verification challenge is invalid');
    error.statusCode = 400;
    throw error;
  }
  const challengeTokenHash = crypto.createHash('sha256').update(challengeToken).digest('hex');
  const previousChallenge = await findOpenChallenge(challengeTokenHash);
  if (!previousChallenge || Number(previousChallenge.failedAttempts || 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
    const error = new Error('Verification challenge is invalid. Sign in again to request a new code.');
    error.statusCode = 400;
    throw error;
  }
  const resendAvailableAt = new Date(previousChallenge.createdAt).getTime()
    + LOGIN_OTP_RESEND_COOLDOWN_SECONDS * 1000;
  if (Date.now() < resendAvailableAt) {
    const error = new Error('Please wait before requesting another code.');
    error.statusCode = 429;
    throw error;
  }
  const user = await findSupabaseAccount('id', previousChallenge.userId);
  if (!user || user.status !== 'active') {
    const error = new Error('Account is no longer available');
    error.statusCode = 403;
    throw error;
  }
  assertGmailEmail(user.email);
  const { maintenanceModeEnabled, maintenanceMessage } = (await getAppSettings()).maintenance;
  if (maintenanceModeEnabled && String(user.role || '').toLowerCase() !== 'admin') {
    const error = new Error(maintenanceMessage);
    error.statusCode = 503;
    throw error;
  }
  const challenge = await issueLoginOtp(user, req, previousChallenge.remember === true);
  return sendSuccess(res, 202, 'New verification code sent', {
    requiresOtp: true,
    challengeToken: challenge.challengeToken,
    expiresAt: challenge.expiresAt,
    resendAvailableAt: challenge.resendAvailableAt,
    deliveryHint: maskEmail(user.email),
  });
});

const verifyLoginOtp = asyncHandler(async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '').trim();
  const otpCode = String(req.body?.otpCode || '').replace(/\D/g, '');
  if (!challengeToken || !/^\d{6}$/.test(otpCode)) {
    const error = new Error('A valid 6-digit verification code is required');
    error.statusCode = 400;
    throw error;
  }
  if (!await verifyRecaptchaToken({ token: req.body?.captchaToken, remoteIp: resolveClientIpAddress(req) })) {
    const error = new Error('Please verify that you are not a robot');
    error.statusCode = 400;
    throw error;
  }

  const challengeTokenHash = crypto.createHash('sha256').update(challengeToken).digest('hex');
  const challenge = await findActiveChallenge(challengeTokenHash);
  if (!challenge || Number(challenge.failedAttempts || 0) >= LOGIN_OTP_MAX_ATTEMPTS) {
    const error = new Error('Verification challenge is invalid or expired');
    error.statusCode = 400;
    throw error;
  }
  if (!await bcrypt.compare(otpCode, challenge.otpHash)) {
    challenge.failedAttempts = Number(challenge.failedAttempts || 0) + 1;
    if (challenge.failedAttempts >= LOGIN_OTP_MAX_ATTEMPTS) challenge.consumedAt = new Date();
    await challenge.save();
    const error = new Error('Invalid verification code');
    error.statusCode = 401;
    throw error;
  }

  const user = await findSupabaseAccount('id', challenge.userId);
  if (!user || user.status !== 'active') {
    const error = new Error('Account is no longer available');
    error.statusCode = 403;
    throw error;
  }
  assertGmailEmail(user.email);
  const { maintenanceModeEnabled, maintenanceMessage } = (await getAppSettings()).maintenance;
  if (maintenanceModeEnabled && String(user.role || '').toLowerCase() !== 'admin') {
    const error = new Error(maintenanceMessage);
    error.statusCode = 503;
    throw error;
  }
  const now = new Date();
  challenge.consumedAt = now;
  user.lastLoginAt = now;
  user.lastActivityAt = now;
  await Promise.all([challenge.save(), user.save()]);
  await recordLoginAttempt(req, { username: user.username, user, outcome: 'success', reason: 'Login and OTP verification successful' });
  const token = await createSessionAndSignToken(user, req, challenge.remember === true);
  return sendSuccess(res, 200, 'Login verified successfully', {
    token,
    redirectPath: user.forcePasswordChange ? '/auth/change-password' : undefined,
    user: buildLoginUser(user, req),
  });
});

const syncPresence = asyncHandler(async (req, res) => {
  req.auditLogSkip = true;

  return sendSuccess(res, 200, 'Presence synced', {
    lastActivityAt: req.user?.lastActivityAt || new Date(),
  });
});

async function resolveInviteError(hashedToken, now) {
  const candidate = await findSupabaseAccountByJsonToken('invite', hashedToken);
  let message = 'Invalid invite link';
  if (candidate?.invite?.usedAt) message = 'This invite link was already used';
  else if (candidate && (!candidate?.invite?.expiresAt || new Date(candidate.invite.expiresAt).getTime() <= now.getTime())) {
    message = 'This invite link has expired';
  }
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

const validateInvite = asyncHandler(async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken) {
    const error = new Error('Invite token is required');
    error.statusCode = 400;
    throw error;
  }

  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();

  const candidate = await findSupabaseAccountByJsonToken('invite', hashedToken);
  const user = candidate && !candidate?.invite?.usedAt
    && candidate?.invite?.expiresAt && new Date(candidate.invite.expiresAt).getTime() > now.getTime()
    ? candidate : null;

  if (!user) {
    await resolveInviteError(hashedToken, now);
  }

  return sendSuccess(res, 200, 'Invite link is valid', {
    invite: {
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      expiresAt: user?.invite?.expiresAt || null,
    },
  });
});

const completeInvite = asyncHandler(async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!rawToken) {
    const error = new Error('Invite token is required');
    error.statusCode = 400;
    throw error;
  }

  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const candidate = await findSupabaseAccountByJsonToken('invite', hashedToken);
  const user = candidate && !candidate?.invite?.usedAt
    && candidate?.invite?.expiresAt && new Date(candidate.invite.expiresAt).getTime() > now.getTime()
    ? candidate : null;

  if (!user) {
    await resolveInviteError(hashedToken, now);
  }

  const hasExistingPassword = Boolean(String(user.password || '').trim());
  if (!hasExistingPassword && (!password || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH)) {
    const error = new Error(`Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`);
    error.statusCode = 400;
    throw error;
  }

  if (password) {
    assertPasswordMeetsPolicy(password);
    user.password = password;
  }

  user.status = 'active';
  user.forcePasswordChange = false;
  user.temporaryPasswordIssuedAt = null;
  if (!user.invite) {
    user.invite = {};
  }
  user.invite.tokenHash = '';
  user.invite.usedAt = now;

  await user.save();

  return sendSuccess(res, 200, 'Account setup complete. You can now sign in.', {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      strand: user.strand || '',
      subject: user.subject || '',
      department: user.department || '',
      gradeLevel: user.gradeLevel || '',
      contactNumber: user.contactNumber || '',
    },
  });
});

const requestPasswordReset = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  if (!email) {
    const error = new Error('Email is required');
    error.statusCode = 400;
    throw error;
  }

  const user = await findSupabaseAccountByEmail(email);
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    user.resetPassword = {
      tokenHash,
      expiresAt,
      requestedAt: now,
      usedAt: null,
    };

    await user.save();

    const resetLink = buildResetPasswordLink(rawToken);
    try {
      const emailResult = await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        resetLink,
      });
      if (!emailResult?.sent) console.error('[PASSWORD_RESET] Delivery failed for a valid account.');
    } catch (_error) {
      // Keep the public response identical so delivery failures cannot enumerate accounts.
      console.error('[PASSWORD_RESET] Delivery failed for a valid account.');
    }
  }

  return sendSuccess(res, 200, 'If the email exists, a reset link has been sent.');
});

const validatePasswordReset = asyncHandler(async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken) {
    const error = new Error('Reset token is required');
    error.statusCode = 400;
    throw error;
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const candidate = await findSupabaseAccountByJsonToken('reset_password', tokenHash);
  const user = candidate && !candidate?.resetPassword?.usedAt
    && candidate?.resetPassword?.expiresAt && new Date(candidate.resetPassword.expiresAt).getTime() > now.getTime()
    ? candidate : null;

  if (!user) {
    const error = new Error('Reset link is invalid or expired');
    error.statusCode = 400;
    throw error;
  }

  return sendSuccess(res, 200, 'Reset link is valid', {
    reset: {
      email: user.email,
      expiresAt: user?.resetPassword?.expiresAt || null,
    },
  });
});

const completePasswordReset = asyncHandler(async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!rawToken) {
    const error = new Error('Reset token is required');
    error.statusCode = 400;
    throw error;
  }

  assertPasswordMeetsPolicy(password);

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const candidate = await findSupabaseAccountByJsonToken('reset_password', tokenHash);
  const user = candidate && !candidate?.resetPassword?.usedAt
    && candidate?.resetPassword?.expiresAt && new Date(candidate.resetPassword.expiresAt).getTime() > now.getTime()
    ? candidate : null;

  if (!user) {
    const error = new Error('Reset link is invalid or expired');
    error.statusCode = 400;
    throw error;
  }

  user.password = password;
  user.forcePasswordChange = false;
  user.temporaryPasswordIssuedAt = null;
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  if (!user.resetPassword) {
    user.resetPassword = {};
  }
  user.resetPassword.tokenHash = '';
  user.resetPassword.usedAt = now;

  await user.save();
  await revokeUserSessions(user._id, 'Password reset');

  return sendSuccess(res, 200, 'Password reset successful. You can now sign in.');
});

module.exports = {
  login,
  verifyLoginOtp,
  resendLoginOtp,
  syncPresence,
  validateInvite,
  completeInvite,
  requestPasswordReset,
  validatePasswordReset,
  completePasswordReset,
};
