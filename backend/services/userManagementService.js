const crypto = require('crypto');
const { sendEmailViaGmail } = require('./gmailService');
const { DEPARTMENTS, ROLE_HEADTEACHER, ROLE_TEACHER } = require('../constants/userRoles');
const { generateTemporaryPassword } = require('../utils/passwordPolicy');
const { resolveStoredFileUrl } = require('../utils/fileStorage');

const CONTACT_NUMBER_REGEX = /^\+?[0-9()\-. ]{7,30}$/;
const MIN_INVITE_EXPIRY_HOURS = 24;
const MAX_INVITE_EXPIRY_HOURS = 72;
const ONLINE_ACTIVITY_WINDOW_MS = 10 * 1000;

function normalizeTeacherSubject(input) {
  return String(input || '').trim().replace(/\s+/g, ' ');
}

function normalizeContactNumber(input) {
  const normalizedContact = String(input || '').trim().replace(/\s+/g, ' ');
  if (!normalizedContact) return '';

  if (normalizedContact.length > 30) {
    const error = new Error('Contact number must be 30 characters or fewer');
    error.statusCode = 400;
    throw error;
  }

  if (!CONTACT_NUMBER_REGEX.test(normalizedContact)) {
    const error = new Error('Contact number format is invalid');
    error.statusCode = 400;
    throw error;
  }

  return normalizedContact;
}

function normalizeDepartment(input, { required = false } = {}) {
  const normalized = String(input || '').trim();
  if (!normalized) {
    if (required) {
      const error = new Error(`department is required and must be one of: ${DEPARTMENTS.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
    return '';
  }

  const matchedDepartment = DEPARTMENTS.find(
    (department) => department.toLowerCase() === normalized.toLowerCase()
  );

  if (!matchedDepartment) {
    const error = new Error(`department must be one of: ${DEPARTMENTS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }

  return matchedDepartment;
}

function normalizeProfileImageUrl(user, req) {
  const raw = String(user?.profileImage || '').trim();
  if (!raw) return '';
  if (req) return resolveStoredFileUrl(req, raw);
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return raw;
  return `/${raw}`;
}

function mapSectionReference(sectionValue) {
  if (!sectionValue) return null;

  const id = String(sectionValue?._id || sectionValue?.id || sectionValue || '').trim();
  const name = String(sectionValue?.name || '').trim();
  if (!id && !name) return null;

  return {
    id,
    name,
  };
}

function resolveLastActiveAt(user) {
  return user?.lastActivityAt || user?.lastLoginAt || user?.updatedAt || user?.createdAt || null;
}

function resolveIsOnline(user) {
  const lastActiveAt = resolveLastActiveAt(user);
  if (!lastActiveAt) return false;

  const lastSeen = new Date(lastActiveAt);
  if (Number.isNaN(lastSeen.getTime())) return false;

  return Date.now() - lastSeen.getTime() <= ONLINE_ACTIVITY_WINDOW_MS;
}

function mapUserResponse(user, req) {
  const plain = user?.toObject ? user.toObject() : user;
  const profileImage = normalizeProfileImageUrl(plain, req);
  const lastActivityAt = plain?.lastActivityAt || null;
  const lastLoginAt = plain?.lastLoginAt || null;
  const lastActive = resolveLastActiveAt(plain);
  const managedBy = plain?.managedBy
    ? {
      id: String(plain.managedBy?._id || plain.managedBy?.id || plain.managedBy || ''),
      name: String(plain.managedBy?.name || '').trim(),
      email: String(plain.managedBy?.email || '').trim(),
    }
    : null;
  const archivedBy = plain?.archive?.archivedBy
    ? {
      id: String(plain.archive.archivedBy?._id || plain.archive.archivedBy?.id || plain.archive.archivedBy || '').trim(),
      name: String(plain.archive.archivedBy?.name || '').trim(),
      email: String(plain.archive.archivedBy?.email || '').trim(),
    }
    : null;

  return {
    ...plain,
    subject: String(plain?.subject || '').trim(),
    department: String(plain?.department || '').trim(),
    sectionId: String(plain?.sectionId?._id || plain?.sectionId || '').trim(),
    advisorySectionId: String(plain?.advisorySectionId?._id || plain?.advisorySectionId || '').trim(),
    section: mapSectionReference(plain?.sectionId || plain?.section),
    advisorySection: mapSectionReference(plain?.advisorySectionId || plain?.advisorySection),
    forcePasswordChange: plain?.forcePasswordChange === true,
    temporaryPasswordIssuedAt: plain?.temporaryPasswordIssuedAt || null,
    profileImage,
    avatar: profileImage,
    lastLoginAt,
    lastActivityAt,
    lastActive,
    isOnline: resolveIsOnline({
      ...plain,
      lastLoginAt,
      lastActivityAt,
    }),
    inviteExpiresAt: plain?.invite?.expiresAt || null,
    inviteSentAt: plain?.invite?.sentAt || null,
    inviteUsedAt: plain?.invite?.usedAt || null,
    managedBy,
    managedById: String(plain?.managedBy?._id || plain?.managedBy || '').trim(),
    archive: {
      isArchived: plain?.archive?.isArchived === true,
      schoolYear: String(plain?.archive?.schoolYear || '').trim(),
      archivedAt: plain?.archive?.archivedAt || null,
      reason: String(plain?.archive?.reason || '').trim(),
      archivedBy,
    },
  };
}

function normalizeInviteExpiryHours(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return MIN_INVITE_EXPIRY_HOURS;
  }
  if (parsed < MIN_INVITE_EXPIRY_HOURS || parsed > MAX_INVITE_EXPIRY_HOURS) {
    const error = new Error(`expiresInHours must be between ${MIN_INVITE_EXPIRY_HOURS} and ${MAX_INVITE_EXPIRY_HOURS}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

async function sendInviteEmail({ toEmail, toName, inviteLink, expiresAt }) {
  const recipientEmail = String(toEmail || process.env.MAIL_DEFAULT_TO || '').trim();
  const recipientName = String(toName || process.env.MAIL_DEFAULT_TO_NAME || '').trim();
  if (!recipientEmail) {
    return { sent: false, reason: 'Recipient email is required' };
  }

  const expiresLabel = new Date(expiresAt).toLocaleString('en-US', { timeZoneName: 'short' });
  const displayName = recipientName || 'Learner';
  const subject = 'EduMatch Account Invitation';
  const text = `Hello ${displayName},\n\nWelcome to EduMatch.\n\nActivate your account using the secure link below:\n${inviteLink}\n\nThis invitation expires on ${expiresLabel}.\n\nIf you did not expect this invitation, you can safely ignore this email.`;
  const html = `
      <div style="max-width: 640px; margin: 0 auto; font-family: 'Segoe UI', Arial, sans-serif; color: #111111; background: #ffffff; border: 1px solid #d9d9d9; border-radius: 10px; overflow: hidden;">
        <div style="padding: 20px 24px; background: #111111; color: #ffffff; border-bottom: 1px solid #2b2b2b;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.2px;">EduMatch</h1>
          <p style="margin: 6px 0 0 0; font-size: 14px; color: #e5e5e5;">Account Invitation</p>
        </div>
        <div style="padding: 24px;">
          <p style="margin: 0 0 14px 0; font-size: 15px; color: #111111;">Hello <strong>${displayName}</strong>,</p>
          <p style="margin: 0 0 14px 0; font-size: 15px; line-height: 1.6; color: #222222;">
            Your EduMatch account has been created and is pending activation.
            Click the button below to activate your account and set your password.
          </p>
          <p style="margin: 20px 0;">
            <a href="${inviteLink}" style="display: inline-block; padding: 12px 18px; border-radius: 6px; background: #111111; color: #ffffff; text-decoration: none; font-weight: 600; border: 1px solid #111111;">
              Activate Account
            </a>
          </p>
          <p style="margin: 0 0 10px 0; font-size: 14px; color: #333333;">
            This secure invitation expires on <strong>${expiresLabel}</strong>.
          </p>
          <p style="margin: 0; font-size: 13px; color: #4a4a4a;">
            If the button does not work, copy and paste this URL into your browser:<br />
            <a href="${inviteLink}" style="color: #111111; word-break: break-all;">${inviteLink}</a>
          </p>
        </div>
      </div>
    `;

  return sendEmailViaGmail({
    to: [{ email: recipientEmail, name: recipientName }],
    cc: process.env.MAIL_DEFAULT_CC || '',
    bcc: process.env.MAIL_DEFAULT_BCC || '',
    attachments: [],
    subject,
    text,
    html,
  });
}

async function issueInviteForUser({ user, expiresInHours, req }) {
  const now = new Date();
  const temporaryPassword = generateTemporaryPassword();
  const appBaseUrl = String(process.env.APP_BASE_URL || req.get('origin') || '').trim().replace(/\/+$/, '');
  const frontendBase = appBaseUrl || `${req.protocol}://${req.get('host')}`;
  const loginLink = `${frontendBase}/auth/login`;

  user.password = temporaryPassword;
  user.status = 'active';
  user.forcePasswordChange = true;
  user.temporaryPasswordIssuedAt = now;
  user.invite = {
    tokenHash: '',
    expiresAt: null,
    sentAt: now,
    usedAt: null,
  };
  await user.save();

  const recipientEmail = String(user?.email || '').trim();
  const recipientName = String(user?.name || '').trim() || 'there';
  const subject = 'EduMatch Account Created';
  const text = `Hello ${recipientName},

Your EduMatch account has been created.

Email: ${recipientEmail}
Username: ${String(user?.username || '').trim()}
Temporary password: ${temporaryPassword}

For security reasons, you will be required to change this password when you log in for the first time.

Login here: ${loginLink}`;
  const html = `
    <div style="max-width: 640px; margin: 0 auto; font-family: 'Segoe UI', Arial, sans-serif; color: #111111; background: #ffffff; border: 1px solid #d9d9d9; border-radius: 10px; overflow: hidden;">
      <div style="padding: 20px 24px; background: #111111; color: #ffffff; border-bottom: 1px solid #2b2b2b;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0.2px;">EduMatch</h1>
        <p style="margin: 6px 0 0 0; font-size: 14px; color: #e5e5e5;">Account Created</p>
      </div>
      <div style="padding: 24px;">
        <p style="margin: 0 0 14px 0; font-size: 15px; color: #111111;">Hello <strong>${recipientName}</strong>,</p>
        <p style="margin: 0 0 14px 0; font-size: 15px; line-height: 1.6; color: #222222;">
          Your EduMatch account has been created. Use the temporary password below to sign in.
        </p>
        <div style="margin: 0 0 18px 0; padding: 16px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0;">
          <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Email:</strong> ${recipientEmail}</p>
          <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Username:</strong> ${String(user?.username || '').trim()}</p>
          <p style="margin: 0; font-size: 14px;"><strong>Temporary Password:</strong> ${temporaryPassword}</p>
        </div>
        <p style="margin: 0 0 14px 0; font-size: 14px; color: #374151;">
          For security reasons, you will be required to change this password immediately after your first login.
        </p>
        <p style="margin: 20px 0;">
          <a href="${loginLink}" style="display: inline-block; padding: 12px 18px; border-radius: 6px; background: #111111; color: #ffffff; text-decoration: none; font-weight: 600; border: 1px solid #111111;">
            Sign In to EduMatch
          </a>
        </p>
      </div>
    </div>
  `;

  const emailResult = await sendEmailViaGmail({
    to: [{ email: recipientEmail, name: recipientName }],
    cc: process.env.MAIL_DEFAULT_CC || '',
    bcc: process.env.MAIL_DEFAULT_BCC || '',
    attachments: [],
    subject,
    text,
    html,
  });

  return {
    inviteExpiresAt: null,
    inviteSentAt: now,
    inviteLink: '',
    generatedPassword: temporaryPassword,
    emailSent: emailResult.sent,
    emailError: emailResult.sent ? null : emailResult.reason,
  };
}

function applyRoleScopedFields(userPayload) {
  const rawRole = String(userPayload?.role || '').trim().toLowerCase();
  const role = rawRole === 'head_teacher' ? ROLE_HEADTEACHER : rawRole;
  const department = normalizeDepartment(userPayload?.department, {
    required: role === ROLE_HEADTEACHER || role === ROLE_TEACHER,
  });
  const subject = normalizeTeacherSubject(userPayload?.subject || '');

  return {
    department: role === ROLE_HEADTEACHER || role === ROLE_TEACHER ? department : '',
    subject: role === ROLE_TEACHER ? (subject || department) : '',
  };
}

module.exports = {
  DEPARTMENTS,
  normalizeTeacherSubject,
  normalizeContactNumber,
  normalizeDepartment,
  normalizeProfileImageUrl,
  mapUserResponse,
  normalizeInviteExpiryHours,
  sendInviteEmail,
  issueInviteForUser,
  applyRoleScopedFields,
};
