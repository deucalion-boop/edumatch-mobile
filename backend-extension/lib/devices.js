'use strict';

const { assertRole, fail, userId, databaseResult } = require('./errors');
const ROLES = ['admin', 'secretary', 'headteacher', 'teacher', 'student'];

function validateDevice(body, expectedProjectId) {
  const { installationId, expoPushToken, platform, projectId } = body || {};
  if (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(installationId)) throw fail('Invalid installation ID');
  if (typeof expoPushToken !== 'string' || !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$/.test(expoPushToken)) throw fail('Invalid Expo push token');
  if (!['android', 'ios'].includes(platform)) throw fail('Unsupported device platform');
  if (!expectedProjectId) throw fail('Push registration has not been configured by your school', 503);
  if (projectId !== expectedProjectId) throw fail('Device belongs to a different mobile app', 403);
  return { installationId, expoPushToken, platform, projectId };
}

function createDeviceService(client, expectedProjectId) {
  return {
    async register(user, body, session) {
      assertRole(user, ...ROLES);
      const sessionId = String(session?._id || session?.id || '');
      if (!sessionId) throw fail('Active session is required', 401);
      const device = validateDevice(body, expectedProjectId);
      // A SQL transaction enforces both installation and token ownership. It will
      // never transfer another user's token just because a client supplied it.
      const row = databaseResult(await client.rpc('mobile_register_device', {
        p_user_id: userId(user), p_installation_id: device.installationId,
        p_expo_push_token: device.expoPushToken, p_platform: device.platform, p_project_id: device.projectId,
        p_session_id: sessionId,
      }));
      return { device: { installationId: row.installation_id, platform: row.platform, enabled: row.enabled } };
    },
    async unregister(user, installationId, session) {
      assertRole(user, ...ROLES);
      if (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(installationId)) throw fail('Invalid installation ID');
      databaseResult(await client.from('mobile_devices').update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('installation_id', installationId).eq('user_id', userId(user))
        .eq('session_id', String(session?._id || session?.id || '')));
      return { unregistered: true };
    },
  };
}

module.exports = { createDeviceService, validateDevice };
