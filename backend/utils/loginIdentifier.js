'use strict';

async function findAccountByLoginIdentifier(identifier, { findByUsername, findByEmail }) {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;

  // Existing usernames keep precedence, including usernames that look like email addresses.
  const usernameAccount = await findByUsername(normalized);
  if (usernameAccount || !normalized.includes('@')) return usernameAccount;

  return findByEmail(normalized.toLowerCase());
}

module.exports = { findAccountByLoginIdentifier };
