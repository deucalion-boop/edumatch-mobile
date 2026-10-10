const crypto = require('crypto');
const path = require('path');
const { isSupabaseStorageConfigured, uploadSupabaseFile } = require('./supabaseStorageService');
const { LOCAL_UPLOADS_DIR, normalizeLocalStoredPath, writeLocalFileBuffer } = require('../utils/localFileStorage');

const DEFAULT_STORAGE_ROOT = 'uploads';

function sanitizeFileName(input) {
  const extension = path.extname(String(input || '')).toLowerCase();
  const baseName = path.basename(String(input || ''), extension)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return {
    baseName: baseName || 'file',
    extension,
  };
}

function buildStoragePath({ folder = 'misc', originalName = 'file' } = {}) {
  const normalizedFolder = String(folder || 'misc')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    || 'misc';
  const { baseName, extension } = sanitizeFileName(originalName);
  const datePrefix = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = crypto.randomUUID();
  const storagePath = `${normalizedFolder}/${datePrefix}/${uniqueSuffix}-${baseName}${extension}`;
  normalizeLocalStoredPath(`${DEFAULT_STORAGE_ROOT}/${storagePath}`);
  return storagePath;
}

async function uploadFile({
  file,
  folder = 'misc',
} = {}) {
  if (!file || !file.buffer) {
    const error = new Error('Upload file buffer is required');
    error.statusCode = 400;
    throw error;
  }

  const storagePath = buildStoragePath({
    folder,
    originalName: file.originalname || file.originalName || 'file',
  });

  const contentType = String(file.mimetype || file.mimeType || 'application/octet-stream').toLowerCase();
  const basePayload = {
    path: storagePath,
    originalName: String(file.originalname || file.originalName || '').trim(),
    mimeType: contentType,
    extension: path.extname(String(file.originalname || file.originalName || '')).toLowerCase(),
    size: Number(file.size || 0),
    uploadedAt: new Date(),
  };

  if (isSupabaseStorageConfigured()) {
    // Persist a stable object path; authorized responses generate signed URLs.
    const upload = await uploadSupabaseFile({
      file,
      objectPath: storagePath,
    });

    return {
      ...basePayload,
      fullPath: upload.storedPath,
      storedPath: upload.storedPath,
      publicUrl: upload.publicUrl || upload.storedPath,
      storageProvider: 'supabase',
      bucket: upload.bucket,
    };
  }

  const publicPath = path.posix.join(DEFAULT_STORAGE_ROOT, storagePath);
  await writeLocalFileBuffer(publicPath, file.buffer);

  return {
    ...basePayload,
    fullPath: publicPath,
    storedPath: publicPath,
    publicUrl: publicPath,
    storageProvider: 'local',
  };
}

async function uploadFiles(files = [], options = {}) {
  const uploads = Array.isArray(files) ? files : [];
  return Promise.all(uploads.map((file) => uploadFile({ ...options, file })));
}

module.exports = {
  DEFAULT_STORAGE_ROOT,
  LOCAL_UPLOADS_DIR,
  buildStoragePath,
  uploadFile,
  uploadFiles,
};
