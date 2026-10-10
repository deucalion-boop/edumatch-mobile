import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoginBranding, loginColors } from './LoginVisuals';

const steps = [
  {
    title: 'Contact your school',
    detail: 'Ask your teacher, secretary, or school administrator to create your EduMatch account.',
    icon: 'school-outline',
  },
  {
    title: 'Check your email',
    detail: 'Your school will email your username and temporary password to your registered Gmail address.',
    icon: 'mail-outline',
  },
  {
    title: 'Sign in and get started',
    detail: 'Use your account details, verify your email, and choose a new password when prompted.',
    icon: 'log-in-outline',
  },
] as const;

export function RegisterScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const signIn = () => router.replace('/login');

  return <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.page, compact && styles.compactPage]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to sign in" onPress={signIn}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
        <Ionicons name="arrow-back" size={19} color={loginColors.deepGreen} />
        <Text style={styles.backLabel}>Back to sign in</Text>
      </Pressable>

      <View style={styles.brand}><LoginBranding /></View>

      <View style={styles.heading}>
        <View style={styles.eyebrow}>
          <Ionicons name="sparkles-outline" size={14} color={loginColors.deepGreen} accessible={false} />
          <Text style={styles.eyebrowLabel}>LET'S GET YOU STARTED</Text>
        </View>
        <Text accessibilityRole="header" style={[styles.title, compact && styles.compactTitle]}>
          Your learning journey starts here.
        </Text>
        <Text style={styles.subtitle}>Your school creates your EduMatch account. Getting started takes three simple steps.</Text>
      </View>

      <View style={[styles.card, compact && styles.compactCard]}>
        <View style={styles.cardHeading}>
          <View style={styles.cardIcon}><Ionicons name="person-add-outline" size={21} color={loginColors.deepGreen} accessible={false} /></View>
          <View style={styles.cardHeadingCopy}>
            <Text accessibilityRole="header" style={styles.cardTitle}>Your school-issued account</Text>
            <Text style={styles.cardSubtitle}>A personal space for your school journey.</Text>
          </View>
        </View>

        <View style={styles.steps}>
          {steps.map((step, index) => <View key={step.title} style={styles.stepRow}>
            <View style={styles.stepNumber} accessible={false}><Text style={styles.stepNumberLabel}>{index + 1}</Text></View>
            <View style={styles.stepCopy}>
              <View style={styles.stepHeading}>
                <Text accessibilityRole="header" style={styles.stepTitle}>{step.title}</Text>
                <Ionicons name={step.icon} size={19} color={loginColors.deepGreen} accessible={false} />
              </View>
              <Text style={styles.stepDetail}>{step.detail}</Text>
              {index < steps.length - 1 ? <View style={styles.stepDivider} /> : null}
            </View>
          </View>)}
        </View>

        <View style={styles.emailHint}>
          <Ionicons name="information-circle-outline" size={18} color={loginColors.deepGreen} accessible={false} />
          <Text style={styles.emailHintText}>Can't find your account email? Check Spam, then ask your school to confirm your email address.</Text>
        </View>

        <Text style={styles.readyLabel}>Already have your account details?</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Sign in with your school account" onPress={signIn}
          style={({ pressed }) => [styles.signInButton, pressed && styles.pressed]}>
          <Text style={styles.signInLabel}>Sign in</Text>
          <Ionicons name="arrow-forward" size={19} color="#FFFFFF" accessible={false} />
        </Pressable>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="Forgot password" onPress={() => router.replace({ pathname: '/login', params: { recover: '1' } })}
        style={({ pressed }) => [styles.recoveryButton, pressed && styles.pressed]}>
        <Text style={styles.recoveryLabel}>Forgot password?</Text>
      </Pressable>
      <Text style={styles.footer}>Learning, connected.</Text>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: loginColors.background },
  scroll: { flex: 1 },
  page: { flexGrow: 1, width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 8, paddingBottom: 28 },
  compactPage: { paddingHorizontal: 18 },
  backButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8, paddingVertical: 10, paddingRight: 12 },
  backLabel: { color: loginColors.deepGreen, fontFamily: 'Inter_600SemiBold', fontSize: 13, lineHeight: 20 },
  pressed: { opacity: 0.75 },
  brand: { marginTop: 12 },
  heading: { alignItems: 'center', marginTop: 30, marginBottom: 25 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: loginColors.softGreen, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 15 },
  eyebrowLabel: { color: loginColors.deepGreen, fontFamily: 'Inter_700Bold', fontSize: 10, lineHeight: 15, letterSpacing: 0.8 },
  title: { color: loginColors.ink, fontFamily: 'Inter_800ExtraBold', fontSize: 31, lineHeight: 39, letterSpacing: -1.1, textAlign: 'center', maxWidth: 375 },
  compactTitle: { fontSize: 28, lineHeight: 36 },
  subtitle: { color: loginColors.muted, fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 350, marginTop: 13 },
  card: { backgroundColor: loginColors.card, borderWidth: 1, borderColor: loginColors.softBorder, borderRadius: 24, padding: 23, shadowColor: '#233D1A', shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.045, shadowRadius: 18, elevation: 2 },
  compactCard: { padding: 18 },
  cardHeading: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 25 },
  cardIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: loginColors.softGreen, alignItems: 'center', justifyContent: 'center' },
  cardHeadingCopy: { flex: 1, minWidth: 0 },
  cardTitle: { color: loginColors.ink, fontFamily: 'Inter_700Bold', fontSize: 15, lineHeight: 22, letterSpacing: -0.3 },
  cardSubtitle: { color: loginColors.muted, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17, marginTop: 2 },
  steps: { gap: 18 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepNumber: { width: 31, height: 31, borderRadius: 11, backgroundColor: loginColors.softGreen, borderWidth: 1, borderColor: loginColors.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumberLabel: { color: loginColors.deepGreen, fontFamily: 'Inter_700Bold', fontSize: 13, lineHeight: 18 },
  stepCopy: { flex: 1, minWidth: 0 },
  stepHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  stepTitle: { flex: 1, color: loginColors.ink, fontFamily: 'Inter_600SemiBold', fontSize: 14, lineHeight: 21, letterSpacing: -0.15 },
  stepDetail: { color: loginColors.muted, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 20, marginTop: 5 },
  stepDivider: { height: 1, backgroundColor: loginColors.softBorder, marginTop: 18 },
  emailHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: loginColors.softGreen, padding: 12, borderRadius: 12, marginTop: 23 },
  emailHintText: { flex: 1, color: loginColors.deepGreen, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 18 },
  readyLabel: { color: loginColors.muted, fontFamily: 'Inter_500Medium', fontSize: 12, lineHeight: 19, textAlign: 'center', marginTop: 23, marginBottom: 11 },
  signInButton: { minHeight: 52, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 14, backgroundColor: loginColors.deepGreen, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  signInLabel: { color: '#FFFFFF', fontFamily: 'Inter_700Bold', fontSize: 14, lineHeight: 22 },
  recoveryButton: { alignSelf: 'center', minHeight: 44, paddingHorizontal: 18, paddingVertical: 12, marginTop: 14, justifyContent: 'center' },
  recoveryLabel: { color: loginColors.deepGreen, fontFamily: 'Inter_600SemiBold', fontSize: 12, lineHeight: 19 },
  footer: { color: loginColors.muted, fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 10 },
});
