import { Stack, ErrorBoundary } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { QueryProvider } from '../src/query/QueryProvider';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { NotificationsProvider } from '../src/notifications/NotificationsProvider';
import { Button, colors } from '../src/components/ui';
export { ErrorBoundary };

function Navigation() {
  const { user, loading, bootstrapError, retryBootstrap, signOut } = useAuth();
  if (loading || bootstrapError) return <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 20 }}>
    <Text style={{ fontSize: 30, fontWeight: '800', color: colors.ink }}>EduMatch.</Text>
    {loading ? <ActivityIndicator size="large" color={colors.primary} /> : <>
      <Text style={{ color: colors.muted, textAlign: 'center' }}>{bootstrapError}</Text>
      <Button title="Retry connection" onPress={() => void retryBootstrap()} />
      <Button title="Return to sign in" variant="secondary" onPress={() => void signOut()} />
    </>}
  </View>;
  return <Stack screenOptions={{ headerShown: false }}>
    <Stack.Screen name="index" />
    <Stack.Protected guard={!user}><Stack.Screen name="login" /><Stack.Screen name="register" /></Stack.Protected>
    <Stack.Protected guard={!!user?.forcePasswordChange}><Stack.Screen name="password" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'admin' && !user.forcePasswordChange}><Stack.Screen name="admin" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'secretary' && !user.forcePasswordChange}><Stack.Screen name="secretary" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'headteacher' && !user.forcePasswordChange}><Stack.Screen name="headteacher" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'teacher' && !user.forcePasswordChange}><Stack.Screen name="teacher" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'student' && !user.forcePasswordChange}><Stack.Screen name="student" /></Stack.Protected>
  </Stack>;
}
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    Inter_500Medium: require('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
    Inter_600SemiBold: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
    Inter_700Bold: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
    Inter_800ExtraBold: require('@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf'),
  });
  if (!fontsLoaded && !fontError) return <SafeAreaProvider><StatusBar style="dark" /><View accessibilityLabel="Loading EduMatch" style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
    <ActivityIndicator size="large" color={colors.darkGreen} accessibilityRole="progressbar" accessibilityLabel="Loading app fonts" />
    <Text style={{ color: colors.muted, fontSize: 14 }}>Getting things ready...</Text>
  </View></SafeAreaProvider>;
  return <SafeAreaProvider><QueryProvider><AuthProvider><NotificationsProvider><StatusBar style="dark" /><Navigation /></NotificationsProvider></AuthProvider></QueryProvider></SafeAreaProvider>;
}
