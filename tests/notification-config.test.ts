import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import type { ConfigContext, ExpoConfig } from 'expo/config';

const source = readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8');
const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;

function loadConfig(env: Record<string, string> = {}, rootFirebaseFileExists = false) {
  const checkedPaths: string[] = [];
  const module = { exports: {} as { default: (context: ConfigContext) => ExpoConfig } };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    process: { env },
    require(name: string) {
      if (name === 'node:fs') return {
        existsSync(path: string) {
          checkedPaths.push(path);
          return path === './google-services.json' && rootFirebaseFileExists;
        },
      };
      throw new Error(`Unexpected configuration dependency: ${name}`);
    },
  });
  const config = module.exports.default({ config: { name: 'EduMatch', slug: 'edumatch' } } as ConfigContext);
  return { config, checkedPaths };
}

test('an Android build without Firebase reports push as unavailable in its runtime config', () => {
  const { config, checkedPaths } = loadConfig();
  assert.equal(config.android?.googleServicesFile, undefined);
  assert.equal(config.extra?.notifications.androidPushConfigured, false);
  assert.deepEqual(checkedPaths, ['./google-services.json']);
});

test('a local root Firebase file configures Android and exposes its push capability', () => {
  const { config } = loadConfig({}, true);
  assert.equal(config.android?.googleServicesFile, './google-services.json');
  assert.equal(config.extra?.notifications.androidPushConfigured, true);
});

test('an EAS file variable takes precedence over local Firebase configuration', () => {
  const { config, checkedPaths } = loadConfig({ GOOGLE_SERVICES_JSON: '  /build/env/firebase.json  ' }, true);
  assert.equal(config.android?.googleServicesFile, '/build/env/firebase.json');
  assert.equal(config.extra?.notifications.androidPushConfigured, true);
  // EAS materializes file variables remotely; configuration must not reject a path
  // simply because that remote file cannot be inspected on this machine.
  assert.deepEqual(checkedPaths, []);
});

test('an empty file variable preserves local fallback and does not enable an unconfigured build', () => {
  for (const exists of [true, false]) {
    const { config } = loadConfig({ GOOGLE_SERVICES_JSON: ' \t ' }, exists);
    assert.equal(config.android?.googleServicesFile, exists ? './google-services.json' : undefined);
    assert.equal(config.extra?.notifications.androidPushConfigured, exists);
  }
});

test('iOS Firebase configuration does not declare Android push available', () => {
  const { config } = loadConfig({ GOOGLE_SERVICES_PLIST: '/build/env/GoogleService-Info.plist' });
  assert.equal(config.ios?.googleServicesFile, '/build/env/GoogleService-Info.plist');
  assert.equal(config.android?.googleServicesFile, undefined);
  assert.equal(config.extra?.notifications.androidPushConfigured, false);
});

test('platform identifiers remain independent when Android push is configured', () => {
  const { config } = loadConfig({
    EXPO_ANDROID_PACKAGE: 'school.edumatch.android',
    EXPO_IOS_BUNDLE_IDENTIFIER: 'school.edumatch.ios',
    GOOGLE_SERVICES_JSON: '/build/env/android.json',
  });
  assert.equal(config.android?.package, 'school.edumatch.android');
  assert.equal(config.ios?.bundleIdentifier, 'school.edumatch.ios');
  assert.equal(config.ios?.googleServicesFile, undefined);
  assert.equal(config.extra?.notifications.androidPushConfigured, true);
});
