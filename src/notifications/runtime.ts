import Constants from 'expo-constants';
import { Platform } from 'react-native';

type NotificationApi = typeof import('expo-notifications');

export function getNotificationApi(): NotificationApi | null {
  // Loading this module can register push listeners, which throw in Android Expo Go.
  if (Platform.OS === 'web' || Constants.executionEnvironment === 'storeClient') return null;
  return require('expo-notifications') as NotificationApi;
}
