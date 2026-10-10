import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '16f46295-63ba-4cd3-89aa-7874be0a09e8';
  return {
    ...config,
    name: 'EduMatch',
    slug: 'edumatch',
    version: '1.0.0',
    scheme: 'edumatch',
    icon: './assets/icon.png',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    owner: process.env.EXPO_OWNER || '4dmin01',
    ios: {
      bundleIdentifier: process.env.EXPO_IOS_BUNDLE_IDENTIFIER || 'com.edumatch.mobile',
      supportsTablet: true,
      googleServicesFile: process.env.GOOGLE_SERVICES_PLIST || undefined,
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
    android: {
      package: process.env.EXPO_ANDROID_PACKAGE || 'com.edumatch.mobile',
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || undefined,
      blockedPermissions: ['android.permission.RECORD_AUDIO'],
      predictiveBackGestureEnabled: true,
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#096A56' },
    },
    plugins: [
      'expo-router',
      'expo-font',
      'expo-status-bar',
      ['expo-secure-store', { configureAndroidBackup: true }],
      ['expo-camera', { cameraPermission: 'EduMatch uses your camera to scan your teacher’s attendance QR code.', recordAudioAndroid: false, barcodeScannerEnabled: true }],
      ['expo-notifications', { defaultChannel: 'school-updates', color: '#087F6D' }],
      ['expo-splash-screen', { backgroundColor: '#096A56', image: './assets/adaptive-icon.png', imageWidth: 180 }],
    ],
    experiments: { typedRoutes: true },
    extra: { ...(projectId ? { eas: { projectId } } : {}) },
    web: { bundler: 'metro', output: 'single' },
  };
};
