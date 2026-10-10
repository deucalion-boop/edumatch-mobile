import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

function compile(path: string) {
  return transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
}

const runtimeSource = compile('../src/notifications/runtime.ts');
const pushSource = compile('../src/notifications/push.ts');
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const INSTALLATION_ID = '00000000-0000-4000-8000-000000000001';
const EXPO_TOKEN = 'ExponentPushToken[test-device-token]';
const INSTALLATION_KEY = 'edumatch.installation';
const REGISTERED_KEY = 'edumatch.push-registration';

type NativeToken = { type: 'android' | 'ios'; data: string };
type TokenOptions = { projectId: string; devicePushToken?: NativeToken };
type DeviceRegistration = { installationId: string; expoPushToken: string; platform: string; projectId: string };
type HarnessOptions = {
  platform?: 'android' | 'ios';
  executionEnvironment?: string;
  // null represents an older build with no capability flag.
  androidConfigured?: boolean | null;
  legacyGoogleServicesFile?: string;
  permissionGranted?: boolean;
  requestedPermissionGranted?: boolean;
  tokenError?: Error;
  backendError?: Error;
};
type RuntimeExports = {
  PUSH_UNAVAILABLE_MESSAGE: string;
  getNotificationApi: () => unknown;
  pushRegistrationUnavailableReason: () => string | null;
};
type PushExports = {
  registerDevice: (requestPermission?: boolean, devicePushToken?: NativeToken) => Promise<string>;
};

function loadRegistration(options: HarnessOptions = {}) {
  const platform = options.platform || 'android';
  const androidConfigured = options.androidConfigured === undefined ? true : options.androidConfigured;
  const constants = {
    executionEnvironment: options.executionEnvironment || 'standalone',
    easConfig: { projectId: PROJECT_ID },
    expoConfig: {
      extra: androidConfigured === null ? {} : { notifications: { androidPushConfigured: androidConfigured } },
      android: options.legacyGoogleServicesFile ? { googleServicesFile: options.legacyGoogleServicesFile } : {},
    },
  };
  const calls = {
    sdkLoads: 0, permissionChecks: 0, permissionRequests: 0, channels: 0, nativeTokenFetches: 0, uuid: 0,
    tokenOptions: [] as TokenOptions[], posts: [] as { url: string; body: DeviceRegistration }[],
    deletes: [] as string[], writes: [] as [string, string][],
  };
  const storage = new Map<string, string>();
  const notificationApi = {
    AndroidImportance: { HIGH: 4 },
    async setNotificationChannelAsync() { calls.channels++; },
    async getPermissionsAsync() { calls.permissionChecks++; return { granted: options.permissionGranted ?? true }; },
    async requestPermissionsAsync() { calls.permissionRequests++; return { granted: options.requestedPermissionGranted ?? true }; },
    async getExpoPushTokenAsync(tokenOptions: TokenOptions) {
      calls.tokenOptions.push(tokenOptions);
      // Expo fetches a native token only when the caller did not supply one.
      if (!tokenOptions.devicePushToken) calls.nativeTokenFetches++;
      if (options.tokenError) throw options.tokenError;
      return { data: EXPO_TOKEN };
    },
  };
  const baseRequire = (name: string) => {
    if (name === 'react-native') return { Platform: { OS: platform } };
    if (name === 'expo-constants') return constants;
    if (name === 'expo-notifications') { calls.sdkLoads++; return notificationApi; }
    throw new Error(`Unexpected module: ${name}`);
  };
  const runtimeModule = { exports: {} as RuntimeExports };
  runInNewContext(runtimeSource, { module: runtimeModule, exports: runtimeModule.exports, require: baseRequire });

  const pushModule = { exports: {} as PushExports };
  runInNewContext(pushSource, {
    module: pushModule, exports: pushModule.exports, Error,
    require(name: string) {
      if (name === './runtime') return runtimeModule.exports;
      if (name === 'expo-device') return { isDevice: true };
      if (name === 'expo-crypto') return { randomUUID: () => { calls.uuid++; return INSTALLATION_ID; } };
      if (name === '../auth/storage') return {
        readSecure: async (key: string) => storage.get(key) ?? null,
        writeSecure: async (key: string, value: string) => { calls.writes.push([key, value]); storage.set(key, value); },
        deleteSecure: async (key: string) => { storage.delete(key); },
      };
      if (name === '../api/client') return { api: {
        post: async (url: string, body: DeviceRegistration) => {
          // Capture plain data outside the VM realm for structural assertions.
          calls.posts.push({ url, body: JSON.parse(JSON.stringify(body)) as DeviceRegistration });
          if (options.backendError) throw options.backendError;
        },
        delete: async (url: string) => { calls.deletes.push(url); },
      } };
      return baseRequire(name);
    },
  });
  return { registerDevice: pushModule.exports.registerDevice, unavailableMessage: runtimeModule.exports.PUSH_UNAVAILABLE_MESSAGE, calls, storage };
}

function assertNoRegistrationWork(harness: ReturnType<typeof loadRegistration>) {
  assert.equal(harness.calls.sdkLoads, 0);
  assert.equal(harness.calls.channels, 0);
  assert.equal(harness.calls.permissionChecks, 0);
  assert.equal(harness.calls.permissionRequests, 0);
  assert.equal(harness.calls.nativeTokenFetches, 0);
  assert.equal(harness.calls.tokenOptions.length, 0);
  assert.equal(harness.calls.posts.length, 0);
  assert.equal(harness.calls.deletes.length, 0);
  assert.equal(harness.calls.uuid, 0);
  assert.equal(harness.calls.writes.length, 0);
  assert.equal(harness.storage.size, 0);
}

test('missing Android push capability skips the native SDK, permission prompt, token request, and backend', async () => {
  for (const options of [
    { androidConfigured: false, legacyGoogleServicesFile: 'google-services.json' },
    { androidConfigured: null },
  ]) {
    const harness = loadRegistration(options);
    assert.equal(await harness.registerDevice(true), harness.unavailableMessage);
    assertNoRegistrationWork(harness);
  }
});

test('configured Android registration requests permission and persists the backend-registered Expo token', async () => {
  const harness = loadRegistration({ permissionGranted: false });
  assert.equal(await harness.registerDevice(true), 'Notifications are enabled for this device.');
  assert.equal(harness.calls.sdkLoads, 1);
  assert.equal(harness.calls.channels, 1);
  assert.equal(harness.calls.permissionChecks, 1);
  assert.equal(harness.calls.permissionRequests, 1);
  assert.equal(harness.calls.tokenOptions[0]?.projectId, PROJECT_ID);
  assert.deepEqual(harness.calls.posts, [{ url: '/mobile/devices', body: {
    installationId: INSTALLATION_ID, expoPushToken: EXPO_TOKEN, platform: 'android', projectId: PROJECT_ID,
  } }]);
  assert.equal(harness.storage.get(INSTALLATION_KEY), INSTALLATION_ID);
  assert.equal(harness.storage.get(REGISTERED_KEY), EXPO_TOKEN);
  assert.deepEqual(harness.calls.writes, [[INSTALLATION_KEY, INSTALLATION_ID], [REGISTERED_KEY, EXPO_TOKEN]]);
});

test('missing native Firebase returns a friendly status without creating a false device registration', async () => {
  for (const message of [
    'Unable to get Firebase Messaging instance. Did you configure googleServicesFile path in app config?',
    'Default FirebaseApp is not initialized in process com.edumatch.mobile.',
  ]) {
    const harness = loadRegistration({ tokenError: new Error(message) });
    assert.equal(await harness.registerDevice(), harness.unavailableMessage);
    assert.equal(harness.calls.tokenOptions.length, 1);
    assert.equal(harness.calls.posts.length, 0);
    assert.equal(harness.calls.uuid, 0);
    assert.equal(harness.calls.writes.length, 0);
    assert.equal(harness.storage.has(REGISTERED_KEY), false);
  }
});

test('push token network failures remain rejected instead of being mistaken for missing Firebase', async () => {
  const failure = Object.assign(new Error('Fetching the token failed: network unavailable'), { code: 'E_REGISTRATION_FAILED' });
  const harness = loadRegistration({ tokenError: failure });
  await assert.rejects(() => harness.registerDevice(), error => error === failure);
  assert.equal(harness.calls.posts.length, 0);
  assert.equal(harness.calls.writes.length, 0);
  assert.equal(harness.storage.has(REGISTERED_KEY), false);
});

test('backend failures remain rejected and do not persist an unregistered push token', async () => {
  const failure = new Error('Device registration service is unavailable');
  const harness = loadRegistration({ backendError: failure });
  await assert.rejects(() => harness.registerDevice(), error => error === failure);
  assert.equal(harness.calls.posts.length, 1);
  assert.equal(harness.storage.get(INSTALLATION_KEY), INSTALLATION_ID);
  assert.equal(harness.storage.has(REGISTERED_KEY), false);
});

test('a received native token is forwarded unchanged so the SDK does not fetch it again', async () => {
  const harness = loadRegistration();
  const devicePushToken: NativeToken = { type: 'android', data: 'test-fcm-device-token' };
  assert.equal(await harness.registerDevice(false, devicePushToken), 'Notifications are enabled for this device.');
  assert.equal(harness.calls.tokenOptions[0]?.devicePushToken, devicePushToken);
  assert.equal(harness.calls.tokenOptions[0]?.projectId, PROJECT_ID);
  assert.equal(harness.calls.nativeTokenFetches, 0);
  assert.equal(harness.calls.posts.length, 1);
  assert.equal(harness.storage.get(REGISTERED_KEY), EXPO_TOKEN);
});

test('iOS registration works when Android push is unconfigured', async () => {
  const harness = loadRegistration({ platform: 'ios', androidConfigured: false });
  assert.equal(await harness.registerDevice(), 'Notifications are enabled for this device.');
  assert.equal(harness.calls.sdkLoads, 1);
  assert.equal(harness.calls.channels, 0);
  assert.equal(harness.calls.posts[0]?.body.platform, 'ios');
  assert.equal(harness.storage.get(REGISTERED_KEY), EXPO_TOKEN);
});

test('Expo Go skips native registration on both platforms', async () => {
  for (const platform of ['android', 'ios'] as const) {
    const harness = loadRegistration({ platform, executionEnvironment: 'storeClient' });
    assert.equal(await harness.registerDevice(true), 'Use an EAS development build to enable push notifications.');
    assertNoRegistrationWork(harness);
  }
});

test('Android-specific native configuration errors are not suppressed on iOS', async () => {
  const failure = new Error('Default FirebaseApp is not initialized');
  const harness = loadRegistration({ platform: 'ios', androidConfigured: false, tokenError: failure });
  await assert.rejects(() => harness.registerDevice(), error => error === failure);
  assert.equal(harness.calls.posts.length, 0);
  assert.equal(harness.storage.has(REGISTERED_KEY), false);
});
