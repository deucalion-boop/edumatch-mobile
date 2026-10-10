import { useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import { useAuth } from './AuthProvider';
import { authApi } from '../api/edumatch';
import { Button, Card, Field, Notice, Screen, colors } from '../components/ui';
import { errorMessage } from '../api/client';
import { ROLE_LABELS } from './roles';
import { registerDevice } from '../notifications/push';

export function AccountScreen({ required = false }: { required?: boolean }) {
  const { user, signOut } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmNewPassword, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const change = async () => {
    setBusy(true); setFailure(null);
    try {
      await authApi.changePassword({ currentPassword, newPassword, confirmNewPassword });
      await signOut();
      if (Platform.OS !== 'web') Alert.alert('Password updated', 'Sign in again using your new password.');
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const push = async () => {
    setBusy(true); setFailure(null);
    try { setMessage(await registerDevice(true)); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <Screen title={required ? 'Set your password' : 'Your account'} subtitle={required ? 'Update your temporary password to continue.' : 'Profile, security, and device preferences'}>
    {failure && <Notice message={failure} tone="error" />}{message && <Notice message={message} />}
    <Card><Text style={{ color: colors.ink, fontSize: 23, fontWeight: '700' }}>{user?.name}</Text><Text style={{ color: colors.muted, marginTop: 6 }}>{user ? ROLE_LABELS[user.role] : ''}</Text>{user?.email && <Text style={{ color: colors.muted, marginTop: 6 }}>{user.email}</Text>}</Card>
    {!required && <Card><Text style={{ fontWeight: '700', color: colors.ink, fontSize: 18 }}>School notifications</Text><Text style={{ color: colors.muted, lineHeight: 22, marginVertical: 10 }}>Receive announcements and school updates on this device.</Text><Button title="Enable notifications" icon="notifications-outline" loading={busy} onPress={() => void push()} /></Card>}
    <Card><Text style={{ fontWeight: '700', color: colors.ink, fontSize: 18, marginBottom: 16 }}>Change password</Text><View style={{ gap: 12 }}>
      <Field label="Current password" value={currentPassword} onChangeText={setCurrent} secureTextEntry textContentType="password" />
      <Field label="New password" value={newPassword} onChangeText={setNew} secureTextEntry textContentType="newPassword" />
      <Field label="Confirm new password" value={confirmNewPassword} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" />
      <Button title="Update password" loading={busy} disabled={!currentPassword || !newPassword || newPassword !== confirmNewPassword} onPress={() => void change()} />
    </View></Card>
    <Button title="Sign out" variant="secondary" disabled={busy} onPress={() => void signOut()} />
  </Screen>;
}
