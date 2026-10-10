const { getSupabaseStorageClient } = require('./supabaseStorageService');

// Map SQL columns to the profile response's existing field names. JSON values
// already use application field names and must remain untouched.
async function readProfileRows(table, field, value) {
  let query = getSupabaseStorageClient().from(table).select('*');
  query = Array.isArray(value) ? query.in(field, value) : query.eq(field, String(value));
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(error.message || 'Failed to load user profile'), { statusCode: 500 });
  return (data || []).map((row) => Object.fromEntries([
    ['_id', row.id],
    ...Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]),
  ]));
}

module.exports = { readProfileRows };
