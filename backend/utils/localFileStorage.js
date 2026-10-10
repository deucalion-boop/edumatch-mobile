const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');

const LOCAL_UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');

function invalidPath() {
  const error = new Error('Stored file path is invalid');
  error.statusCode = 400;
  return error;
}

function normalizeLocalStoredPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  // A leading /uploads/ is a legacy URL path, never an absolute disk path.
  const normalized = raw.startsWith('/uploads/') ? raw.slice(1) : raw;
  const segments = normalized.split('/');
  if (segments.shift() !== 'uploads' || !segments.length
      || segments.some((segment) => !segment || segment === '.' || segment === '..'
        || /[\x00-\x1f\x7f<>:"|?*%]/.test(segment) || /[. ]$/.test(segment))) {
    throw invalidPath();
  }
  return `uploads/${segments.join('/')}`;
}

async function checkedLocalPath(storedPath, { createParents = false } = {}) {
  const relativePath = normalizeLocalStoredPath(storedPath).slice('uploads/'.length);
  const segments = relativePath.split('/');
  if (createParents) await fs.mkdir(LOCAL_UPLOADS_DIR, { recursive: true });
  const rootStat = await fs.lstat(LOCAL_UPLOADS_DIR);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw invalidPath();
  const realRoot = await fs.realpath(LOCAL_UPLOADS_DIR);
  let current = realRoot;

  // Check each directory before creating or reading anything below it. This
  // rejects symbolic links and Windows junctions inside the uploads tree.
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (createParents) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidPath();
  }
  const absolutePath = path.join(current, segments.at(-1));
  if (!createParents) {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw invalidPath();
    const realFile = await fs.realpath(absolutePath);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw invalidPath();
    }
  }
  return absolutePath;
}

async function readLocalFileBuffer(storedPath) {
  try {
    const absolutePath = await checkedLocalPath(storedPath);
    const handle = await fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!(await handle.stat()).isFile()) throw invalidPath();
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      const missing = new Error('Stored file was not found');
      missing.statusCode = 404;
      throw missing;
    }
    throw error;
  }
}

async function writeLocalFileBuffer(storedPath, buffer) {
  const absolutePath = await checkedLocalPath(storedPath, { createParents: true });
  // Generated upload names are unique; never overwrite an existing file or link.
  await fs.writeFile(absolutePath, buffer, { flag: 'wx' });
}

module.exports = {
  LOCAL_UPLOADS_DIR,
  normalizeLocalStoredPath,
  readLocalFileBuffer,
  writeLocalFileBuffer,
};
