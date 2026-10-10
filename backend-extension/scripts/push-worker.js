'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { createPushWorker } = require('../lib/push-worker');

async function main() {
  const backendRoot = process.env.EDUMATCH_BACKEND_ROOT;
  if (!backendRoot) throw new Error('Set EDUMATCH_BACKEND_ROOT to the existing EduMatch backend folder');
  const backendRequire = createRequire(path.join(path.resolve(backendRoot), 'package.json'));
  backendRequire('dotenv').config({ path: [path.join(backendRoot, '.env'), path.join(backendRoot, '.env.local')], quiet: true });
  const client = backendRequire('./services/supabaseStorageService').getSupabaseStorageClient();
  const worker = createPushWorker(client, { projectId: process.env.EXPO_PROJECT_ID, accessToken: process.env.EXPO_ACCESS_TOKEN });
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; });
  console.log('[mobile.push] Worker started');
  while (!stopped) {
    try { await worker.tick(); } catch (error) { console.error('[mobile.push]', error.message); }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
