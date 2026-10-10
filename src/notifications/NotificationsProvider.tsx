import { useEffect, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import type { DevicePushToken, NotificationResponse } from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import { queryClient } from '../query/QueryProvider';
import { notificationRoute } from './routes';
import { registerDevice } from './push';
import { getNotificationApi, pushRegistrationUnavailableReason } from './runtime';

const notifications = pushRegistrationUnavailableReason() ? null : getNotificationApi();
if (notifications) notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
export function NotificationsProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || user.forcePasswordChange || !notifications) return;
    const register = (devicePushToken?: DevicePushToken) => { void registerDevice(false, devicePushToken).catch(() => { /* Account screen exposes registration status and retry. */ }); };
    register();
    const tap = (response: NotificationResponse) => {
      const route = notificationRoute(response.notification.request.content.data, user.role);
      if (route) router.push(route as Href);
      void notifications.clearLastNotificationResponseAsync();
    };
    void notifications.getLastNotificationResponseAsync().then((response) => { if (response) tap(response); });
    const received = notifications.addNotificationReceivedListener(() => { void queryClient.invalidateQueries(); });
    const response = notifications.addNotificationResponseReceivedListener(tap);
    const tokenChanged = notifications.addPushTokenListener(register);
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') register(); });
    return () => { received.remove(); response.remove(); tokenChanged.remove(); appState.remove(); };
  }, [user?.id, user?.role, user?.forcePasswordChange]);
  return children;
}
