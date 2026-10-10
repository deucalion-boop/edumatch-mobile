'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('installer check is read-only, apply is backed up/idempotent, and unmanaged edits are rejected', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edumatch-mobile-install-test-'));
  const backend = path.join(tempRoot, 'backend');
  try {
    for (const directory of ['middlewares', 'services', 'controllers', 'supabase/migrations']) {
      fs.mkdirSync(path.join(backend, directory), { recursive: true });
    }
    for (const file of ['middlewares/authMiddleware.js', 'services/supabaseStorageService.js', 'controllers/attendanceController.js']) {
      fs.writeFileSync(path.join(backend, file), 'module.exports = {};\n');
    }
    const original = 'const app = {};\napp.use(notFoundMiddleware);\napp.use(errorMiddleware);\n';
    const serverPath = path.join(backend, 'server.js');
    fs.writeFileSync(serverPath, original);
    const run = (mode) => spawnSync(process.execPath, [path.join(__dirname, '../install.cjs'), '--backend', backend, mode], { encoding: 'utf8' });
    const check = run('--check');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(fs.readFileSync(serverPath, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(backend, 'mobile')), false);
    const apply = run('--apply');
    assert.equal(apply.status, 0, apply.stderr);
    const integrated = fs.readFileSync(serverPath, 'utf8');
    assert.match(integrated, /app\.use\('\/api\/mobile'/);
    assert.ok(integrated.indexOf("'/api/mobile'") < integrated.indexOf('notFoundMiddleware'));
    const backups = fs.readdirSync(path.join(backend, 'mobile-backups'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(backend, 'mobile-backups', backups[0]), 'utf8'), original);
    assert.ok(fs.existsSync(path.join(backend, 'supabase/migrations/013_mobile_attendance.sql')));
    assert.equal(run('--apply').status, 0);
    assert.equal(fs.readFileSync(serverPath, 'utf8'), integrated);
    assert.equal(fs.readdirSync(path.join(backend, 'mobile-backups')).length, 1);
    fs.appendFileSync(path.join(backend, 'mobile/lib/attendance.js'), '\n// independent edit\n');
    const conflicting = run('--apply');
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /unmanaged edits/);
  } finally {
    // Only remove this test's resolved directory under the actual temp root.
    const verified = fs.realpathSync(tempRoot);
    const realTemp = fs.realpathSync(os.tmpdir());
    if (!verified.startsWith(realTemp + path.sep) || !path.basename(verified).startsWith('edumatch-mobile-install-test-')) {
      throw new Error('Refusing to clean up an unexpected test directory');
    }
    fs.rmSync(verified, { recursive: true });
  }
});
