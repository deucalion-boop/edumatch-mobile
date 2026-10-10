import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { authApi } from '../api/edumatch';
import type { LoginChallenge } from '../api/types';
import { configurationError } from '../config';
import { errorMessage } from '../api/client';
import { Captcha } from './Captcha';
import { useAuth } from './AuthProvider';
import { LoginBranding, loginColors, loginFonts, loginGradient, LoginHero } from './LoginVisuals';

function secondsUntil(value: string | null, now: number): number | null {
  if (!value) return null;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function LoginScreen() {
  const { acceptSession } = useAuth();
  const router = useRouter();
  const { recover } = useLocalSearchParams<{ recover?: string }>();
  const { width, height, fontScale } = useWindowDimensions();
  const compact = width < 360;
  const shortScreen = height < 720;
  const wide = width >= 900 && fontScale <= 1.3;
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [recovering, setRecovering] = useState(recover === '1');
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
  const usernameInput = useRef<TextInput>(null);
  const passwordInput = useRef<TextInput>(null);
  const expirySeconds = challenge ? secondsUntil(challenge.expiresAt, now) : null;
  const resendSeconds = challenge ? secondsUntil(challenge.resendAvailableAt, now) : null;
  const canSignIn = !configurationError && !loading && (challenge ? code.length === 6 && expirySeconds !== 0 : !!username.trim() && !!password);

  useEffect(() => { if (recover === '1') setRecovering(true); }, [recover]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!challenge) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') setNow(Date.now()); });
    return () => { clearInterval(interval); appState.remove(); };
  }, [challenge]);

  const closeCaptcha = () => { captchaOpen.current = false; setCaptcha(false); };
  const openCaptcha = () => {
    if (loading || configurationError || requestInFlight.current || captchaOpen.current) return;
    if (!canSignIn) {
      setError(challenge ? expirySeconds === 0 ? 'This code has expired. Request a new code.' : 'Enter the six-digit verification code.' : !username.trim() ? 'Enter your username.' : 'Enter your password.');
      if (!challenge) { if (!username.trim()) usernameInput.current?.focus(); else passwordInput.current?.focus(); }
      return;
    }
    Keyboard.dismiss();
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
    if (requestInFlight.current || configurationError) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address to receive your reset link.'); return; }
    Keyboard.dismiss();
    requestInFlight.current = true; setLoading(true); setError(null); setNotice(null);
    try { await authApi.forgotPassword(email.trim()); setNotice('If an EduMatch account uses this email, password reset instructions have been sent. Check your inbox.'); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { requestInFlight.current = false; setLoading(false); }
  };
  const backToSignIn = () => { if (requestInFlight.current) return; closeCaptcha(); setRecovering(false); if (recover) router.setParams({ recover: undefined }); setChallenge(null); setCode(''); setPassword(''); setShowPassword(false); setError(null); setNotice(null); };

  const card = <View style={styles.cardColumn}>
    <View style={styles.cardShadow}>
      <View style={[styles.card, compact && styles.compactCard]}>
        <View style={styles.cardHeader}>
          {(recovering || challenge) && <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={styles.title}>{recovering ? 'A fresh start.' : 'Check your email'}</Text>
            <View style={styles.greeting} accessible={false}>
              <Ionicons name={recovering ? 'key-outline' : 'mail-outline'} size={21} color={loginColors.deepGreen} />
            </View>
          </View>}
          <Text style={styles.subtitle}>{recovering ? 'We’ll send a reset link to your registered email. You’ll be back to learning in no time.' : challenge ? `Enter the six-digit code sent to ${challenge.deliveryHint || 'your registered email address'}.` : 'Log in to continue and find your perfect match in academics and beyond.'}</Text>
        </View>
        <View style={styles.formBody}>
          {configurationError && <LoginNotice message={configurationError} error />}
          {error && <LoginNotice message={error} error />}
          {notice && <LoginNotice message={notice} />}
          {recovering ? <LoginInput label="Email address" icon="mail-outline" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email" editable={!loading} returnKeyType="send" onSubmitEditing={() => void recoverPassword()} /> : challenge ? <>
            <LoginInput label="Verification code" icon="shield-checkmark-outline" value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter 6-digit code" keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} editable={!loading} returnKeyType="done" onSubmitEditing={openCaptcha} />
            {expirySeconds !== null && <Text accessibilityLiveRegion={expirySeconds === 0 ? 'polite' : 'none'} aria-live={expirySeconds === 0 ? 'polite' : 'off'} style={[styles.helper, expirySeconds === 0 && styles.expired]}>{expirySeconds > 0 ? `Code expires in ${expirySeconds}s` : 'This code has expired. Request a new code.'}</Text>}
            <TextAction title={resendSeconds !== null && resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'} disabled={loading || (resendSeconds !== null && resendSeconds > 0)} onPress={() => void resend()} />
          </> : <>
            <LoginInput inputRef={usernameInput} label="Username" icon="person-outline" value={username} onChangeText={setUsername} placeholder="Enter your username" autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" editable={!loading} returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} />
            <LoginInput inputRef={passwordInput} label="Password" icon="lock-closed-outline" value={password} onChangeText={setPassword} placeholder="Enter your password" secureTextEntry={!showPassword} textContentType="password" autoComplete="current-password" autoCapitalize="none" autoCorrect={false} editable={!loading} returnKeyType="done" onSubmitEditing={openCaptcha}
              trailing={<Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} accessibilityState={{ disabled: loading }} aria-disabled={loading} disabled={loading} onPress={() => setShowPassword(value => !value)} style={styles.passwordToggle}><Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={21} color={loginColors.deepGreen} /></Pressable>} />
            <View style={[styles.accountOptions, (compact || fontScale > 1.25) && styles.stackedOptions]}>
              <Pressable accessibilityRole="checkbox" accessibilityLabel="Remember Me" accessibilityHint="Keep this account signed in on this device" accessibilityState={{ checked: remember, disabled: loading }} aria-checked={remember} aria-disabled={loading} disabled={loading} onPress={() => setRemember(value => !value)} style={({ pressed }) => [styles.remember, pressed && { opacity: 0.7 }]}>
                <View style={[styles.checkbox, remember && styles.checkboxChecked]}>{remember && <Ionicons name="checkmark" size={15} color="#FFFFFF" />}</View><Text style={styles.rememberText}>Remember Me</Text>
              </Pressable>
              <TextAction title="Forgot Password?" disabled={loading} onPress={() => { setRecovering(true); setPassword(''); setShowPassword(false); setError(null); setNotice(null); }} />
            </View>
          </>}
          <LoginAction title={recovering ? 'Send reset link' : challenge ? 'Verify code' : 'Log In'} loading={loading} loadingTitle={recovering ? 'Sending…' : challenge ? 'Verifying…' : 'Logging in…'} disabled={!!configurationError} onPress={recovering ? () => void recoverPassword() : openCaptcha} />
          {(recovering || challenge) && <TextAction title="Back to Log In" icon="arrow-back-outline" disabled={loading} onPress={backToSignIn} />}
        </View>
      </View>
    </View>
    {!recovering && <View style={styles.securityNote}><Ionicons name="shield-checkmark-outline" size={15} color={loginColors.deepGreen} /><Text style={styles.securityText}>A quick security check keeps your account safe.</Text></View>}
  </View>;

  return <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
    <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets={false} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.formPanel, compact && styles.compactPanel, shortScreen && styles.shortPanel]}>
          <View style={[styles.formShell, wide && styles.wideShell]}>
            <LoginBranding />
            <View style={[styles.composition, wide && styles.wideComposition]}>
              {!keyboardVisible && !recovering && !challenge && <View style={[styles.heroColumn, wide && styles.wideHeroColumn]}><LoginHero compact={compact || shortScreen} largeText={fontScale > 1.3} wide={wide} /></View>}
              {card}
            </View>
            <Text style={styles.copyright}>© {new Date().getFullYear()} EduMatch · Keep growing, together.</Text>
          </View>
        </View>
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
    <View style={[styles.inputShell, focused && styles.focusedInput]}>{icon && <Ionicons name={icon} size={19} color={loginColors.deepGreen} style={{ marginLeft: 15 }} />}<TextInput ref={inputRef} accessibilityLabel={label} placeholderTextColor={loginColors.muted} selectionColor={loginColors.deepGreen} {...props} onFocus={event => { setFocused(true); props.onFocus?.(event); }} onBlur={event => { setFocused(false); props.onBlur?.(event); }} style={[styles.input, props.style]} />{trailing}</View>
  </View>;
}

function LoginNotice({ message, error = false }: { message: string; error?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && styles.errorNotice]}><Ionicons name={error ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={20} color={error ? '#8F1F1F' : '#5F3B00'} /><Text style={[styles.noticeText, error && { color: '#8F1F1F' }]}>{message}</Text></View>;
}

function TextAction({ title, icon, onPress, disabled = false }: { title: string; icon?: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }} aria-disabled={disabled} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.textAction, disabled && { opacity: 0.5 }, pressed && { backgroundColor: '#EFF5E9' }]}>{icon && <Ionicons name={icon} size={18} color={loginColors.deepGreen} />}<Text style={styles.textActionTitle}>{title}</Text></Pressable>;
}

function LoginAction({ title, loadingTitle, onPress, loading, disabled }: {
  title: string; loadingTitle: string; onPress: () => void; loading: boolean; disabled: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  return <Pressable accessibilityRole="button" accessibilityLabel={loading ? loadingTitle : title} accessibilityState={{ disabled: disabled || loading, busy: loading }} aria-disabled={disabled || loading} aria-busy={loading} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.submit, (disabled || loading) && { opacity: 0.62 }, pressed && { opacity: 0.85 }]}>
    <LinearGradient colors={loginGradient} locations={[0, 0.5, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.submitGradient}>
      <View style={[styles.submitContent, title !== 'Send reset link' && (loading || fontScale > 1.3 || title !== 'Log In') && styles.submitContrast]}>{loading && <ActivityIndicator size="small" color={loginColors.darkGreen} />}<Text style={styles.submitTitle}>{loading ? loadingTitle : title}</Text></View>
    </LinearGradient>
  </Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: loginColors.background }, keyboard: { flex: 1 }, scrollContent: { flexGrow: 1 },
  formPanel: { flexGrow: 1, paddingHorizontal: 22, paddingVertical: 24, justifyContent: 'center', alignItems: 'center' },
  compactPanel: { paddingHorizontal: 16 }, shortPanel: { paddingVertical: 18 }, formShell: { width: '100%', maxWidth: 440, gap: 22 }, wideShell: { maxWidth: 1040, gap: 44 },
  composition: { gap: 18 }, wideComposition: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 68 },
  heroColumn: { width: '100%' }, wideHeroColumn: { flex: 1, minWidth: 0 }, cardColumn: { width: '100%', maxWidth: 440, gap: 16, alignSelf: 'center' },
  cardShadow: { borderRadius: 26, shadowColor: loginColors.darkGreen, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.07, shadowRadius: 26, elevation: 4, backgroundColor: loginColors.card },
  card: { padding: 24, borderRadius: 26, borderWidth: 1, borderColor: loginColors.softBorder, backgroundColor: loginColors.card }, compactCard: { padding: 20 },
  cardHeader: { marginBottom: 22, gap: 8 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  greeting: { minWidth: 34, minHeight: 34, borderRadius: 12, backgroundColor: loginColors.softGreen, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: loginFonts.bold, fontSize: 26, lineHeight: 34, color: loginColors.deepGreen, letterSpacing: -0.8, flexShrink: 1 }, subtitle: { fontFamily: loginFonts.regular, color: loginColors.muted, fontSize: 13, lineHeight: 20 },
  formBody: { gap: 16 }, inputGroup: { gap: 8 }, inputLabel: { fontFamily: loginFonts.semibold, color: loginColors.ink, fontSize: 13, lineHeight: 19 },
  inputShell: { flexDirection: 'row', alignItems: 'center', minHeight: 54, borderWidth: 1, borderColor: loginColors.border, backgroundColor: loginColors.background, borderRadius: 14, overflow: 'hidden' }, focusedInput: { borderColor: loginColors.green, backgroundColor: loginColors.card },
  input: { flex: 1, minWidth: 0, minHeight: 54, paddingHorizontal: 12, paddingVertical: 14, fontFamily: loginFonts.regular, color: loginColors.ink, fontSize: 14 }, passwordToggle: { minHeight: 48, width: 44, justifyContent: 'center', alignItems: 'center' }, helper: { fontFamily: loginFonts.regular, color: loginColors.muted, fontSize: 13, lineHeight: 19 }, expired: { color: '#B42318' },
  securityNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 8 }, securityText: { flexShrink: 1, fontFamily: loginFonts.regular, color: loginColors.muted, fontSize: 10, lineHeight: 16 },
  accountOptions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', marginVertical: -5 }, stackedOptions: { gap: 0, alignItems: 'flex-start' },
  remember: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }, checkbox: { width: 19, height: 19, borderRadius: 6, borderWidth: 1.5, borderColor: '#A4B39B', backgroundColor: loginColors.card, alignItems: 'center', justifyContent: 'center' }, checkboxChecked: { backgroundColor: loginColors.deepGreen, borderColor: loginColors.deepGreen }, rememberText: { flexShrink: 1, fontFamily: loginFonts.medium, color: loginColors.muted, fontSize: 11, lineHeight: 18 },
  submit: { borderRadius: 14, shadowColor: loginColors.green, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.22, shadowRadius: 10, elevation: 3 },
  submitGradient: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  submitContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10 }, submitContrast: { backgroundColor: loginColors.gold },
  submitTitle: { fontFamily: loginFonts.bold, color: loginColors.darkGreen, fontSize: 15, lineHeight: 22, flexShrink: 1 },
  textAction: { minHeight: 44, borderRadius: 8, paddingHorizontal: 2, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, flexShrink: 1 }, textActionTitle: { fontFamily: loginFonts.semibold, color: loginColors.deepGreen, fontSize: 11, lineHeight: 18, flexShrink: 1 },
  copyright: { fontFamily: loginFonts.regular, color: loginColors.muted, fontSize: 10, lineHeight: 17, textAlign: 'center' }, notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#E4D39C', backgroundColor: '#FFF9E8' }, errorNotice: { backgroundColor: '#FFF3F2', borderColor: '#F3D0CB' }, noticeText: { flex: 1, fontFamily: loginFonts.regular, color: '#6E542A', fontSize: 13, lineHeight: 20 },
});
