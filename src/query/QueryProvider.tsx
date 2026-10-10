import { useEffect, type PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';

export const queryClient = new QueryClient({ defaultOptions: {
  queries: { staleTime: 30000, gcTime: 5 * 60 * 1000, retry: (count, error) => {
    if (axios.isAxiosError(error) && [400, 401, 403, 404, 409, 422].includes(error.response?.status || 0)) return false;
    return count < 2;
  } },
  mutations: { retry: false, networkMode: 'always' },
} });
export function QueryProvider({ children }: PropsWithChildren) {
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => onlineManager.setOnline(state.isConnected !== false && state.isInternetReachable !== false));
    const subscription = AppState.addEventListener('change', (state) => { if (Platform.OS !== 'web') focusManager.setFocused(state === 'active'); });
    return () => { unsubscribe(); subscription.remove(); };
  }, []);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
