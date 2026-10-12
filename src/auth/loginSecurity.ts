/** The initial login always requires a server-verified math challenge. */
export function requireCaptchaForAttempt(step: 'login' | 'verify-code' = 'login'): boolean {
  // An emailed OTP continues the initial, already CAPTCHA-verified login.
  return step === 'login';
}
