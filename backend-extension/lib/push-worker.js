'use strict';

const { databaseResult } = require('./errors');
const PERMANENT_ERRORS = new Set(['DeviceNotRegistered', 'MessageTooBig', 'InvalidCredentials', 'MismatchSenderId']);

function nextAttempt(attempts, now = Date.now()) {
  return new Date(now + Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 12))).toISOString();
}

function createPushWorker(client, { projectId, accessToken, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!projectId) throw new Error('EXPO_PROJECT_ID is required');
  async function expoRequest(endpoint, body) {
    const response = await fetchImpl(`https://exp.host/--/api/v2/push/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = new Error(`Expo push HTTP ${response.status}`);
      error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw error;
    }
    const result = await response.json();
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.code || 'Expo request failed').join(','));
    return result.data;
  }
  async function updateJob(job, patch) {
    databaseResult(await client.from('mobile_push_jobs').update({ ...patch, updated_at: new Date(now()).toISOString() })
      .eq('id', job.id).eq('status', job.status));
  }
  async function disableDevice(job) {
    databaseResult(await client.from('mobile_devices').update({ enabled: false, updated_at: new Date(now()).toISOString() })
      .eq('installation_id', job.installation_id).eq('session_id', job.session_id));
  }
  async function processError(job, code, permanent = false) {
    if (code === 'DeviceNotRegistered') await disableDevice(job);
    const dead = permanent || PERMANENT_ERRORS.has(code) || job.attempts >= 5;
    await updateJob(job, { status: dead ? 'dead' : 'pending', ticket_id: null,
      last_error: String(code).slice(0, 250), available_at: nextAttempt(job.attempts, now()) });
  }
  async function sendBatch() {
    const jobs = databaseResult(await client.rpc('mobile_claim_push_jobs', { p_project_id: projectId, p_limit: 100 }));
    if (!jobs.length) return 0;
    let tickets;
    try {
      // Payload deliberately excludes grades, student names, message bodies, and JWTs.
      tickets = await expoRequest('send', jobs.map((job) => ({ to: job.expoPushToken, title: 'EduMatch',
        body: job.urgent ? 'An urgent school update is waiting for you.' : 'You have a new school update.',
        sound: 'default', channelId: 'school-updates', priority: job.urgent ? 'high' : 'default',
        data: { notificationId: job.notificationId, type: job.notificationType, route: '/notifications' },
      })));
    } catch (error) {
      for (const job of jobs) await processError(job, error.message, error.permanent);
      return jobs.length;
    }
    for (let index = 0; index < jobs.length; index += 1) {
      const ticket = tickets?.[index];
      const job = jobs[index];
      if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
        await updateJob(job, { status: 'ticket', ticket_id: ticket.id, ticket_at: new Date(now()).toISOString(),
          available_at: new Date(now() + 15 * 60 * 1000).toISOString(), last_error: null });
      } else await processError(job, ticket?.details?.error || 'Missing push ticket');
    }
    return jobs.length;
  }
  async function checkReceipts() {
    const jobs = databaseResult(await client.from('mobile_push_jobs').select('*').eq('status', 'ticket')
      .lte('available_at', new Date(now()).toISOString()).limit(1000));
    if (!jobs.length) return 0;
    let receipts;
    try { receipts = await expoRequest('getReceipts', { ids: jobs.map((job) => job.ticket_id) }); }
    catch (error) {
      for (const job of jobs) await updateJob(job, { available_at: new Date(now() + 60000).toISOString(), last_error: error.message });
      return jobs.length;
    }
    for (const job of jobs) {
      const receipt = receipts?.[job.ticket_id];
      if (receipt?.status === 'ok') await updateJob(job, { status: 'delivered', last_error: null });
      else if (receipt?.status === 'error') await processError(job, receipt.details?.error || 'Push receipt error');
      else if (now() - Date.parse(job.ticket_at) > 24 * 60 * 60 * 1000) {
        // Receipts older than a day disappear: don't resend accepted tickets.
        await updateJob(job, { status: 'dead', last_error: 'Push receipt unavailable after 24 hours' });
      } else await updateJob(job, { available_at: new Date(now() + 60000).toISOString() });
    }
    return jobs.length;
  }
  return { sendBatch, checkReceipts, tick: async () => ({ sent: await sendBatch(), receipts: await checkReceipts() }) };
}

module.exports = { createPushWorker, nextAttempt };
