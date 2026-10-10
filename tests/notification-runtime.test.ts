import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

const source = readFileSync(new URL('../src/notifications/runtime.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText;

function loadRuntime(platform: string, executionEnvironment: string, rejectNotifications = false,
  config: { androidConfigured?: boolean; googleServicesFile?: string } = {}) {
  let notificationLoads = 0;
  const notificationApi = { marker: 'native-notifications' };
  const module = { exports: {} as {
    getNotificationApi: () => unknown;
    pushRegistrationUnavailableReason: () => string | null;
    PUSH_UNAVAILABLE_MESSAGE: string;
  } };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo-constants') return { executionEnvironment, expoConfig: {
        extra: { notifications: { androidPushConfigured: config.androidConfigured } },
        android: { googleServicesFile: config.googleServicesFile },
      } };
      if (name === 'expo-notifications') {
        notificationLoads++;
        if (rejectNotifications) throw new Error('Push notifications cannot load in Expo Go.');
        return notificationApi;
      }
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return { ...module.exports, notificationApi, notificationLoads: () => notificationLoads };
}

test('Expo Go does not load the notification module even when its native import would throw', () => {
  for (const platform of ['android', 'ios']) {
    const runtime = loadRuntime(platform, 'storeClient', true);
    assert.equal(runtime.getNotificationApi(), null);
    assert.equal(runtime.notificationLoads(), 0);
  }
});

test('web skips native notifications', () => {
  const runtime = loadRuntime('web', 'standalone', true);
  assert.equal(runtime.getNotificationApi(), null);
  assert.equal(runtime.notificationLoads(), 0);
});

test('native development and standalone builds load notification APIs only when requested', () => {
  for (const platform of ['android', 'ios']) {
    for (const environment of ['bare', 'standalone']) {
      const runtime = loadRuntime(platform, environment);
      assert.equal(runtime.notificationLoads(), 0);
      assert.equal(runtime.getNotificationApi(), runtime.notificationApi);
      assert.equal(runtime.notificationLoads(), 1);
    }
  }
});

test('Android capability detection honors an explicit flag before the legacy native file path', () => {
  const missing = loadRuntime('android', 'standalone', true);
  assert.equal(missing.pushRegistrationUnavailableReason(), missing.PUSH_UNAVAILABLE_MESSAGE);
  assert.equal(missing.notificationLoads(), 0);

  const disabled = loadRuntime('android', 'standalone', true,
    { androidConfigured: false, googleServicesFile: 'google-services.json' });
  assert.equal(disabled.pushRegistrationUnavailableReason(), disabled.PUSH_UNAVAILABLE_MESSAGE);
  assert.equal(disabled.notificationLoads(), 0);

  const configured = loadRuntime('android', 'standalone', false, { androidConfigured: true });
  assert.equal(configured.pushRegistrationUnavailableReason(), null);

  const legacy = loadRuntime('android', 'standalone', false, { googleServicesFile: 'google-services.json' });
  assert.equal(legacy.pushRegistrationUnavailableReason(), null);
});

test('Android capability does not block iOS, while Expo Go remains unsupported on either platform', () => {
  const ios = loadRuntime('ios', 'standalone', false, { androidConfigured: false });
  assert.equal(ios.pushRegistrationUnavailableReason(), null);

  for (const platform of ['android', 'ios']) {
    const expoGo = loadRuntime(platform, 'storeClient', true, { androidConfigured: true });
    assert.equal(expoGo.pushRegistrationUnavailableReason(), 'Use an EAS development build to enable push notifications.');
    assert.equal(expoGo.notificationLoads(), 0);
  }
});
