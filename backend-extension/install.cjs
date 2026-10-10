'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const START = '// EduMatch mobile extension (managed by edumatch-mobile).';
const END = '// End EduMatch mobile extension.';
const MOUNT = `${START}\nconst { createMobileRouter, loadExistingBackend } = require('./mobile');\napp.use('/api/mobile', createMobileRouter(loadExistingBackend(__dirname)));\n${END}`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function main() {
  const args = process.argv.slice(2);
  const backendFlag = args.indexOf('--backend');
  if (backendFlag < 0 || !args[backendFlag + 1] || args.includes('--apply') === args.includes('--check')) {
    throw new Error('Usage: node backend-extension/install.cjs --backend PATH --check|--apply');
  }
  const backend = fs.realpathSync(path.resolve(args[backendFlag + 1]));
  const source = path.resolve(__dirname);
  const serverPath = path.join(backend, 'server.js');
  const originalServer = fs.readFileSync(serverPath, 'utf8');
  const server = originalServer.replace(/\r\n/g, '\n');
  for (const expected of ['middlewares/authMiddleware.js', 'services/supabaseStorageService.js', 'controllers/attendanceController.js', 'supabase/migrations']) {
    if (!fs.existsSync(path.join(backend, expected))) throw new Error(`Not a compatible EduMatch backend: missing ${expected}`);
  }
  if (source.startsWith(backend + path.sep) || source === backend) throw new Error('Run this installer from the separate mobile project');
  let updatedServer = server;
  if (server.includes(START)) {
    const first = server.indexOf(START);
    const last = server.indexOf(END, first);
    if (last < 0 || server.indexOf(START, first + START.length) >= 0
      || server.slice(first, last + END.length) !== MOUNT) throw new Error('Existing managed mobile mount was edited; review it before updating');
  } else {
    const marker = 'app.use(notFoundMiddleware);';
    if (server.split(marker).length !== 2 || server.includes("'/api/mobile'") || server.includes('"/api/mobile"')) {
      throw new Error('Cannot identify an unambiguous mobile mount location before notFoundMiddleware');
    }
    updatedServer = server.replace(marker, `${MOUNT}\n\n${marker}`);
  }
  if (originalServer.includes('\r\n')) updatedServer = updatedServer.replace(/\n/g, '\r\n');

  const manifestPath = path.join(backend, 'mobile', '.edumatch-mobile-managed.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
  const files = [];
  function append(sourcePath, relativeDestination) {
    const destination = path.resolve(backend, relativeDestination);
    if (!destination.startsWith(backend + path.sep)) throw new Error('Destination escapes backend root');
    let existingParent = destination;
    while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
    const realParent = fs.realpathSync(existingParent);
    if (realParent !== backend && !realParent.startsWith(backend + path.sep)) throw new Error(`Destination uses an external symlink: ${relativeDestination}`);
    const content = fs.readFileSync(sourcePath);
    if (fs.existsSync(destination)) {
      const oldContent = fs.readFileSync(destination);
      if (hash(oldContent) !== hash(content) && previous.files[relativeDestination] !== hash(oldContent)) {
        throw new Error(`Existing file contains unmanaged edits: ${relativeDestination}`);
      }
    }
    files.push({ destination, relativeDestination, content, action: !fs.existsSync(destination) ? 'create'
      : hash(fs.readFileSync(destination)) === hash(content) ? 'unchanged' : 'update' });
  }
  for (const file of ['index.js', 'package.json', 'README.md']) append(path.join(source, file), `mobile/${file}`);
  for (const directory of ['lib', 'scripts']) {
    for (const file of fs.readdirSync(path.join(source, directory)).filter((file) => file.endsWith('.js'))) {
      append(path.join(source, directory, file), `mobile/${directory}/${file}`);
    }
  }
  for (const file of fs.readdirSync(path.join(source, 'migrations')).filter((file) => file.endsWith('.sql'))) {
    append(path.join(source, 'migrations', file), `supabase/migrations/${file}`);
  }
  const changed = files.filter((file) => file.action !== 'unchanged');
  const serverChanged = updatedServer !== originalServer;
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'check', backend,
    server: { action: serverChanged ? 'update' : 'unchanged', insertion: MOUNT },
    files: files.map(({ relativeDestination, action }) => ({ path: relativeDestination, action })),
    migrationsApplied: false, note: 'Migrations are copied for review. This installer never runs SQL or starts services.' }, null, 2));
  if (!args.includes('--apply')) return;
  if (serverChanged) {
    const backupPath = path.join(backend, 'mobile-backups', `server.${Date.now()}.js`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, originalServer, { flag: 'wx' });
    console.log(`Server backup: ${backupPath}`);
  }
  for (const file of changed) {
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.writeFileSync(file.destination, file.content);
  }
  if (serverChanged) fs.writeFileSync(serverPath, updatedServer);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1,
    files: Object.fromEntries(files.map((file) => [file.relativeDestination, hash(file.content)])) }, null, 2) + '\n');
  console.log('Mobile API integration installed. Apply migrations 013 and 014 before using attendance or push registration.');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
