const nameError = (value, label = 'Name', max = 50) => {
  const name = String(value || '').trim()
  if (!name) return label + ' is required.'
  if (name.length > max) return label + ' must be ' + max + ' characters or fewer.'
  if (!/^[\p{L}\p{M} '\u2019-]+$/u.test(name) || !/\p{L}/u.test(name)) return label + ' may contain letters, spaces, hyphens, and apostrophes only; numbers are not allowed.'
  return ''
}
const phoneError = (value) => {
  const phone = String(value || '').trim()
  return !phone || /^(09\d{9}|\+639\d{9})$/.test(phone) ? '' : 'Enter a valid Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.'
}
const passwordLengthError = (value) => {
  const length = String(value || '').length
  return length >= 8 && length <= 17 ? '' : 'Password must be 8-17 characters.'
}

module.exports = { nameError, phoneError, passwordLengthError };
