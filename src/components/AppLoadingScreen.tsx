import { useRef } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

export type AppLoadingScreenProps = {
  message?: string;
  error?: string | null;
  onRetry?: () => void;
  onSignIn?: () => void;
  fontsReady?: boolean;
  onReady?: () => void;
};

const palette = {
  canvas: '#F8FAFC', white: '#FFFFFF', primary: '#69AA47', darkGreen: '#3F7F2A',
  ink: '#18261D', muted: '#64716A', pale: '#EFF7E9', border: '#DCE6D7',
};

export function AppLoadingScreen({
  message = 'Getting your learning space ready…', error, onRetry, onSignIn,
  fontsReady = true, onReady,
}: AppLoadingScreenProps) {
  const { width, height } = useWindowDimensions();
  const compact = width < 360;
  const shortScreen = height < 680;
  const sealSize = compact || shortScreen ? 128 : 160;
  const typography = fontsReady ? interTypography : systemTypography;
  const readyReported = useRef(false);
  const layoutReady = useRef(false);
  const imageReady = useRef(false);
  const reportReady = () => {
    if (layoutReady.current && imageReady.current && !readyReported.current && onReady) {
      readyReported.current = true;
      onReady();
    }
  };
  const handleLayout = () => { layoutReady.current = true; reportReady(); };
  const handleImageReady = () => { imageReady.current = true; reportReady(); };

  return <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']} onLayout={handleLayout}>
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.decoration}>
      <View style={styles.topGlow} />
      <View style={styles.whiteGlow} />
      <LinearGradient colors={['#FFD542', '#BBFF59']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bottomGlow} />
    </View>

    <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.page, compact && styles.compactPage, shortScreen && styles.shortPage]}>
      <View style={[styles.main, shortScreen && styles.shortMain]}>
        <View style={styles.brand}>
          <View style={[styles.sealHalo, { width: sealSize + 32, height: sealSize + 32, borderRadius: (sealSize + 32) / 2 }]}>
            <Image source={require('../../assets/edumatch-school-logo.png')} resizeMode="contain"
              onLoad={handleImageReady} onError={handleImageReady}
              accessibilityLabel="San Josef National High School seal" style={{ width: sealSize, height: sealSize }} />
          </View>
          <View style={styles.brandCopy}>
            <Text accessibilityRole="header" style={[styles.wordmark, compact && styles.compactWordmark, typography.extraBold]}>EduMatch<Text style={styles.brandDot}>.</Text></Text>
            <Text style={[styles.tagline, typography.medium]}>Find Your Learning Match.</Text>
          </View>
        </View>

        {error ? <View style={styles.errorCard}>
          <View style={styles.errorHeading}>
            <View style={styles.errorMark} accessible={false}><Text allowFontScaling={false} style={[styles.errorMarkText, typography.bold]}>!</Text></View>
            <Text accessibilityRole="header" style={[styles.errorTitle, typography.bold]}>Let’s get you connected.</Text>
          </View>
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.errorText, typography.regular]}>{error}</Text>
          {(onRetry || onSignIn) && <View style={styles.actions}>
            {onRetry && <Pressable accessibilityRole="button" onPress={onRetry}
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <Text style={[styles.buttonLabel, typography.semibold]}>Retry connection</Text>
            </Pressable>}
            {onSignIn && <Pressable accessibilityRole="button" onPress={onSignIn}
              style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.pressed]}>
              <Text style={[styles.buttonLabel, styles.secondaryButtonLabel, typography.semibold]}>Return to sign in</Text>
            </Pressable>}
          </View>}
        </View> : <View style={styles.loadingStatus}>
          <View style={styles.spinnerFrame}>
            <ActivityIndicator size="small" color={palette.darkGreen} accessibilityRole="progressbar"
              accessibilityLabel="Loading EduMatch" accessibilityState={{ busy: true }} />
          </View>
          <Text accessibilityLiveRegion="polite" style={[styles.loadingMessage, typography.medium]}>{message}</Text>
        </View>}
      </View>

      <View style={styles.footer}>
        <View style={styles.footerRule} accessible={false} />
        <Text style={[styles.schoolName, typography.semibold]}>San Josef National High School</Text>
        <Text style={[styles.studentMessage, typography.regular]}>Learn · Connect · Grow</Text>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const interTypography = StyleSheet.create({
  regular: { fontFamily: 'Inter_400Regular' }, medium: { fontFamily: 'Inter_500Medium' },
  semibold: { fontFamily: 'Inter_600SemiBold' }, bold: { fontFamily: 'Inter_700Bold' },
  extraBold: { fontFamily: 'Inter_800ExtraBold' },
});
const systemTypography = StyleSheet.create({
  regular: { fontWeight: '400' }, medium: { fontWeight: '500' },
  semibold: { fontWeight: '600' }, bold: { fontWeight: '700' }, extraBold: { fontWeight: '800' },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.canvas, overflow: 'hidden' },
  decoration: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  topGlow: { position: 'absolute', width: 260, height: 260, borderRadius: 130, backgroundColor: palette.pale, opacity: 0.8, top: -125, left: -125 },
  whiteGlow: { position: 'absolute', width: 270, height: 270, borderRadius: 135, backgroundColor: palette.white, opacity: 0.7, top: '21%', right: -190 },
  bottomGlow: { position: 'absolute', width: 260, height: 260, borderRadius: 130, opacity: 0.12, bottom: -165, right: -90 },
  scroll: { flex: 1 },
  page: { flexGrow: 1, width: '100%', maxWidth: 440, alignSelf: 'center', paddingHorizontal: 28, paddingTop: 28, paddingBottom: 26 },
  compactPage: { paddingHorizontal: 20 }, shortPage: { paddingTop: 18, paddingBottom: 18 },
  main: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 28 }, shortMain: { paddingVertical: 16 },
  brand: { width: '100%', alignItems: 'center', gap: 23 },
  sealHalo: { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.white, borderWidth: 1, borderColor: '#E7EDE5', shadowColor: palette.darkGreen, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.06, shadowRadius: 24, elevation: 2 },
  brandCopy: { width: '100%', alignItems: 'center', gap: 5 },
  wordmark: { fontSize: 40, lineHeight: 49, letterSpacing: -1.8, color: palette.darkGreen, textAlign: 'center' }, compactWordmark: { fontSize: 35, lineHeight: 44 },
  brandDot: { color: palette.primary }, tagline: { fontSize: 13, lineHeight: 21, color: palette.muted, textAlign: 'center' },
  loadingStatus: { width: '100%', alignItems: 'center', gap: 18, marginTop: 35 },
  spinnerFrame: { width: 48, height: 48, borderRadius: 16, backgroundColor: palette.white, borderWidth: 1, borderColor: '#E7EDE5', alignItems: 'center', justifyContent: 'center' },
  loadingMessage: { fontSize: 13, lineHeight: 21, textAlign: 'center', color: palette.muted, maxWidth: 290 },
  errorCard: { width: '100%', padding: 20, marginTop: 32, backgroundColor: palette.white, borderRadius: 22, borderWidth: 1, borderColor: palette.border, gap: 14 },
  errorHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorMark: { width: 30, height: 30, borderRadius: 10, backgroundColor: palette.pale, alignItems: 'center', justifyContent: 'center' },
  errorMarkText: { fontSize: 17, lineHeight: 24, color: palette.darkGreen },
  errorTitle: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 24, color: palette.ink },
  errorText: { fontSize: 13, lineHeight: 21, color: palette.muted },
  actions: { gap: 9, marginTop: 3 },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.darkGreen },
  buttonLabel: { fontSize: 13, lineHeight: 21, color: palette.white, textAlign: 'center' },
  secondaryButton: { backgroundColor: palette.pale }, secondaryButtonLabel: { color: palette.darkGreen }, pressed: { opacity: 0.82 },
  footer: { alignItems: 'center', gap: 7, paddingTop: 28 },
  footerRule: { width: 28, height: 2, borderRadius: 1, backgroundColor: palette.primary, marginBottom: 7 },
  schoolName: { fontSize: 11, lineHeight: 18, textAlign: 'center', color: palette.muted },
  studentMessage: { fontSize: 10, lineHeight: 17, letterSpacing: 1.1, textAlign: 'center', color: palette.muted },
});
