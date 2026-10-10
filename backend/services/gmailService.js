const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_MAIL_API_URL = 'https://unokamaleg.com/mail-api/legatic-mail.php';
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeRecipient(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const email = sanitizeHeader(input);
    return email ? { email, name: '' } : null;
  }

  const email = sanitizeHeader(input.email || input.address || '');
  const name = sanitizeHeader(input.name || '');
  if (!email) return null;
  return { email, name };
}

function normalizeRecipientList(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((entry) => normalizeRecipient(entry)).filter(Boolean);
  }
  if (typeof input === 'object') {
    const one = normalizeRecipient(input);
    return one ? [one] : [];
  }
  return String(input)
    .split(',')
    .map((entry) => normalizeRecipient(entry))
    .filter(Boolean);
}

function normalizeBase64(input) {
  const raw = String(input || '').trim();
  const withoutPrefix = raw.includes(',') ? raw.split(',').pop() : raw;
  return withoutPrefix.replace(/\s+/g, '');
}

function normalizeAttachments(input) {
  const attachments = Array.isArray(input) ? input : [];

  return attachments.map((attachment, index) => {
    const filename = sanitizeHeader(attachment.filename || `attachment-${index + 1}`);
    const type = sanitizeHeader(attachment.type || attachment.contentType || 'application/octet-stream');
    const content = normalizeBase64(attachment.content || attachment.contentBase64 || attachment.base64);

    if (!content) {
      throw new Error(`Attachment "${filename}" is missing a Base64 payload`);
    }

    return { filename, content, type };
  });
}

function validateMailApiEnvironment() {
  const mailApiUrl = String(process.env.MAIL_API_URL || DEFAULT_MAIL_API_URL).trim();
  const mailApiKey = String(process.env.MAIL_API_KEY || '').trim();

  const missing = [];
  if (!mailApiUrl) missing.push('MAIL_API_URL');
  if (!mailApiKey) missing.push('MAIL_API_KEY');

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Mail API is not configured. Missing: ${missing.join(', ')}`,
      mailApiUrl,
      mailApiKey: '',
    };
  }

  return { ok: true, mailApiUrl, mailApiKey };
}

async function sendEmailViaGmail(options) {
  const validation = validateMailApiEnvironment();
  if (!validation.ok) {
    return { sent: false, reason: validation.reason };
  }

  const toList = normalizeRecipientList(options.to);
  const ccList = normalizeRecipientList(options.cc);
  const bccList = normalizeRecipientList(options.bcc);

  if (!toList.length) {
    const error = new Error('At least one "to" recipient is required');
    error.statusCode = 400;
    throw error;
  }

  const primaryTo = toList[0];
  const html = String(options.html || '').trim();
  const text = String(options.text || '').trim();
  const fallbackText = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fallbackHtml = html || `<pre>${fallbackText}</pre>`;

  const payload = {
    to: primaryTo.email,
    to_name: primaryTo.name || '',
    subject: sanitizeHeader(options.subject || '(no subject)'),
    html: fallbackHtml,
    text: fallbackText,
    cc: ccList.map((entry) => entry.email),
    bcc: bccList.map((entry) => entry.email),
    attachments: normalizeAttachments(options.attachments),
  };

  const response = await fetch(validation.mailApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': validation.mailApiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch (_error) {
    parsedBody = null;
  }

  if (!response.ok) {
    return {
      sent: false,
      reason: `Mail API request failed (${response.status}). ${rawBody || 'No response body'}`,
    };
  }

  if (parsedBody && parsedBody.success === false) {
    return {
      sent: false,
      reason: String(parsedBody.message || 'Mail API rejected the request'),
    };
  }

  return {
    sent: true,
    id: parsedBody?.id || parsedBody?.message_id || null,
    threadId: null,
    from: null,
    authenticatedEmail: null,
  };
}

module.exports = {
  sendEmailViaGmail,
  validateMailApiEnvironment,
};
