import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { authApi } from '../api/edumatch';
import type { LoginChallenge } from '../api/types';
import { configurationError } from '../config';
import { errorMessage } from '../api/client';
import { Captcha } from './Captcha';
import { useAuth } from './AuthProvider';
import { LoginBranding, loginColors, LoginPattern } from './LoginVisuals';

function secondsUntil(value: string | null, now: number): number | null {
  if (!value) return null;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function LoginScreen() {
  const { acceptSession } = useAuth();
  const { width, height, fontScale } = useWindowDimensions();
  const compact = width < 360;
  const shortScreen = height < 720;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [email, setEmail] = useState('');
  const [captcha, setCaptcha] = useState(false);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const requestInFlight = useRef(false);
  const captchaOpen = useRef(false);
  const currentAttempt = useRef(0);
  const passwordInput = useRef<TextInput>(null);
  const expirySeconds = challenge ? secondsUntil(challenge.expiresAt, now) : null;
  const resendSeconds = challenge ? secondsUntil(challenge.resendAvailableAt, now) : null;
  const canSignIn = !configurationError && !loading && (challenge ? code.length === 6 && expirySeconds !== 0 : !!username.trim() && !!password);

  useEffect(() => {
    if (!challenge) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') setNow(Date.now()); });
    return () => { clearInterval(interval); appState.remove(); };
  }, [challenge]);

  const closeCaptcha = () => { captchaOpen.current = false; setCaptcha(false); };
  const openCaptcha = () => {
    if (!canSignIn || requestInFlight.current || captchaOpen.current) return;
    setError(null); setNotice(null);
    currentAttempt.current += 1;
    setCaptchaAttempt(currentAttempt.current);
    captchaOpen.current = true;
    setCaptcha(true);
  };
  const submit = async (captchaToken: string, attempt: number) => {
    if (!captchaOpen.current || attempt !== currentAttempt.current || requestInFlight.current) return;
    requestInFlight.current = true;
    closeCaptcha(); setLoading(true); setError(null);
    try {
      const result = challenge
        ? await authApi.verifyOtp({ challengeToken: challenge.challengeToken, otpCode: code, captchaToken })
        : await authApi.login({ username: username.trim(), password, captchaToken, remember });
      if ('requiresOtp' in result && result.requiresOtp) { setChallenge(result); setCode(''); setPassword(''); setShowPassword(false); setNotice(null); }
      else if ('token' in result) await acceptSession(result, remember);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { requestInFlight.current = false; setLoading(false); }
  };
  const resend = async () => {
    if (!challenge || requestInFlight.current || captchaOpen.current || (resendSeconds !== null && resendSeconds > 0)) return;
    requestInFlight.current = true; setLoading(true); setError(null); setNotice(null);
    try { setChallenge(await authApi.resendOtp(challenge.challengeToken)); setCode(''); setNotice('A new verification code has been sent.'); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { requestInFlight.current = false; setLoading(false); }
  };
  const recoverPassword = async () => {
    if (!email.trim() || requestInFlight.current || configurationError) return;
    requestInFlight.current = true; setLoading(true); setError(null); setNotice(null);
    try { await authApi.forgotPassword(email.trim()); setNotice('If an EduMatch account uses this email, password reset instructions have been sent. Check your inbox.'); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { requestInFlight.current = false; setLoading(false); }
  };
  const backToSignIn = () => { if (requestInFlight.current) return; closeCaptcha(); setRecovering(false); setChallenge(null); setCode(''); setPassword(''); setShowPassword(false); setError(null); setNotice(null); };

  const form = <View style={[styles.formPanel, compact && styles.compactPanel, shortScreen && styles.shortPanel]}>
    <LoginPattern />
    <View style={styles.formShell}>
      <LoginBranding />
      <View style={styles.cardShadow}><View style={styles.cardFrame}>
        <View style={[styles.card, compact && styles.compactCard]}>
          <View style={styles.cardHeader}>
            <View style={styles.badge}><Ionicons name={recovering ? 'key-outline' : challenge ? 'mail-outline' : 'shield-checkmark-outline'} color={loginColors.deepGreen} size={14} /><Text style={styles.badgeText}>{recovering ? 'ACCOUNT RECOVERY' : challenge ? 'EMAIL VERIFICATION' : 'SCHOOL ACCOUNT'}</Text></View>
            <Text accessibilityRole="header" style={styles.title}>{recovering ? 'Reset your password' : challenge ? 'Check your email' : 'Welcome back'}</Text>
            <Text style={styles.subtitle}>{recovering ? 'We’ll send a reset link to your registered email.' : challenge ? `Enter the six-digit code sent to ${challenge.deliveryHint || 'your registered email address'}.` : 'Sign in to continue to your EduMatch account.'}</Text>
          </View>
          <View style={styles.formBody}>
            {configurationError && <LoginNotice message={configurationError} error />}
            {error && <LoginNotice message={error} error />}
            {notice && <LoginNotice message={notice} />}
            {recovering ? <LoginInput label="Email address" icon="mail-outline" value={email} onChangeText={setEmail} placeholder="Your registered email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email" editable={!loading} returnKeyType="send" onSubmitEditing={() => void recoverPassword()} /> : challenge ? <>
              <LoginInput label="Verification code" icon="shield-checkmark-outline" value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter 6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} editable={!loading} returnKeyType="done" onSubmitEditing={openCaptcha} />
              {expirySeconds !== null && <Text accessibilityLiveRegion="polite" style={[styles.helper, expirySeconds === 0 && styles.expired]}>{expirySeconds > 0 ? `Code expires in ${expirySeconds}s` : 'This code has expired. Request a new code.'}</Text>}
              <TextAction title={resendSeconds !== null && resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'} disabled={loading || (resendSeconds !== null && resendSeconds > 0)} onPress={() => void resend()} />
            </> : <>
              <LoginInput label="Username" icon="person-outline" value={username} onChangeText={setUsername} placeholder="Enter your username" autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" editable={!loading} returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} />
              <LoginInput inputRef={passwordInput} label="Password" icon="lock-closed-outline" value={password} onChangeText={setPassword} placeholder="Enter your password" secureTextEntry={!showPassword} textContentType="password" autoComplete="current-password" autoCapitalize="none" autoCorrect={false} editable={!loading} returnKeyType="done" onSubmitEditing={openCaptcha}
                trailing={<Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} disabled={loading} onPress={() => setShowPassword(value => !value)} style={styles.passwordToggle}><Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={21} color={loginColors.deepGreen} /></Pressable>} />
            </>}
            {!recovering && <>
              <View style={styles.securityNote}>
                <Ionicons name="shield-checkmark-outline" size={20} color={loginColors.deepGreen} />
                <Text style={styles.securityText}>You’ll complete a security check to continue.</Text>
              </View>
              {!challenge && <View style={[styles.accountOptions, fontScale > 1.25 && styles.stackedOptions]}>
                <Pressable accessibilityRole="checkbox" accessibilityLabel="Keep me signed in on this device" accessibilityState={{ checked: remember, disabled: loading }} disabled={loading} onPress={() => setRemember(value => !value)} style={({ pressed }) => [styles.remember, pressed && { opacity: 0.7 }]}>
                  <View style={[styles.checkbox, remember && styles.checkboxChecked]}>{remember && <Ionicons name="checkmark" size={15} color="#FFFFFF" />}</View><Text style={styles.rememberText}>Remember me</Text>
                </Pressable>
                <TextAction title="Forgot password?" disabled={loading} onPress={() => { setRecovering(true); setPassword(''); setShowPassword(false); setError(null); setNotice(null); }} />
              </View>}
            </>}
            <LoginAction title={recovering ? 'Send reset link' : challenge ? 'Verify OTP' : 'Sign In'} loading={loading} loadingTitle={recovering ? 'Sending…' : challenge ? 'Verifying…' : 'Signing In…'} icon={recovering ? 'mail-outline' : challenge ? 'shield-checkmark-outline' : 'log-in-outline'} disabled={recovering ? !!configurationError || !email.trim() : !canSignIn} onPress={recovering ? () => void recoverPassword() : openCaptcha} />
            {(recovering || challenge) && <TextAction title="Back to Sign In" icon="arrow-back-outline" disabled={loading} onPress={backToSignIn} />}
          </View>
        </View>
      </View></View>
      <Text style={styles.copyright}>© {new Date().getFullYear()} EduMatch</Text>
    </View>
  </View>;
  return <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.scrollContent}>
        <View style={styles.layout}>{form}</View>
      </ScrollView>
    </KeyboardAvoidingView>
    {captcha && <Captcha key={captchaAttempt} visible onToken={token => void submit(token, captchaAttempt)} onClose={closeCaptcha} />}
  </SafeAreaView>;
}

function LoginInput({ label, icon, trailing, inputRef, ...props }: TextInputProps & {
  label: string; icon?: React.ComponentProps<typeof Ionicons>['name']; trailing?: React.ReactNode; inputRef?: React.RefObject<TextInput | null>;
}) {
  const [focused, setFocused] = useState(false);
  return <View style={styles.inputGroup}><Text style={styles.inputLabel}>{label}</Text>
    <View style={[styles.inputShell, focused && styles.focusedInput]}>{icon && <Ionicons name={icon} size={19} color={focused ? loginColors.deepGreen : '#7C8C75'} style={{ marginLeft: 14 }} />}<TextInput ref={inputRef} accessibilityLabel={label} placeholderTextColor={loginColors.muted} selectionColor={loginColors.deepGreen} {...props} onFocus={event => { setFocused(true); props.onFocus?.(event); }} onBlur={event => { setFocused(false); props.onBlur?.(event); }} style={[styles.input, props.style]} />{trailing}</View>
  </View>;
}

function LoginNotice({ message, error = false }: { message: string; error?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && styles.errorNotice]}><Ionicons name={error ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={20} color={error ? '#8F1F1F' : '#5F3B00'} /><Text style={[styles.noticeText, error && { color: '#8F1F1F' }]}>{message}</Text></View>;
}

function TextAction({ title, icon, onPress, disabled = false }: { title: string; icon?: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.textAction, disabled && { opacity: 0.5 }, pressed && { backgroundColor: '#EFF5E9' }]}>{icon && <Ionicons name={icon} size={18} color={loginColors.deepGreen} />}<Text style={styles.textActionTitle}>{title}</Text></Pressable>;
}

function LoginAction({ title, loadingTitle, icon, onPress, loading, disabled }: {
  title: string; loadingTitle: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; loading: boolean; disabled: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.submit, (disabled || loading) && { opacity: 0.62 }, pressed && { opacity: 0.85 }]}>
    {loading && <ActivityIndicator size="small" color="#FFFFFF" />}<Text style={styles.submitTitle}>{loading ? loadingTitle : title}</Text>{!loading && <Ionicons name={icon} size={20} color="#FFFFFF" />}
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: loginColors.background }, keyboard: { flex: 1 }, scrollContent: { flexGrow: 1 }, layout: { flexGrow: 1, flexShrink: 0 },
  formPanel: { flexGrow: 1, flexShrink: 0, paddingHorizontal: 24, paddingVertical: 32, justifyContent: 'center', alignItems: 'center', backgroundColor: loginColors.background },
  compactPanel: { paddingHorizontal: 16 }, shortPanel: { paddingVertical: 20 }, formShell: { width: '100%', maxWidth: 440, gap: 24 },
  cardShadow: { borderRadius: 24, shadowColor: loginColors.darkGreen, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.07, shadowRadius: 24, elevation: 3 },
  cardFrame: { borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: '#E4EADF', backgroundColor: '#FFFFFF' },
  card: { padding: 24, backgroundColor: '#FFFFFF' }, compactCard: { padding: 20 },
  cardHeader: { marginBottom: 24, gap: 8 }, badge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  badgeText: { color: loginColors.deepGreen, fontSize: 11, fontWeight: '700', letterSpacing: 1.1 }, title: { fontSize: 28, lineHeight: 35, color: loginColors.darkGreen, fontWeight: '800', letterSpacing: -0.7 }, subtitle: { color: loginColors.muted, fontSize: 14, lineHeight: 21 },
  formBody: { gap: 16 }, inputGroup: { gap: 8 }, inputLabel: { color: loginColors.ink, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  inputShell: { flexDirection: 'row', alignItems: 'center', minHeight: 54, borderWidth: 1, borderColor: '#DDE5D8', backgroundColor: '#FAFCF9', borderRadius: 12, overflow: 'hidden' }, focusedInput: { borderColor: loginColors.green, backgroundColor: '#FFFFFF' },
  input: { flex: 1, minWidth: 0, minHeight: 54, paddingHorizontal: 12, paddingVertical: 14, color: loginColors.ink, fontSize: 16 }, passwordToggle: { minHeight: 48, width: 44, justifyContent: 'center', alignItems: 'center' }, helper: { color: '#647067', fontSize: 13, lineHeight: 19 }, expired: { color: '#B42318' },
  securityNote: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, backgroundColor: '#F0F6EB' }, securityText: { flex: 1, color: '#4B6640', fontSize: 12, lineHeight: 18 },
  accountOptions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }, stackedOptions: { flexDirection: 'column', alignItems: 'flex-start' },
  remember: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }, checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: '#A4B39B', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }, checkboxChecked: { backgroundColor: loginColors.deepGreen, borderColor: loginColors.deepGreen }, rememberText: { flexShrink: 1, color: '#4B5563', fontSize: 13, lineHeight: 20 },
  submit: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 15, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: loginColors.deepGreen }, submitTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', lineHeight: 24, flexShrink: 1 }, textAction: { minHeight: 44, borderRadius: 8, paddingHorizontal: 2, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, flexShrink: 1 }, textActionTitle: { color: loginColors.deepGreen, fontSize: 13, fontWeight: '600', lineHeight: 20, flexShrink: 1 },
  copyright: { color: loginColors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' }, notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#E4D39C', backgroundColor: '#FFF9E8' }, errorNotice: { backgroundColor: '#FFF3F2', borderColor: '#F3D0CB' }, noticeText: { flex: 1, color: '#6E542A', fontSize: 13, lineHeight: 20 },
});
