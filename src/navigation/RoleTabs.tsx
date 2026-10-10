import { Redirect, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useWindowDimensions } from 'react-native';
import type { Role } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { colors } from '../components/ui';

export function RoleTabs({ role }: { role: Role }) {
  const { user } = useAuth();
  const { width, fontScale } = useWindowDimensions();
  const compactLabels = width < 360 || fontScale > 1.25;
  const labels: Record<string, string> = { index: 'Home', workspace: 'Workspace', records: 'Records', announcements: 'Updates', account: 'Account' };
  const shortLabels: Record<string, string> = { index: 'Home', workspace: 'Tools', records: 'Files', announcements: 'News', account: 'Me' };
  if (!user) return <Redirect href="/login" />;
  if (user.forcePasswordChange) return <Redirect href="/password" />;
  if (user.role !== role) return <Redirect href={`/${user.role}`} />;
  const icons: Record<string, React.ComponentProps<typeof Ionicons>['name']> = { index: 'grid-outline', workspace: 'school-outline', records: 'folder-open-outline', announcements: 'megaphone-outline', account: 'person-circle-outline' };
  return <Tabs screenOptions={({ route }) => ({ headerShown: false, tabBarActiveTintColor: colors.darkGreen, tabBarInactiveTintColor: colors.muted,
    tabBarActiveBackgroundColor: colors.pale,
    tabBarLabel: compactLabels ? shortLabels[route.name] : labels[route.name],
    tabBarAccessibilityLabel: labels[route.name] ? `${labels[route.name]} tab` : undefined,
    tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, paddingTop: 6, minHeight: 68 },
    tabBarItemStyle: { borderRadius: 12, marginHorizontal: 2, marginBottom: 4 }, tabBarLabelStyle: { fontSize: compactLabels ? 11 : 12, fontWeight: '600' },
    tabBarIcon: ({ color, size }) => <Ionicons name={icons[route.name] || 'ellipse-outline'} size={size} color={color} />,
  })}>
    <Tabs.Screen name="index" options={{ title: 'Home' }} />
    <Tabs.Screen name="workspace" options={{ title: 'Workspace' }} />
    <Tabs.Screen name="records" options={{ title: 'Records' }} />
    <Tabs.Screen name="announcements" options={{ title: 'Updates' }} />
    <Tabs.Screen name="account" options={{ title: 'Account' }} />
    <Tabs.Screen name="[feature]" options={{ href: null }} />
  </Tabs>;
}
