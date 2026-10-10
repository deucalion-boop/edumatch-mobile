import { Stack, ErrorBoundary } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, Text, View } from 'react-native';
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
    <Stack.Protected guard={!user}><Stack.Screen name="login" /></Stack.Protected>
    <Stack.Protected guard={!!user?.forcePasswordChange}><Stack.Screen name="password" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'admin' && !user.forcePasswordChange}><Stack.Screen name="admin" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'secretary' && !user.forcePasswordChange}><Stack.Screen name="secretary" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'headteacher' && !user.forcePasswordChange}><Stack.Screen name="headteacher" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'teacher' && !user.forcePasswordChange}><Stack.Screen name="teacher" /></Stack.Protected>
    <Stack.Protected guard={user?.role === 'student' && !user.forcePasswordChange}><Stack.Screen name="student" /></Stack.Protected>
  </Stack>;
}
export default function RootLayout() {
  return <SafeAreaProvider><QueryProvider><AuthProvider><NotificationsProvider><StatusBar style="dark" /><Navigation /></NotificationsProvider></AuthProvider></QueryProvider></SafeAreaProvider>;
}
