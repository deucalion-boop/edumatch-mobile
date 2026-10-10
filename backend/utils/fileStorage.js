const crypto = require('crypto');
const path = require('path');
const {
  downloadSupabaseFile,
  getSignedUrlTtlSeconds,
  isSupabaseStoredPath,
  parseSupabaseStoredPath,
} = require('../services/supabaseStorageService');
const { normalizeLocalStoredPath, readLocalFileBuffer } = require('./localFileStorage');

const STORAGE_PROXY_ROUTE = '/api/storage/file';

function isRemoteFileUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function normalizeBoolean(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getRequestOrigin(req) {
  if (!req) return '';
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeStoredPath(storedPath) {
  const raw = String(storedPath || '').trim();
  if (isRemoteFileUrl(raw)) {
    // Older records may contain an absolute URL from an earlier API host.
    // /uploads/ is the application's reserved local storage URL namespace.
    const legacyUpload = raw.match(/^https?:\/\/[^/]+(\/uploads\/[^?#]*)(?:[?#].*)?$/i);
    if (!legacyUpload) return raw;
    try {
      return normalizeLocalStoredPath(decodeURIComponent(legacyUpload[1]));
    } catch (_error) {
      const error = new Error('Stored file path is invalid');
      error.statusCode = 400;
      throw error;
    }
  }
  if (isSupabaseStoredPath(raw)) {
    parseSupabaseStoredPath(raw);
    return raw;
  }
  return normalizeLocalStoredPath(raw);
}

function getStorageSigningSecret() {
  const secret = String(process.env.STORAGE_URL_SIGNING_SECRET || '').trim()
    || String(process.env.JWT_SECRET || '').trim();
  if (!secret) {
    const error = new Error('Storage URL signing is not configured');
    error.statusCode = 503;
    throw error;
  }
  return secret;
}

function encodeBase64Url(input) {
  return Buffer.from(String(input || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function signStoragePayload(payload) {
  return crypto
    .createHmac('sha256', getStorageSigningSecret())
    .update(payload)
    .digest('hex');
}

function buildStorageAccessToken({
  storedPath,
  download = false,
  fileName = '',
  expiresIn = getSignedUrlTtlSeconds(),
} = {}) {
  const payload = {
    storedPath: normalizeStoredPath(storedPath),
    download: normalizeBoolean(download),
    fileName: String(fileName || '').trim(),
    expiresAt: Date.now() + (normalizePositiveInteger(expiresIn, getSignedUrlTtlSeconds()) * 1000),
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signStoragePayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyStorageAccessToken(token) {
  const raw = typeof token === 'string' ? token : '';
  if (raw.length > 16384 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(raw)) {
    const error = new Error('Storage access token is invalid');
    error.statusCode = 400;
    throw error;
  }

  const [encodedPayload, signature] = raw.split('.');
  const expectedSignature = signStoragePayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const signatureBuffer = Buffer.from(String(signature || ''), 'utf8');

  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    const error = new Error('Storage access token is invalid');
    error.statusCode = 403;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch (_error) {
    const error = new Error('Storage access token is invalid');
    error.statusCode = 400;
    throw error;
  }

  if (!payload || typeof payload.storedPath !== 'string' || !payload.storedPath.trim()
      || typeof payload.download !== 'boolean' || typeof payload.fileName !== 'string'
      || !Number.isSafeInteger(payload.expiresAt)) {
    const error = new Error('Storage access token is invalid');
    error.statusCode = 400;
    throw error;
  }

  const expiresAt = payload.expiresAt;
  if (expiresAt <= Date.now()) {
    const error = new Error('Storage access token has expired');
    error.statusCode = 410;
    throw error;
  }

  return {
    storedPath: normalizeStoredPath(payload.storedPath),
    download: payload.download === true,
    fileName: String(payload.fileName || '').trim(),
    expiresAt,
  };
}

function buildStorageProxyUrl(req, options = {}) {
  const origin = getRequestOrigin(req);
  const token = buildStorageAccessToken(options);
  return `${origin}${STORAGE_PROXY_ROUTE}?token=${encodeURIComponent(token)}`;
}

function resolveStoredFileUrl(req, storedPath, options = {}) {
  if (!String(storedPath || '').trim()) return '';
  const raw = normalizeStoredPath(storedPath);
  if (isRemoteFileUrl(raw)) return raw;
  return buildStorageProxyUrl(req, {
    storedPath: raw,
    download: options.download === true,
    fileName: options.fileName || '',
    expiresIn: options.expiresIn,
  });
}

async function downloadOrRedirectStoredFile(req, res, storedPath, downloadName = '') {
  if (!String(storedPath || '').trim()) {
    const error = new Error('Stored file path is missing');
    error.statusCode = 404;
    throw error;
  }
  const raw = normalizeStoredPath(storedPath);

  if (isRemoteFileUrl(raw)) {
    return res.redirect(raw);
  }

  if (isSupabaseStoredPath(raw)) {
    return res.redirect(resolveStoredFileUrl(req, raw, {
      download: true,
      fileName: downloadName,
    }));
  }

  const buffer = await readLocalFileBuffer(raw);
  return sendStoredFileBuffer(res, buffer, {
    download: true,
    fileName: downloadName || path.posix.basename(raw),
    contentType: guessContentType(raw),
  });
}

function guessContentType(fileName = '') {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.avif') return 'image/avif';
  return 'application/octet-stream';
}

function sanitizeDownloadName(value, fallback = 'file') {
  const baseName = path.posix.basename(String(value || '').trim().replace(/\\/g, '/') || fallback);
  return baseName.replace(/["\x00-\x1f\x7f]+/g, '').trim() || fallback;
}

function buildContentDisposition(type, fileName) {
  const safeName = sanitizeDownloadName(fileName);
  const asciiName = safeName.replace(/[^\x20-\x7E]+/g, '_');
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data?.arrayBuffer === 'function') {
    return Buffer.from(await data.arrayBuffer());
  }

  const error = new Error('Unable to read stored file data');
  error.statusCode = 500;
  throw error;
}

async function readStoredFileBuffer(storedPath) {
  if (!String(storedPath || '').trim()) {
    const error = new Error('Stored file path is missing');
    error.statusCode = 404;
    throw error;
  }
  const raw = normalizeStoredPath(storedPath);

  if (isRemoteFileUrl(raw)) {
    const response = await fetch(raw);
    if (!response.ok) {
      const error = new Error(`Failed to download stored file (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    return Buffer.from(await response.arrayBuffer());
  }

  if (isSupabaseStoredPath(raw)) {
    const { data } = await downloadSupabaseFile(raw);
    return toBuffer(data);
  }

  return readLocalFileBuffer(raw);
}

function storageContentSecurityPolicy(contentType) {
  const frameOrigins = new Set(["'self'"]);
  for (const value of String(process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '').split(',')) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') frameOrigins.add(url.origin);
    } catch (_error) {
      // Ignore missing/invalid frontend origins; never interpolate raw headers.
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    frameOrigins.add('http://localhost:5173');
    frameOrigins.add('http://127.0.0.1:5173');
  }
  const activeContent = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)(;|$)/i.test(contentType || '');
  return `${activeContent ? 'sandbox; ' : ''}default-src 'none'; frame-ancestors ${[...frameOrigins].join(' ')}`;
}

function sendStoredFileBuffer(res, buffer, { download = false, fileName = 'file', contentType } = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The frontend can be hosted on a different origin. The signed URL controls
  // access; frame-ancestors controls which configured frontends may embed it.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', storageContentSecurityPolicy(contentType));
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', buildContentDisposition(download ? 'attachment' : 'inline', fileName));
  return res.status(200).send(buffer);
}

async function streamSupabaseFile(res, storedPath, { download = false, fileName = '' } = {}) {
  const { objectPath, data } = await downloadSupabaseFile(storedPath);
  const resolvedFileName = sanitizeDownloadName(fileName || path.basename(objectPath) || 'file');
  const buffer = await toBuffer(data);
  const contentType = String(data?.type || '').trim() || guessContentType(resolvedFileName);

  return sendStoredFileBuffer(res, buffer, { download, fileName: resolvedFileName, contentType });
}

async function serveStoredFile(req, res) {
  const payload = verifyStorageAccessToken(req.query.token);
  const raw = String(payload.storedPath || '').trim();

  if (isRemoteFileUrl(raw)) {
    return res.redirect(raw);
  }

  if (isSupabaseStoredPath(raw)) {
    return streamSupabaseFile(res, raw, payload);
  }

  const buffer = await readLocalFileBuffer(raw);
  return sendStoredFileBuffer(res, buffer, {
    ...payload,
    fileName: payload.fileName || path.posix.basename(raw),
    contentType: guessContentType(raw),
  });
}

module.exports = {
  buildStorageAccessToken,
  downloadOrRedirectStoredFile,
  isRemoteFileUrl,
  readStoredFileBuffer,
  resolveStoredFileUrl,
  serveStoredFile,
  verifyStorageAccessToken,
};
