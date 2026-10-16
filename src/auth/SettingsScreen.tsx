import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, edumatchApi } from '../api/edumatch';
import { errorMessage } from '../api/client';
import { Button, Card, Field, Heading, Notice, QueryStatus, Screen, colors, styles } from '../components/ui';
import { registerDevice } from '../notifications/push';
import { useAuth } from './AuthProvider';
import { ROLE_LABELS } from './roles';

type SettingsSection = 'home' | 'profile' | 'security';
type ProfileDetailsDraft = { name: string; email: string };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function ProfilePhoto({ name, uri }: { name: string; uri?: string }) {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => setUnavailable(false), [uri]);
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase() || 'A';
  return <View style={settingsStyles.photo}>
    {uri && !unavailable ? <Image source={{ uri }} style={settingsStyles.photoImage} accessibilityLabel={`${name}'s profile picture`} onError={() => setUnavailable(true)} />
      : <Text accessibilityLabel={`${name}'s profile initials`} style={settingsStyles.initials}>{initials}</Text>}
  </View>;
}

function SettingsEntry({ title, detail, icon, disabled, onPress }: { title: string; detail: string; icon: React.ComponentProps<typeof Ionicons>['name']; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${detail}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [settingsStyles.entry, disabled && { opacity: 0.55 }, pressed && { opacity: 0.75 }]}>
    <View style={settingsStyles.entryIcon}><Ionicons name={icon} size={24} color={colors.darkGreen} /></View>
    <View style={{ flex: 1, gap: 4 }}><Text style={styles.heading}>{title}</Text><Text style={styles.bodyMuted}>{detail}</Text></View>
    <Ionicons name="chevron-forward" size={20} color={colors.muted} />
  </Pressable>;
}

export function SettingsScreen() {
  const { user, signOut, refreshProfile } = useAuth();
  const client = useQueryClient();
  const [section, setSection] = useState<SettingsSection>('home');
  const [photo, setPhoto] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [photoFailure, setPhotoFailure] = useState<string | null>(null);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [detailsDraft, setDetailsDraft] = useState<ProfileDetailsDraft | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsFailure, setDetailsFailure] = useState<string | null>(null);
  const [detailsMessage, setDetailsMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordFailure, setPasswordFailure] = useState<string | null>(null);
  const [otpChoice, setOtpChoice] = useState<boolean | null>(null);
  const [otpPassword, setOtpPassword] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpFailure, setOtpFailure] = useState<string | null>(null);
  const [otpMessage, setOtpMessage] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
  const [notificationFailure, setNotificationFailure] = useState<string | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const accountId = user?.id;
  const mounted = useRef(true);
  // Replace the snapshot synchronously so delayed work cannot update another account,
  // including an account selected again after switching away from it.
  const accountSnapshot = useRef({ id: accountId });
  if (accountSnapshot.current.id !== accountId) accountSnapshot.current = { id: accountId };
  const isCurrent = (snapshot: typeof accountSnapshot.current) => mounted.current && Boolean(snapshot.id) && accountSnapshot.current === snapshot;
  const profileKey = ['account-profile', accountId];
  const otpKey = ['admin-otp-settings', accountId];
  const settingsAvailable = Boolean(user && !user.forcePasswordChange);
  const canChangeOtp = settingsAvailable && user?.role === 'admin';
  const profileQuery = useQuery({ queryKey: profileKey, queryFn: () => authApi.profile(), enabled: settingsAvailable && section === 'profile', staleTime: 20_000 });
  const otpQuery = useQuery({ queryKey: otpKey, queryFn: () => edumatchApi.adminOtpSettings(), enabled: canChangeOtp && section === 'security', staleTime: 0 });
  const profile = profileQuery.data || user;
  const profileName = profile?.name || '';
  const profileEmail = profile?.email || '';
  const draftName = detailsDraft?.name ?? profileName;
  const draftEmail = detailsDraft?.email ?? profileEmail;
  const detailsChanged = draftName.trim() !== profileName || draftEmail.trim().toLowerCase() !== profileEmail.trim().toLowerCase();
  const busy = photoBusy || pickerBusy || detailsBusy || passwordBusy || otpBusy || notificationBusy || signOutBusy;
  const desiredOtp = otpChoice ?? otpQuery.data?.enabled;
  const schoolOtp = otpQuery.data?.scope === 'school';
  const otpChanged = otpQuery.data !== undefined && desiredOtp !== otpQuery.data.enabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setSection('home'); setPhoto(null); setPhotoFailure(null); setPhotoMessage(null);
    setDetailsDraft(null); setDetailsBusy(false); setDetailsFailure(null); setDetailsMessage(null);
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordFailure(null);
    setOtpChoice(null); setOtpPassword(''); setOtpFailure(null); setOtpMessage(null);
    setNotificationMessage(null); setNotificationFailure(null);
    setPhotoBusy(false); setPickerBusy(false); setPasswordBusy(false);
    setOtpBusy(false); setNotificationBusy(false); setSignOutBusy(false);
  }, [accountId]);

  async function choosePhoto() {
    const snapshot = accountSnapshot.current;
    if (busy || !isCurrent(snapshot)) return;
    setPickerBusy(true); setPhotoFailure(null); setPhotoMessage(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: PHOTO_TYPES, multiple: false, copyToCacheDirectory: true });
      if (!isCurrent(snapshot) || result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const mime = asset.mimeType?.toLowerCase();
      if ((mime && !PHOTO_TYPES.includes(mime)) || (!mime && !/\.(jpe?g|png|webp)$/i.test(asset.name))) {
        throw new Error('Choose a JPG, PNG, or WebP image.');
      }
      if ((asset.size ?? asset.file?.size ?? 0) > MAX_PHOTO_BYTES) throw new Error('Choose a profile picture that is 5 MB or smaller.');
      setPhoto(asset);
    } catch (error) { if (isCurrent(snapshot)) setPhotoFailure(errorMessage(error)); }
    finally { if (isCurrent(snapshot)) setPickerBusy(false); }
  }

  async function savePhoto() {
    const snapshot = accountSnapshot.current;
    if (!photo || busy || !isCurrent(snapshot)) return;
    setPhotoBusy(true); setPhotoFailure(null); setPhotoMessage(null);
    try {
      const form = new FormData();
      if (photo.file) form.append('profileImage', photo.file, photo.name);
      else {
        const type = photo.mimeType || (/\.png$/i.test(photo.name) ? 'image/png' : /\.webp$/i.test(photo.name) ? 'image/webp' : 'image/jpeg');
        form.append('profileImage', { uri: photo.uri, name: photo.name, type } as unknown as Blob);
      }
      await client.cancelQueries({ queryKey: profileKey, exact: true });
      if (!isCurrent(snapshot)) return;
      const updated = await authApi.updateProfile(form);
      if (!isCurrent(snapshot)) return;
      client.setQueryData(profileKey, updated); setPhoto(null);
      setPhotoMessage('Your profile picture has been updated.');
      try { await refreshProfile(); }
      catch { if (isCurrent(snapshot)) setPhotoMessage('Your profile picture was saved. Reopen Settings to refresh your account details.'); }
    } catch (error) {
      if (isCurrent(snapshot)) {
        setPhotoFailure(errorMessage(error));
        void client.invalidateQueries({ queryKey: profileKey, exact: true });
      }
    }
    finally { if (isCurrent(snapshot)) setPhotoBusy(false); }
  }

  function editDetails(field: keyof ProfileDetailsDraft, value: string) {
    setDetailsDraft(previous => ({ name: previous?.name ?? profileName, email: previous?.email ?? profileEmail, [field]: value }));
    setDetailsFailure(null); setDetailsMessage(null);
  }

  async function saveDetails() {
    const snapshot = accountSnapshot.current;
    if (busy || !isCurrent(snapshot) || !detailsChanged || !draftName.trim() || !draftEmail.trim()) return;
    const originalEmail = profileEmail.trim().toLowerCase();
    setDetailsBusy(true); setDetailsFailure(null); setDetailsMessage(null);
    try {
      await client.cancelQueries({ queryKey: profileKey, exact: true });
      if (!isCurrent(snapshot)) return;
      const updated = await authApi.updateProfile({ name: draftName.trim(), email: draftEmail.trim().toLowerCase() });
      if (!isCurrent(snapshot)) return;
      client.setQueryData(profileKey, updated); setDetailsDraft(null);
      if (updated.email.trim().toLowerCase() !== originalEmail) {
        setDetailsMessage('Your profile was updated. Sign in again with your existing username and password.');
        if (Platform.OS !== 'web') Alert.alert('Profile updated', 'Your email changed. Sign in again with your existing username and password.');
        await signOut();
        return;
      }
      setDetailsMessage('Your profile details have been updated.');
      try { await refreshProfile(); }
      catch { if (isCurrent(snapshot)) setDetailsMessage('Your profile details were saved. Reopen Settings to refresh your account details.'); }
    } catch (error) {
      if (isCurrent(snapshot)) {
        setDetailsFailure(errorMessage(error));
        void client.invalidateQueries({ queryKey: profileKey, exact: true });
      }
    }
    finally { if (isCurrent(snapshot)) setDetailsBusy(false); }
  }

  async function changePassword() {
    const snapshot = accountSnapshot.current;
    if (busy || !isCurrent(snapshot) || !currentPassword || !newPassword || newPassword !== confirmPassword) return;
    if (newPassword.length < 8 || newPassword.length > 16) { setPasswordFailure('New password must be 8–16 characters.'); return; }
    setPasswordBusy(true); setPasswordFailure(null);
    try {
      await authApi.changePassword({ currentPassword, newPassword, confirmNewPassword: confirmPassword });
      if (!isCurrent(snapshot)) return;
      if (Platform.OS !== 'web') Alert.alert('Password updated', 'Sign in again using your new password.');
      await signOut();
    } catch (error) { if (isCurrent(snapshot)) setPasswordFailure(errorMessage(error)); }
    finally { if (isCurrent(snapshot)) setPasswordBusy(false); }
  }

  async function saveOtp() {
    const snapshot = accountSnapshot.current;
    if (!canChangeOtp || !schoolOtp || busy || !isCurrent(snapshot) || otpQuery.isFetching || !otpChanged || typeof desiredOtp !== 'boolean' || !otpPassword) return;
    setOtpBusy(true); setOtpFailure(null); setOtpMessage(null);
    try {
      const updated = await edumatchApi.updateAdminOtpSettings({ enabled: desiredOtp, currentPassword: otpPassword });
      if (!isCurrent(snapshot)) return;
      client.setQueryData(otpKey, updated); setOtpChoice(null); setOtpPassword('');
      const signIns = updated.scope === 'school' ? 'Sign-ins for all school accounts' : 'Sign-ins for your administrator account';
      setOtpMessage(updated.enabled ? `OTP is on. ${signIns} will require an emailed verification code.` : `OTP is off. ${signIns} will use a username and password, along with the required math CAPTCHA.`);
    } catch (error) { if (isCurrent(snapshot)) setOtpFailure(errorMessage(error)); }
    finally { if (isCurrent(snapshot)) setOtpBusy(false); }
  }

  async function enableNotifications() {
    const snapshot = accountSnapshot.current;
    if (busy || !isCurrent(snapshot)) return;
    setNotificationBusy(true); setNotificationFailure(null); setNotificationMessage(null);
    try {
      const message = await registerDevice(true);
      if (isCurrent(snapshot)) setNotificationMessage(message);
    } catch (error) { if (isCurrent(snapshot)) setNotificationFailure(errorMessage(error)); }
    finally { if (isCurrent(snapshot)) setNotificationBusy(false); }
  }

  async function leave() {
    const snapshot = accountSnapshot.current;
    if (busy || !isCurrent(snapshot)) return;
    setSignOutBusy(true);
    try { await signOut(); }
    finally { if (isCurrent(snapshot)) setSignOutBusy(false); }
  }

  function open(next: SettingsSection) {
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordFailure(null);
    setOtpPassword(''); setOtpChoice(null); setOtpFailure(null); setOtpMessage(null);
    setSection(next);
  }

  if (!user || user.forcePasswordChange) return null;
  const title = section === 'profile' ? 'Profile' : section === 'security' ? 'Security' : 'Settings';
  const subtitle = section === 'profile' ? 'Manage your name, email, and profile picture.' : section === 'security' ? canChangeOtp ? 'Manage your password and sign-in verification.' : 'Manage your password.' : 'Your profile, security, and device preferences';
  return <Screen key={section} title={title} subtitle={subtitle}>
    {section !== 'home' ? <Button title="Back to Settings" icon="arrow-back-outline" variant="plain" disabled={busy} onPress={() => open('home')} /> : null}

    {section === 'home' ? <>
      <Card><View style={settingsStyles.identity}><ProfilePhoto name={profile?.name || user.name} uri={profile?.profileImage} /><View style={{ flex: 1, minWidth: 0 }}><Text style={styles.heading}>{profile?.name || user.name}</Text><Text style={styles.bodyMuted}>{ROLE_LABELS[user.role]}</Text><Text style={styles.bodyMuted}>{profile?.email || user.email}</Text></View></View></Card>
      <SettingsEntry title="Profile" detail="Update your name, email, and profile picture." icon="person-circle-outline" disabled={busy} onPress={() => open('profile')} />
      <SettingsEntry title="Security" detail={canChangeOtp ? 'Change your password, your OTP setting, and view school security checks.' : 'Change your account password.'} icon="shield-checkmark-outline" disabled={busy} onPress={() => open('security')} />
      <Card><Heading title="School notifications" detail="Receive announcements and school updates on this device." />
        {notificationFailure ? <Notice tone="error" message={notificationFailure} /> : null}
        {notificationMessage ? <Notice message={notificationMessage} /> : null}
        <Button title="Enable notifications" icon="notifications-outline" loading={notificationBusy} disabled={busy && !notificationBusy} onPress={() => void enableNotifications()} />
      </Card>
      <Button title="Sign out" variant="secondary" loading={signOutBusy} disabled={busy && !signOutBusy} onPress={() => void leave()} />
    </> : null}

    {section === 'profile' ? <>
      <QueryStatus loading={profileQuery.isPending} error={profileQuery.error} retry={() => void profileQuery.refetch()} />
      {photoFailure ? <Notice tone="error" message={photoFailure} /> : null}
      {photoMessage ? <Notice tone="success" message={photoMessage} /> : null}
      <Card><Heading title="Profile picture" detail="Choose a JPG, PNG, or WebP image up to 5 MB." /><View style={settingsStyles.photoPreview}><ProfilePhoto name={profile?.name || user.name} uri={photo?.uri || profile?.profileImage} />{photo ? <Text style={[styles.bodyMuted, { textAlign: 'center' }]}>{photo.name}</Text> : null}</View>
        <Button title={photo ? 'Choose a different picture' : 'Choose profile picture'} icon="image-outline" variant="secondary" loading={pickerBusy} disabled={busy && !pickerBusy} onPress={() => void choosePhoto()} />
        {photo ? <><Button title="Save profile picture" icon="checkmark-outline" loading={photoBusy} disabled={busy && !photoBusy} onPress={() => void savePhoto()} /><Button title="Cancel picture change" variant="plain" disabled={busy} onPress={() => { setPhoto(null); setPhotoFailure(null); }} /></> : null}
      </Card>
      <Card><Heading title="Account details" detail="Update your name and Gmail address." />
        {detailsFailure ? <Notice tone="error" message={detailsFailure} /> : null}
        {detailsMessage ? <Notice tone="success" message={detailsMessage} /> : null}
        <View style={{ gap: 14 }}>
        <Field label="Name" value={draftName} onChangeText={value => editDetails('name', value)} editable={!busy} autoCapitalize="words" textContentType="name" autoCorrect={false} />
        <View><Text style={styles.smallLabel}>Username</Text><Text style={styles.body}>{profile?.username || user.username || 'Not set'}</Text><Text style={styles.bodyMuted}>Your username cannot be changed.</Text></View>
        <Field label="Email" value={draftEmail} onChangeText={value => editDetails('email', value)} editable={!busy} keyboardType="email-address" autoCapitalize="none" textContentType="emailAddress" autoCorrect={false} placeholder="yourname@gmail.com" />
        <Text style={styles.bodyMuted}>Changing your email signs you out. Sign in again with your existing username.</Text>
        <Button title="Save profile details" loading={detailsBusy} disabled={(busy && !detailsBusy) || !detailsChanged || !draftName.trim() || !draftEmail.trim()} onPress={() => void saveDetails()} />
        {detailsDraft ? <Button title="Cancel details changes" variant="plain" disabled={busy} onPress={() => { setDetailsDraft(null); setDetailsFailure(null); setDetailsMessage(null); }} /> : null}
      </View></Card>
    </> : null}

    {section === 'security' ? <>
      <Card><Heading title="Change password" detail="After updating your password, sign in again with your new password." />
        {passwordFailure ? <Notice tone="error" message={passwordFailure} /> : null}
        <Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} editable={!busy} secureTextEntry textContentType="password" autoCapitalize="none" autoCorrect={false} maxLength={16} />
        <Field label="New password" value={newPassword} onChangeText={setNewPassword} editable={!busy} secureTextEntry textContentType="newPassword" autoCapitalize="none" autoCorrect={false} maxLength={16} />
        <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} editable={!busy} secureTextEntry textContentType="newPassword" autoCapitalize="none" autoCorrect={false} maxLength={16} />
        <Text style={{ color: colors.muted, fontSize: 13 }}>Use 8–16 characters.</Text>
        {confirmPassword && confirmPassword !== newPassword ? <Text style={{ color: colors.danger, fontSize: 13 }}>The new passwords must match.</Text> : null}
        <Button title="Update password" loading={passwordBusy} disabled={(busy && !passwordBusy) || !currentPassword || !newPassword || newPassword !== confirmPassword} onPress={() => void changePassword()} />
      </Card>
      {canChangeOtp ? <Card><Heading title="Sign-in OTP" detail="Control the emailed verification code requirement for all accounts: admin, headteacher, teacher, secretary, and student." />
        <QueryStatus loading={otpQuery.isPending} error={otpQuery.error} retry={() => void otpQuery.refetch()} />
        {otpQuery.data?.scope === 'account' && !otpQuery.error ? <Notice tone="error" message="Your server only supports changing OTP for your administrator account. Update the school server to enable this switch for everyone. Other accounts still require OTP." /> : null}
        {otpQuery.data && schoolOtp && !otpQuery.error ? <>
          <View style={styles.between}><View style={{ flex: 1, gap: 4 }}><Text style={styles.heading}>OTP {desiredOtp ? 'on' : 'off'}</Text><Text style={styles.bodyMuted}>Currently saved for {schoolOtp ? 'all accounts' : 'your account'}: {otpQuery.data.enabled ? 'On' : 'Off'}</Text></View><Switch accessibilityLabel={schoolOtp ? 'Sign-in OTP for all school accounts' : 'Sign-in OTP for your administrator account'} value={Boolean(desiredOtp)} onValueChange={enabled => { setOtpChoice(enabled); setOtpFailure(null); setOtpMessage(null); }} disabled={busy || otpQuery.isFetching} trackColor={{ false: colors.border, true: colors.primary }} thumbColor="#FFFFFF" /></View>
          {otpChanged && desiredOtp === false ? <Notice message={schoolOtp ? 'Turning OTP off removes the emailed verification step from sign-ins for all roles. The required math CAPTCHA remains in place.' : 'Turning OTP off removes the emailed verification step for your administrator account only. Other accounts are unaffected. The required math CAPTCHA remains in place.'} /> : null}
          {otpChanged ? <Field label="Current password to confirm OTP change" value={otpPassword} onChangeText={setOtpPassword} editable={!busy} secureTextEntry textContentType="password" autoCapitalize="none" autoCorrect={false} /> : null}
          {otpFailure ? <Notice tone="error" message={otpFailure} /> : null}
          {otpMessage ? <Notice tone="success" message={otpMessage} /> : null}
          {otpChanged ? <><Button title="Save OTP setting" loading={otpBusy} disabled={(busy && !otpBusy) || otpQuery.isFetching || !otpPassword} onPress={() => void saveOtp()} /><Button title="Cancel OTP change" variant="plain" disabled={busy} onPress={() => { setOtpChoice(null); setOtpPassword(''); setOtpFailure(null); }} /></> : null}
        </> : null}
      </Card> : null}
    </> : null}
  </Screen>;
}

const settingsStyles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  photo: { height: 88, width: 88, borderRadius: 44, backgroundColor: colors.pale, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  photoImage: { height: '100%', width: '100%' },
  initials: { color: colors.darkGreen, fontSize: 27, fontWeight: '800' },
  photoPreview: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 18, minHeight: 100 },
  entryIcon: { backgroundColor: colors.pale, borderRadius: 14, padding: 12 },
});
