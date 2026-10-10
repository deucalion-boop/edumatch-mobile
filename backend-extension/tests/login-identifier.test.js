'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findAccountByLoginIdentifier } = require('../../backend/utils/loginIdentifier');

test('exact username wins over a different account with the same email identifier', async () => {
  const usernameAccount = { id: 'username-account' };
  const calls = [];
  const result = await findAccountByLoginIdentifier('  Teacher@Gmail.com  ', {
    async findByUsername(value) { calls.push(['username', value]); return usernameAccount; },
    async findByEmail() { assert.fail('A matched username must not fall back to email.'); },
  });

  assert.equal(result, usernameAccount);
  assert.deepEqual(calls, [['username', 'Teacher@Gmail.com']]);
});

test('an unmatched ordinary username does not use the email lookup', async () => {
  const result = await findAccountByLoginIdentifier('Teacher01', {
    async findByUsername(value) { assert.equal(value, 'Teacher01'); return null; },
    async findByEmail() { assert.fail('Ordinary usernames must not use the email lookup.'); },
  });

  assert.equal(result, null);
});

test('email sign-in falls back after username lookup and normalizes email case', async () => {
  const emailAccount = { id: 'email-account' };
  const calls = [];
  const result = await findAccountByLoginIdentifier('  Teacher@Gmail.com  ', {
    async findByUsername(value) { calls.push(['username', value]); return null; },
    async findByEmail(value) { calls.push(['email', value]); return emailAccount; },
  });

  assert.equal(result, emailAccount);
  assert.deepEqual(calls, [['username', 'Teacher@Gmail.com'], ['email', 'teacher@gmail.com']]);
});

test('an unknown email returns no account', async () => {
  const result = await findAccountByLoginIdentifier('missing@gmail.com', {
    async findByUsername() { return null; },
    async findByEmail() { return null; },
  });

  assert.equal(result, null);
});

test('empty identifiers never query accounts', async () => {
  const lookups = {
    async findByUsername() { assert.fail('Empty identifiers must not query accounts.'); },
    async findByEmail() { assert.fail('Empty identifiers must not query accounts.'); },
  };
  for (const value of [undefined, null, '', '  ']) {
    assert.equal(await findAccountByLoginIdentifier(value, lookups), null);
  }
});

test('username lookup failures propagate without falling back to a different account', async () => {
  const failure = new Error('Username lookup unavailable');
  await assert.rejects(findAccountByLoginIdentifier('teacher@gmail.com', {
    async findByUsername() { throw failure; },
    async findByEmail() { assert.fail('A failed lookup must not fall back to email.'); },
  }), error => error === failure);
});

test('email lookup failures propagate', async () => {
  const failure = new Error('Email lookup unavailable');
  await assert.rejects(findAccountByLoginIdentifier('teacher@gmail.com', {
    async findByUsername() { return null; },
    async findByEmail() { throw failure; },
  }), error => error === failure);
});
