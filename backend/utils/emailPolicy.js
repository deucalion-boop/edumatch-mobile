const GMAIL_EMAIL_REGEX = /^[a-z0-9]+(?:\.[a-z0-9]+)*(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?@gmail\.com$/i;
const GMAIL_EMAIL_MESSAGE = 'Please enter a valid Gmail address (e.g., user@gmail.com).';
function isValidGmailEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && email.split('@')[0].length <= 64 && GMAIL_EMAIL_REGEX.test(email);
}
function assertGmailEmail(value) {
  if (!isValidGmailEmail(value)) {
    throw Object.assign(new Error(GMAIL_EMAIL_MESSAGE), { statusCode: 400 });
  }
  return String(value).trim().toLowerCase();
}
module.exports = { isValidGmailEmail, assertGmailEmail };
