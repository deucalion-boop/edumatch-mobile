'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const userRoles = require('../../backend/constants/userRoles');
const sectionConstants = require('../../backend/constants/sections');

const backendRoot = join(__dirname, '../../backend');
const controllerSource = readFileSync(join(backendRoot, 'controllers/adminController.js'), 'utf8');
const sectionSource = readFileSync(join(backendRoot, 'services/sectionService.js'), 'utf8');
const managementSource = readFileSync(join(backendRoot, 'services/userManagementService.js'), 'utf8');

function loadModule(source, requireMock) {
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: requireMock, console });
  return module.exports;
}

function createHarness({ sectionReadError, existingHeadTeacher } = {}) {
  const inserts = [];
  const invites = [];
  const sectionQueries = [];
  const departmentQueries = [];
  const events = [];
  const emailQueries = [];
  const accounts = {
    async findSupabaseAccountByEmail(email) { emailQueries.push(email); return null; },
    async findSupabaseHeadTeacherByDepartment(department) {
      departmentQueries.push(department);
      return existingHeadTeacher || null;
    },
    async createSupabaseAccount(payload) {
      events.push('insert');
      inserts.push(payload);
      return { ...payload, _id: 'new-account' };
    },
  };
  const sectionService = loadModule(sectionSource, name => {
    if (name === './supabaseStorageService') return {
      getSupabaseStorageClient() {
        return {
          from(table) {
            assert.equal(table, 'sections');
            const filters = {};
            const query = {
              select() { return query; },
              eq(key, value) { filters[key] = value; return query; },
              limit() { return query; },
              async maybeSingle() {
                sectionQueries.push(filters);
                events.push('section');
                if (sectionReadError) return { data: null, error: sectionReadError };
                const row = filters.id === 'active-section'
                  ? { id: 'active-section', name: 'Aster', is_active: true }
                  : filters.id === 'inactive-section'
                    ? { id: 'inactive-section', name: 'Birch', is_active: false } : null;
                return { data: row && (filters.is_active === undefined || row.is_active === filters.is_active) ? row : null, error: null };
              },
            };
            return query;
          },
        };
      },
    };
    if (name === './supabaseAccountService') return accounts;
    if (name === '../constants/sections') return sectionConstants;
    if (name === '../constants/userRoles') return userRoles;
    throw new Error(`Unexpected section dependency: ${name}`);
  });
  const userManagementService = loadModule(managementSource, name => {
    if (name === '../constants/userRoles') return userRoles;
    return {};
  });
  const controller = loadModule(controllerSource, name => {
    if (name === '../constants/userRoles') return userRoles;
    if (name === '../services/sectionService') return sectionService;
    if (name === '../services/supabaseAccountService') return accounts;
    if (name === '../services/userManagementService') return {
      ...userManagementService,
      async issueInviteForUser({ user }) { invites.push(user._id); return {}; },
    };
    if (name === '../utils/responseHelper') return {
      sendSuccess(res, statusCode, message, body) { Object.assign(res, { statusCode, message, body }); },
    };
    // The controller imports other handlers' dependencies at module scope. Leave
    // those inert so these tests cannot load real models, credentials or clients.
    return {};
  });
  async function create(handler, body = {}, actorRole = 'admin') {
    const res = {};
    let error;
    await controller[handler]({
      user: { _id: 'creator', role: actorRole },
      body: { name: 'Sample Student', email: 'student@gmail.com', username: 'student01', role: 'student', ...body },
    }, res, value => { error = value; });
    return { res, error };
  }
  return { create, inserts, invites, sectionQueries, departmentQueries, emailQueries, events };
}

const handlers = ['createUser', 'createAndInviteUser'];
const managedRoles = userRoles.USER_ROLES.filter(role => role !== 'admin');

test('admin and secretary creation validate and persist an active Section before inserting', async () => {
  for (const handler of handlers) {
    for (const actorRole of ['admin', 'secretary']) {
      const harness = createHarness();
      const { res, error } = await harness.create(handler, { sectionId: '  active-section  ' }, actorRole);
      assert.equal(error, undefined);
      assert.deepEqual(harness.events, ['section', 'insert']);
      assert.deepEqual(harness.sectionQueries, [{ id: 'active-section', is_active: true }]);
      assert.equal(harness.inserts[0].sectionId, 'active-section');
      assert.equal(harness.inserts[0].strand, '');
      assert.equal(harness.inserts[0].gradeLevel, 'Grade 10');
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.user.sectionId, 'active-section');
      assert.deepEqual(harness.invites, ['new-account']);
    }
  }
});

test('legacy creation without a Section remains accepted without a Section query', async () => {
  for (const handler of handlers) {
    for (const sectionId of [undefined, null, '', '  ']) {
      const harness = createHarness();
      const { res, error } = await harness.create(handler, { sectionId });
      assert.equal(error, undefined);
      assert.equal(harness.inserts[0].sectionId, undefined);
      assert.equal(res.body.user.sectionId, '');
      assert.equal(harness.sectionQueries.length, 0);
    }
  }
});

test('missing or inactive Sections reject creation before account or onboarding writes', async () => {
  for (const handler of handlers) {
    for (const sectionId of ['missing-section', 'inactive-section']) {
      const harness = createHarness();
      const { error } = await harness.create(handler, { sectionId });
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, 'Section not found');
      assert.equal(harness.inserts.length, 0);
      assert.equal(harness.invites.length, 0);
    }
  }
});

test('Section storage failures propagate without partially creating an account', async () => {
  for (const handler of handlers) {
    const harness = createHarness({ sectionReadError: { message: 'Section storage unavailable' } });
    const { error } = await harness.create(handler, { sectionId: 'active-section' });
    assert.equal(error.statusCode, 500);
    assert.equal(error.message, 'Section storage unavailable');
    assert.equal(harness.inserts.length, 0);
    assert.equal(harness.invites.length, 0);
  }
});

test('a Section in a staff payload does not create a student Section assignment', async () => {
  for (const handler of handlers) {
    const harness = createHarness();
    const { error } = await harness.create(handler, { role: 'teacher', department: 'Science', sectionId: 'inactive-section' }, 'secretary');
    assert.equal(error, undefined);
    assert.equal(harness.inserts[0].sectionId, undefined);
    assert.equal(harness.sectionQueries.length, 0);
  }
});

test('role restrictions still reject unsupported actors before Section lookup or insertion', async () => {
  for (const handler of handlers) {
    const harness = createHarness();
    const { error } = await harness.create(handler, { sectionId: 'active-section' }, 'teacher');
    assert.equal(error.statusCode, 403);
    assert.equal(harness.sectionQueries.length, 0);
    assert.equal(harness.inserts.length, 0);
  }
});

test('required account fields still reject incomplete forms before Section lookup', async () => {
  for (const handler of handlers) {
    const harness = createHarness();
    const { error } = await harness.create(handler, { username: '', sectionId: 'active-section' });
    assert.equal(error.statusCode, 400);
    assert.equal(harness.sectionQueries.length, 0);
    assert.equal(harness.inserts.length, 0);
  }
});

test('admin and secretary creation require a nonblank username for every managed account role', async () => {
  for (const handler of handlers) {
    for (const actorRole of ['admin', 'secretary']) {
      for (const role of managedRoles) {
        for (const username of [undefined, null, '', '  ', '\t\n']) {
          const harness = createHarness();
          const { error } = await harness.create(handler, {
            role, username, department: 'Science', sectionId: 'active-section',
          }, actorRole);
          assert.equal(error.statusCode, 400);
          assert.equal(error.message, 'name, email, username, and role are required');
          assert.equal(harness.emailQueries.length, 0);
          assert.equal(harness.departmentQueries.length, 0);
          assert.equal(harness.sectionQueries.length, 0);
          assert.equal(harness.inserts.length, 0);
          assert.equal(harness.invites.length, 0);
        }
      }
    }
  }
});

test('admin creation trims and persists the username for every managed account role', async () => {
  for (const handler of handlers) {
    for (const role of managedRoles) {
      const harness = createHarness();
      const { res, error } = await harness.create(handler, {
        role, username: '  sample.account  ', department: 'Science', sectionId: 'active-section',
      });
      assert.equal(error, undefined);
      assert.equal(harness.inserts[0].username, 'sample.account');
      assert.equal(res.body.user.username, 'sample.account');
      assert.deepEqual(harness.invites, ['new-account']);
    }
  }
});

test('student creation leaves strand unassigned even when a legacy payload supplies one', async () => {
  for (const handler of handlers) {
    for (const actorRole of ['admin', 'secretary']) {
      for (const strand of ['STEM', 'ABM', 'legacy-strand']) {
        const harness = createHarness();
        const { res, error } = await harness.create(handler, { strand }, actorRole);
        assert.equal(error, undefined);
        assert.equal(res.statusCode, 201);
        assert.equal(harness.inserts[0].strand, '');
        assert.equal(harness.inserts[0].gradeLevel, 'Grade 10');
      }
    }
  }
});

test('secretary creation succeeds without department and ignores stale department fields', async () => {
  for (const handler of handlers) {
    for (const department of [undefined, '', 'Science', 'Monitoring']) {
      const harness = createHarness();
      const { res, error } = await harness.create(handler, { role: 'secretary', department });
      assert.equal(error, undefined);
      assert.equal(res.statusCode, 201);
      assert.equal(harness.inserts[0].department, '');
      assert.equal(harness.inserts[0].subject, '');
      assert.equal(harness.departmentQueries.length, 0);
    }
  }
});

test('teacher and head teacher creation persist the selected department', async () => {
  for (const handler of handlers) {
    for (const actorRole of ['admin', 'secretary']) {
      for (const role of ['teacher', 'headteacher', 'head_teacher']) {
        for (const department of userRoles.DEPARTMENTS) {
          const harness = createHarness();
          const { res, error } = await harness.create(handler, {
            role, department: `  ${department.toLowerCase()}  `,
          }, actorRole);
          assert.equal(error, undefined);
          assert.equal(res.statusCode, 201);
          assert.equal(harness.inserts[0].department, department);
          assert.equal(res.body.user.department, department);
          assert.equal(harness.inserts[0].subject, role === 'teacher' ? department : '');
        }
      }
    }
  }
});

test('teacher and head teacher creation reject missing or unsupported departments before writes', async () => {
  for (const handler of handlers) {
    for (const role of ['teacher', 'headteacher']) {
      for (const department of [undefined, '', '  ', 'Unsupported department']) {
        const harness = createHarness();
        const { error } = await harness.create(handler, { role, department });
        assert.equal(error.statusCode, 400);
        assert.equal(harness.inserts.length, 0);
        assert.equal(harness.invites.length, 0);
      }
    }
  }
});

test('head teacher creation still prevents duplicate heads for the selected department', async () => {
  for (const handler of handlers) {
    const harness = createHarness({ existingHeadTeacher: { _id: 'existing-head' } });
    const { error } = await harness.create(handler, { role: 'headteacher', department: 'Science' });
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, 'This department already has a Head Teacher assigned');
    assert.deepEqual(harness.departmentQueries, ['Science']);
    assert.equal(harness.inserts.length, 0);
    assert.equal(harness.invites.length, 0);
  }
});
