/** A missing or invalid policy never removes the sign-in security check. */
export async function requireRecaptchaForAttempt(loadPolicy: () => Promise<unknown>): Promise<boolean> {
  try {
    const policy = await loadPolicy();
    return !policy || typeof policy !== 'object' || Array.isArray(policy)
      || (policy as { recaptchaEnabled?: unknown }).recaptchaEnabled !== false;
  } catch {
    return true;
  }
}
