'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const userRoles = require('../../backend/constants/userRoles');

const controllerSource = readFileSync(join(__dirname, '../../backend/controllers/headteacherController.js'), 'utf8');

function createHarness() {
  const events = [];
  const unexpectedCall = name => async () => { events.push(name); throw new Error(`Unexpected ${name}`); };
  const module = { exports: {} };
  runInNewContext(controllerSource, {
    module,
    exports: module.exports,
    console,
    require(name) {
      if (name === '../constants/userRoles') return userRoles;
      if (name === '../services/supabaseAccountService') return {
        findSupabaseAccount: unexpectedCall('teacher lookup'),
        findSupabaseAccountByEmail: unexpectedCall('email lookup'),
        findSupabaseAccountByUsername: unexpectedCall('username lookup'),
        createSupabaseAccount: unexpectedCall('account insert'),
      };
      if (name === '../services/sectionService') return { getSectionOrThrow: unexpectedCall('section lookup') };
      if (name === '../services/userManagementService') return { issueInviteForUser: unexpectedCall('onboarding email') };
      // Keep unrelated controller dependencies inert; no live models or credentials are loaded.
      return {};
    },
  });
  async function create(handler, username) {
    let error;
    await module.exports[handler]({
      user: { _id: 'headteacher-id', role: 'headteacher', department: 'Science' },
      body: { teacherId: 'teacher-id', name: 'Sample Account', email: 'account@gmail.com', username },
    }, {}, value => { error = value; });
    return error;
  }
  return { create, events };
}

test('head teacher creation rejects missing or whitespace usernames before lookups or writes', async () => {
  for (const handler of ['createTeacherAccount', 'createStudentAccount']) {
    for (const username of [undefined, null, '', '  ', '\t\n']) {
      const harness = createHarness();
      const error = await harness.create(handler, username);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, handler === 'createTeacherAccount'
        ? 'name, email, and username are required'
        : 'teacherId, name, email, and username are required');
      assert.deepEqual(harness.events, []);
    }
  }
});
