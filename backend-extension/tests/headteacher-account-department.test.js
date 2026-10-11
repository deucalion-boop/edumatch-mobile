'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const userRoles = require('../../backend/constants/userRoles');
const teacherValidation = require('../../backend/utils/teacherValidation');

const backendRoot = join(__dirname, '../../backend');
const controllerSource = readFileSync(join(backendRoot, 'controllers/headteacherController.js'), 'utf8');
const managementSource = readFileSync(join(backendRoot, 'services/userManagementService.js'), 'utf8');

function loadModule(source, requireMock) {
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: requireMock, console });
  return module.exports;
}

function createHarness({ headTeacher = { _id: 'headteacher-id' }, lookupError } = {}) {
  const inserts = [];
  const invites = [];
  const departmentQueries = [];
  const accounts = {
    async findSupabaseAccountByEmail() { return null; },
    async findSupabaseAccountByUsername() { return null; },
    async findSupabaseHeadTeacherByDepartment(department) {
      departmentQueries.push(department);
      if (lookupError) throw lookupError;
      return headTeacher;
    },
    async createSupabaseAccount(payload) {
      inserts.push(payload);
      return { ...payload, _id: 'new-teacher' };
    },
  };
  const management = loadModule(managementSource, name => {
    if (name === '../constants/userRoles') return userRoles;
    if (name === './supabaseAccountService') return accounts;
    return {};
  });
  const controller = loadModule(controllerSource, name => {
    if (name === '../constants/userRoles') return userRoles;
    if (name === '../utils/teacherValidation') return teacherValidation;
    if (name === '../services/supabaseAccountService') return accounts;
    if (name === '../services/userManagementService') return {
      ...management,
      async issueInviteForUser({ user }) { invites.push(user._id); return {}; },
    };
    if (name === '../utils/responseHelper') return {
      sendSuccess(res, statusCode, message, body) { Object.assign(res, { statusCode, message, body }); },
    };
    // No live database, models, email or credentials are loaded by this harness.
    return {};
  });
  async function create(body = {}, user = {}) {
    const res = {};
    let error;
    await controller.createTeacherAccount({
      user: { _id: 'headteacher-id', role: 'headteacher', department: 'Science', ...user },
      body: { name: 'Sample Teacher', email: 'teacher@gmail.com', username: 'sample.teacher', ...body },
    }, res, value => { error = value; });
    return { res, error };
  }
  return { create, inserts, invites, departmentQueries };
}

test('a Head Teacher creates teachers in their own available department and remains their manager', async () => {
  const harness = createHarness();
  const { res, error } = await harness.create({ department: 'English' });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(harness.departmentQueries, ['Science']);
  assert.equal(harness.inserts[0].department, 'Science');
  assert.equal(harness.inserts[0].managedBy, 'headteacher-id');
  assert.equal(res.body.user.managedById, 'headteacher-id');
  assert.deepEqual(harness.invites, ['new-teacher']);
});

test('Head Teacher teacher creation rejects a missing stored department head before writes', async () => {
  const harness = createHarness({ headTeacher: null });
  const { error } = await harness.create();
  assert.equal(error.statusCode, 400);
  assert.equal(error.message, 'Create a Head Teacher for the Science department before creating a Teacher account.');
  assert.deepEqual(harness.departmentQueries, ['Science']);
  assert.equal(harness.inserts.length, 0);
  assert.equal(harness.invites.length, 0);
});

test('Head Teacher teacher creation propagates department storage errors without writes', async () => {
  const lookupError = Object.assign(new Error('Department storage unavailable'), { statusCode: 500 });
  const harness = createHarness({ lookupError });
  const { error } = await harness.create();
  assert.equal(error, lookupError);
  assert.equal(harness.inserts.length, 0);
  assert.equal(harness.invites.length, 0);
});

test('teacher department availability does not grant other roles access to Head Teacher creation', async () => {
  const harness = createHarness();
  const { error } = await harness.create({}, { role: 'teacher' });
  assert.equal(error.statusCode, 403);
  assert.equal(harness.departmentQueries.length, 0);
  assert.equal(harness.inserts.length, 0);
  assert.equal(harness.invites.length, 0);
});
