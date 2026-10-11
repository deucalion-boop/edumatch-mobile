/** A missing or invalid policy never removes the sign-in security check. */
export async function requireRecaptchaForAttempt(loadPolicy: () => Promise<unknown>, step: 'login' | 'verify-code' = 'login'): Promise<boolean> {
  if (step === 'verify-code') return false;
  try {
    const policy = await loadPolicy();
    return !policy || typeof policy !== 'object' || Array.isArray(policy)
      || (policy as { recaptchaEnabled?: unknown }).recaptchaEnabled !== false;
  } catch {
    return true;
  }
}
