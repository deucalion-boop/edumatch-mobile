import { Stack, ErrorBoundary } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { QueryProvider } from '../src/query/QueryProvider';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { NotificationsProvider } from '../src/notifications/NotificationsProvider';
import { AppLoadingScreen } from '../src/components/AppLoadingScreen';
export { ErrorBoundary };

// Keep the native launch screen visible until the first app view is ready.
if (Platform.OS !== 'web') {
  void SplashScreen.preventAutoHideAsync().catch(() => {});
  if (Platform.OS === 'ios') SplashScreen.setOptions({ duration: 250, fade: true });
}

function hideLaunchScreen() {
  if (Platform.OS !== 'web') void SplashScreen.hideAsync().catch(() => {});
}

function Navigation({ fontsReady }: { fontsReady: boolean }) {
  const { user, loading, bootstrapError, retryBootstrap, signOut } = useAuth();
  if (loading || bootstrapError) return <AppLoadingScreen
    fontsReady={fontsReady}
    message="Getting your learning space ready…"
    error={loading ? null : bootstrapError}
    onRetry={() => void retryBootstrap()}
    onSignIn={() => void signOut()}
    onReady={hideLaunchScreen}
  />;
  return <View style={{ flex: 1, backgroundColor: '#F8FAFC' }} onLayout={hideLaunchScreen}>
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={!user}><Stack.Screen name="login" /><Stack.Screen name="register" /></Stack.Protected>
      <Stack.Protected guard={!!user?.forcePasswordChange}><Stack.Screen name="password" /></Stack.Protected>
      <Stack.Protected guard={user?.role === 'admin' && !user.forcePasswordChange}><Stack.Screen name="admin" /></Stack.Protected>
      <Stack.Protected guard={user?.role === 'secretary' && !user.forcePasswordChange}><Stack.Screen name="secretary" /></Stack.Protected>
      <Stack.Protected guard={user?.role === 'headteacher' && !user.forcePasswordChange}><Stack.Screen name="headteacher" /></Stack.Protected>
      <Stack.Protected guard={user?.role === 'teacher' && !user.forcePasswordChange}><Stack.Screen name="teacher" /></Stack.Protected>
      <Stack.Protected guard={user?.role === 'student' && !user.forcePasswordChange}><Stack.Screen name="student" /></Stack.Protected>
    </Stack>
  </View>;
}
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    Inter_500Medium: require('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
    Inter_600SemiBold: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
    Inter_700Bold: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
    Inter_800ExtraBold: require('@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf'),
  });
  if (!fontsLoaded && !fontError) return <SafeAreaProvider><StatusBar style="dark" />
    <AppLoadingScreen fontsReady={false} message="Getting things ready…" />
  </SafeAreaProvider>;
  return <SafeAreaProvider><QueryProvider><AuthProvider><NotificationsProvider><StatusBar style="dark" /><Navigation fontsReady={fontsLoaded} /></NotificationsProvider></AuthProvider></QueryProvider></SafeAreaProvider>;
}
