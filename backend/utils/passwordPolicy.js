const crypto = require('crypto');

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 16;
const TEMP_PASSWORD_LENGTH = 12;
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const NUMBERS = '23456789';
const SPECIAL = '!@#$%^&*';
const ALL_TEMP_PASSWORD_CHARSETS = `${UPPERCASE}${LOWERCASE}${NUMBERS}${SPECIAL}`;

function randomChar(charset) {
  const bytes = crypto.randomBytes(1);
  return charset[bytes[0] % charset.length];
}

function shuffleCharacters(characters) {
  const shuffled = [...characters];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled.join('');
}

function generateTemporaryPassword(length = TEMP_PASSWORD_LENGTH) {
  const resolvedLength = Math.max(10, Number(length) || TEMP_PASSWORD_LENGTH);
  const requiredCharacters = [
    randomChar(UPPERCASE),
    randomChar(LOWERCASE),
    randomChar(NUMBERS),
    randomChar(SPECIAL),
  ];

  while (requiredCharacters.length < resolvedLength) {
    requiredCharacters.push(randomChar(ALL_TEMP_PASSWORD_CHARSETS));
  }

  return shuffleCharacters(requiredCharacters);
}

function getPasswordValidationErrors(password, maxLength = PASSWORD_MAX_LENGTH) {
  const normalizedPassword = String(password || '');
  const errors = [];

  if (normalizedPassword.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }
  if (normalizedPassword.length > maxLength) {
    errors.push(`Password must be no more than ${maxLength} characters long`);
  }
  if (!/[A-Z]/.test(normalizedPassword)) {
    errors.push('Password must include at least one uppercase letter');
  }
  if (!/[a-z]/.test(normalizedPassword)) {
    errors.push('Password must include at least one lowercase letter');
  }
  if (!/[0-9]/.test(normalizedPassword)) {
    errors.push('Password must include at least one number');
  }

  return errors;
}

function assertPasswordMeetsPolicy(password, maxLength = PASSWORD_MAX_LENGTH) {
  const errors = getPasswordValidationErrors(password, maxLength);
  if (errors.length === 0) return;

  const error = new Error(errors[0]);
  error.statusCode = 400;
  throw error;
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  TEMP_PASSWORD_LENGTH,
  generateTemporaryPassword,
  getPasswordValidationErrors,
  assertPasswordMeetsPolicy,
};
