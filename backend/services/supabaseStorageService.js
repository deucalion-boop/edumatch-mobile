const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_BUCKET_NAME = 'files';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
let supabaseClient = null;

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeBucketName(value) {
  return normalizeString(value, DEFAULT_BUCKET_NAME).replace(/^\/+|\/+$/g, '');
}

function normalizeObjectPath(value) {
  return normalizeString(value).replace(/^\/+|\/+$/g, '');
}

function normalizeBoolean(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeSupabaseError(error, fallbackMessage = 'Supabase Storage request failed') {
  if (!error) {
    const normalized = new Error(fallbackMessage);
    normalized.statusCode = 500;
    return normalized;
  }

  const normalized = new Error(String(error.message || fallbackMessage).trim() || fallbackMessage);
  normalized.name = String(error.name || 'SupabaseStorageError').trim() || 'SupabaseStorageError';
  normalized.code = error.code;

  const parsedStatusCode = Number.parseInt(error.statusCode || error.status, 10);
  normalized.statusCode = Number.isInteger(parsedStatusCode) ? parsedStatusCode : 500;

  if (error.details !== undefined) normalized.details = error.details;
  if (error.hint !== undefined) normalized.hint = error.hint;
  normalized.cause = error;
  return normalized;
}

function getSupabaseStorageConfig() {
  return {
    url: normalizeString(process.env.SUPABASE_URL),
    publishableKey: normalizeString(process.env.SUPABASE_PUBLISHABLE_KEY),
    serviceRoleKey: normalizeString(process.env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: normalizeBucketName(process.env.SUPABASE_STORAGE_BUCKET),
    bucketPublic: normalizeBoolean(process.env.SUPABASE_STORAGE_PUBLIC, false),
    signedUrlTtlSeconds: normalizePositiveInteger(
      process.env.SUPABASE_STORAGE_SIGNED_URL_TTL_SECONDS,
      DEFAULT_SIGNED_URL_TTL_SECONDS
    ),
  };
}

function getSupabaseStorageKey() {
  return getSupabaseStorageConfig().serviceRoleKey;
}

function getDefaultBucketName() {
  return getSupabaseStorageConfig().bucket;
}

function getSignedUrlTtlSeconds() {
  return getSupabaseStorageConfig().signedUrlTtlSeconds;
}

function isBucketPublic(bucketName = getDefaultBucketName()) {
  const normalizedBucket = normalizeBucketName(bucketName);
  const { bucket, bucketPublic } = getSupabaseStorageConfig();
  if (normalizedBucket !== bucket) {
    return bucketPublic;
  }
  return bucketPublic;
}

function isSupabaseStorageConfigured() {
  const { url, bucket } = getSupabaseStorageConfig();
  return Boolean(url && getSupabaseStorageKey() && bucket);
}

function getSupabaseStorageClient() {
  if (!isSupabaseStorageConfigured()) {
    throw new Error('Supabase Storage is not configured');
  }

  if (!supabaseClient) {
    const { url } = getSupabaseStorageConfig();
    supabaseClient = createClient(url, getSupabaseStorageKey(), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return supabaseClient;
}

async function verifyPrivateStorageBucket() {
  const { bucket, bucketPublic } = getSupabaseStorageConfig();
  if (bucketPublic) throw new Error('SUPABASE_STORAGE_PUBLIC must be false for application files');
  const { data, error } = await getSupabaseStorageClient().storage.getBucket(bucket);
  if (error || !data) throw new Error('Cannot verify the private storage bucket; check its existence and backend service credentials');
  if (data.public !== false) throw new Error('The Supabase application storage bucket is public; make it private before starting the backend');
  return data;
}

function isSupabaseStoredPath(value) {
  return /^supabase:\/\//i.test(String(value || '').trim());
}

function parseSupabaseStoredPath(value) {
  const raw = String(value || '').trim();
  if (!isSupabaseStoredPath(raw)) return null;

  const withoutScheme = raw.slice('supabase://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex <= 0) {
    const error = new Error('Supabase stored path is invalid');
    error.statusCode = 400;
    throw error;
  }

  const bucket = normalizeBucketName(withoutScheme.slice(0, slashIndex));
  const objectPath = normalizeObjectPath(withoutScheme.slice(slashIndex + 1));

  if (!bucket || !objectPath) {
    const error = new Error('Supabase stored path is invalid');
    error.statusCode = 400;
    throw error;
  }

  return { bucket, objectPath };
}

function resolveSupabaseLocation(value, bucketName = getDefaultBucketName()) {
  if (isSupabaseStoredPath(value)) {
    return parseSupabaseStoredPath(value);
  }

  const bucket = normalizeBucketName(bucketName);
  const objectPath = normalizeObjectPath(value);

  if (!objectPath) {
    const error = new Error('Supabase object path is required');
    error.statusCode = 400;
    throw error;
  }

  return { bucket, objectPath };
}

function toSupabaseStoredPath(objectPath, bucketName = getDefaultBucketName()) {
  const bucket = normalizeBucketName(bucketName);
  const normalizedObjectPath = normalizeObjectPath(objectPath);
  if (!normalizedObjectPath) {
    const error = new Error('Supabase object path is required');
    error.statusCode = 400;
    throw error;
  }
  return `supabase://${bucket}/${normalizedObjectPath}`;
}

async function uploadSupabaseFile({ file, objectPath, bucketName = getDefaultBucketName() } = {}) {
  if (!file?.buffer) {
    const error = new Error('Upload file buffer is required');
    error.statusCode = 400;
    throw error;
  }

  const bucket = normalizeBucketName(bucketName);
  const normalizedObjectPath = normalizeObjectPath(objectPath);
  const contentType = normalizeString(file.mimetype || file.mimeType, 'application/octet-stream').toLowerCase();
  const client = getSupabaseStorageClient();

  const { error: uploadError } = await client.storage.from(bucket).upload(normalizedObjectPath, file.buffer, {
    cacheControl: '3600',
    contentType,
    upsert: false,
  });

  if (uploadError) {
    throw normalizeSupabaseError(uploadError, 'Failed to upload file to Supabase Storage');
  }

  return {
    bucket,
    objectPath: normalizedObjectPath,
    storedPath: toSupabaseStoredPath(normalizedObjectPath, bucket),
    publicUrl: isBucketPublic(bucket) ? getSupabasePublicUrl(normalizedObjectPath, bucket) : '',
    fileName: path.basename(normalizedObjectPath),
  };
}

function getSupabasePublicUrl(value, bucketName = getDefaultBucketName()) {
  const { bucket, objectPath } = resolveSupabaseLocation(value, bucketName);
  const client = getSupabaseStorageClient();
  const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
  return String(data?.publicUrl || '').trim();
}

async function createSupabaseSignedUrl(
  value,
  { bucketName = getDefaultBucketName(), expiresIn = getSignedUrlTtlSeconds() } = {}
) {
  const { bucket, objectPath } = resolveSupabaseLocation(value, bucketName);
  const client = getSupabaseStorageClient();
  const { data, error } = await client.storage.from(bucket).createSignedUrl(objectPath, expiresIn);

  if (error) {
    throw normalizeSupabaseError(error, 'Failed to create Supabase signed URL');
  }

  return String(data?.signedUrl || '').trim();
}

async function downloadSupabaseFile(value, { bucketName = getDefaultBucketName() } = {}) {
  const { bucket, objectPath } = resolveSupabaseLocation(value, bucketName);
  const client = getSupabaseStorageClient();
  const { data, error } = await client.storage.from(bucket).download(objectPath);

  if (error) {
    throw normalizeSupabaseError(error, 'Failed to download file from Supabase Storage');
  }

  return {
    bucket,
    objectPath,
    data,
  };
}

async function listSupabaseFiles({
  folder = '',
  bucketName = getDefaultBucketName(),
  limit = 100,
  offset = 0,
  sortBy = { column: 'name', order: 'asc' },
} = {}) {
  const bucket = normalizeBucketName(bucketName);
  const client = getSupabaseStorageClient();
  const normalizedFolder = normalizeObjectPath(folder);

  const { data, error } = await client.storage.from(bucket).list(normalizedFolder, {
    limit,
    offset,
    sortBy,
  });

  if (error) {
    throw normalizeSupabaseError(error, 'Failed to list files from Supabase Storage');
  }

  return data || [];
}

async function removeSupabaseFiles(paths = [], { bucketName = getDefaultBucketName() } = {}) {
  const bucket = normalizeBucketName(bucketName);
  const normalizedPaths = (Array.isArray(paths) ? paths : [])
    .map((value) => resolveSupabaseLocation(value, bucket).objectPath)
    .filter(Boolean);

  if (normalizedPaths.length === 0) {
    return [];
  }

  const client = getSupabaseStorageClient();
  const { data, error } = await client.storage.from(bucket).remove(normalizedPaths);

  if (error) {
    throw normalizeSupabaseError(error, 'Failed to remove files from Supabase Storage');
  }

  return data || [];
}

module.exports = {
  createSupabaseSignedUrl,
  downloadSupabaseFile,
  getDefaultBucketName,
  getSignedUrlTtlSeconds,
  getSupabasePublicUrl,
  getSupabaseStorageConfig,
  getSupabaseStorageClient,
  isBucketPublic,
  isSupabaseStorageConfigured,
  isSupabaseStoredPath,
  listSupabaseFiles,
  parseSupabaseStoredPath,
  removeSupabaseFiles,
  resolveSupabaseLocation,
  toSupabaseStoredPath,
  uploadSupabaseFile,
  verifyPrivateStorageBucket,
};
