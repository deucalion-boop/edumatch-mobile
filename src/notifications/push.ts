import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import { api } from '../api/client';
import { readSecure, writeSecure, deleteSecure } from '../auth/storage';
import { getNotificationApi } from './runtime';

const INSTALLATION_KEY = 'edumatch.installation';
const REGISTERED_KEY = 'edumatch.push-registration';
export async function installationId() {
  let id = await readSecure(INSTALLATION_KEY);
  if (!id) { id = Crypto.randomUUID(); await writeSecure(INSTALLATION_KEY, id); }
  return id;
}
export async function registerDevice(requestPermission = false): Promise<string> {
  if (Platform.OS === 'web') return 'Push notifications are available in the Android and iOS apps.';
  if (!Device.isDevice) return 'Use a physical device to enable push notifications.';
  const Notifications = getNotificationApi();
  if (!Notifications) return 'Use an EAS development build to enable push notifications.';
  const projectId = Constants.easConfig?.projectId || Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return 'Set the EAS project ID and rebuild the app before enabling notifications.';
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('school-updates', {
    name: 'School updates', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250], lightColor: '#087F6D',
  });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    await unregisterDevice();
    return 'Notifications are disabled. You can enable them in your device settings.';
  }
  const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
  const id = await installationId();
  await api.post('/mobile/devices', { installationId: id, expoPushToken, platform: Platform.OS, projectId });
  await writeSecure(REGISTERED_KEY, expoPushToken);
  return 'Notifications are enabled for this device.';
}
export async function unregisterDevice() {
  const id = await readSecure(INSTALLATION_KEY);
  if (id && await readSecure(REGISTERED_KEY)) await api.delete(`/mobile/devices/${encodeURIComponent(id)}`);
  await deleteSecure(REGISTERED_KEY);
}
