import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';

const source = readFileSync(new URL('../src/notifications/runtime.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText;

function loadRuntime(platform: string, executionEnvironment: string, rejectNotifications = false) {
  let notificationLoads = 0;
  const notificationApi = { marker: 'native-notifications' };
  const module = { exports: {} as { getNotificationApi: () => unknown } };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo-constants') return { executionEnvironment };
      if (name === 'expo-notifications') {
        notificationLoads++;
        if (rejectNotifications) throw new Error('Push notifications cannot load in Expo Go.');
        return notificationApi;
      }
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return { getNotificationApi: module.exports.getNotificationApi, notificationApi, notificationLoads: () => notificationLoads };
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
