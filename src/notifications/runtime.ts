import Constants from 'expo-constants';
import { Platform } from 'react-native';

type NotificationApi = typeof import('expo-notifications');

export const PUSH_UNAVAILABLE_MESSAGE = 'Push notifications are not available in this app version. You can still read school updates in Notifications.';

export function pushRegistrationUnavailableReason(): string | null {
  if (Platform.OS === 'web') return 'Push notifications are available in the Android and iOS apps.';
  if (Constants.executionEnvironment === 'storeClient') return 'Use an EAS development build to enable push notifications.';
  // Older builds may not contain the capability flag; retain their configured path as a fallback.
  const androidConfigured = Constants.expoConfig?.extra?.notifications?.androidPushConfigured
    ?? !!Constants.expoConfig?.android?.googleServicesFile;
  if (Platform.OS === 'android' && !androidConfigured) return PUSH_UNAVAILABLE_MESSAGE;
  return null;
}

export function getNotificationApi(): NotificationApi | null {
  // Loading this module can register push listeners, which throw in Android Expo Go.
  if (Platform.OS === 'web' || Constants.executionEnvironment === 'storeClient') return null;
  return require('expo-notifications') as NotificationApi;
}
