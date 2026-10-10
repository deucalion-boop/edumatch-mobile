import { Image, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

export const loginColors = {
  background: '#F8FAFC', card: '#FFFFFF', darkGreen: '#1E4307', green: '#69AA47', deepGreen: '#3F7F2A',
  gold: '#FFD542', lime: '#BBFF59', ink: '#18261D', muted: '#64716A', border: '#DCE6D7',
  softBorder: '#E7EDE5', softGreen: '#EFF7E9',
};

export const loginGradient = ['#1E4307', '#FFD542', '#BBFF59'] as const;
export const loginFonts = {
  regular: 'Inter_400Regular', medium: 'Inter_500Medium', semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold', extraBold: 'Inter_800ExtraBold',
};

export function LoginBranding() {
  return <View style={styles.brand}>
    <View style={styles.brandMark}><Ionicons name="school-outline" size={27} color={loginColors.deepGreen} /></View>
    <View style={styles.brandCopy}>
      <Text style={styles.brandName}>EduMatch<Text style={styles.brandDot}>.</Text></Text>
      <Text style={styles.tagline}>Find Your Learning Match.</Text>
    </View>
  </View>;
}

export function LoginHero({ compact = false, largeText = false, wide = false }: { compact?: boolean; largeText?: boolean; wide?: boolean }) {
  return <View style={[styles.hero, wide && styles.wideHero]}>
    <View style={styles.heroCopy}>
      <Text accessibilityRole="header" style={[styles.headline, compact && styles.compactHeadline, wide && styles.wideHeadline]}>Better Connections.{ '\n' }<Text style={styles.headlineHighlight}>Brighter Futures.</Text></Text>
      <Text style={[styles.description, wide && styles.wideDescription]}>Log in to continue your journey and discover opportunities that fit you.</Text>
    </View>
    <View style={[styles.scene, { height: wide ? 320 : compact ? 164 : 204 }, largeText && styles.largeTextScene]}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
        <View style={[styles.orbit, wide && styles.wideOrbit]} />
        <LinearGradient colors={loginGradient} locations={[0, 0.5, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.heroShape, wide && styles.wideShape]} />
        <View style={[styles.limeShape, wide && styles.wideLime]} />
        <View style={styles.goldDot} />
      </View>
      <Image source={require('../../assets/login-student.png')} accessibilityLabel="A smiling student in a green hoodie with a backpack and book" style={[styles.student, { height: wide ? 326 : compact ? 175 : 219, width: wide ? 326 : compact ? 175 : 219 }]} resizeMode="contain" />
      <View style={[styles.floatingCard, styles.buddiesCard, wide && styles.wideBuddies, largeText && styles.flowingCard]}>
        <View style={styles.floatingIcon}><Ionicons name="people-outline" size={18} color={loginColors.deepGreen} /></View>
        <Text style={styles.floatingLabel}>Find Your Strength</Text>
      </View>
      <View style={[styles.floatingCard, styles.programsCard, compact && styles.compactPrograms, wide && styles.widePrograms, largeText && styles.flowingCard]}>
        <View style={[styles.floatingIcon, styles.programIcon]}><Ionicons name="book-outline" size={18} color={loginColors.deepGreen} /></View>
        <Text style={styles.floatingLabel}>Discover Programs</Text>
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  brandMark: { width: 48, height: 48, borderRadius: 16, backgroundColor: loginColors.softGreen, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: loginColors.border },
  brandCopy: { flex: 1, minWidth: 0 }, brandName: { fontFamily: loginFonts.extraBold, fontSize: 25, lineHeight: 31, letterSpacing: -1, color: loginColors.deepGreen },
  brandDot: { color: loginColors.green }, tagline: { fontFamily: loginFonts.medium, fontSize: 11, lineHeight: 17, color: loginColors.muted },
  hero: { gap: 12 }, wideHero: { gap: 24, flex: 1, justifyContent: 'center' }, heroCopy: { gap: 9 },
  headline: { fontFamily: loginFonts.extraBold, fontSize: 29, lineHeight: 35, letterSpacing: -1.2, color: loginColors.deepGreen }, compactHeadline: { fontSize: 25, lineHeight: 31 },
  wideHeadline: { fontSize: 42, lineHeight: 51, letterSpacing: -1.7 }, headlineHighlight: { color: loginColors.deepGreen },
  description: { fontFamily: loginFonts.regular, fontSize: 13, lineHeight: 20, color: loginColors.muted, maxWidth: 360 }, wideDescription: { fontSize: 15, lineHeight: 24 },
  scene: { position: 'relative', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 }, largeTextScene: { height: 'auto', gap: 8, paddingBottom: 8 },
  student: { zIndex: 1 },
  heroShape: { position: 'absolute', width: '72%', height: '72%', bottom: 3, right: '10%', borderTopLeftRadius: 110, borderTopRightRadius: 86, borderBottomLeftRadius: 82, borderBottomRightRadius: 36, transform: [{ rotate: '-12deg' }], opacity: 0.85 },
  wideShape: { bottom: 18, height: '70%', width: '77%' },
  limeShape: { position: 'absolute', width: 84, height: 66, borderRadius: 25, backgroundColor: loginColors.lime, opacity: 0.42, right: 4, bottom: 31, transform: [{ rotate: '22deg' }] },
  wideLime: { width: 118, height: 104, right: 2, bottom: 52, borderRadius: 40 },
  orbit: { position: 'absolute', width: '83%', height: '90%', bottom: 0, borderWidth: 1, borderColor: loginColors.border, borderRadius: 140, transform: [{ rotate: '-18deg' }] },
  wideOrbit: { width: '91%', height: '92%' }, goldDot: { position: 'absolute', width: 11, height: 11, borderRadius: 6, backgroundColor: loginColors.gold, left: '12%', top: '16%' },
  floatingCard: { position: 'absolute', zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 7, padding: 9, borderRadius: 13, backgroundColor: loginColors.card, borderWidth: 1, borderColor: loginColors.softBorder, shadowColor: loginColors.darkGreen, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.08, shadowRadius: 14, elevation: 3, maxWidth: '52%' },
  buddiesCard: { left: 0, bottom: 17, transform: [{ rotate: '-5deg' }] }, programsCard: { right: 0, top: 29, transform: [{ rotate: '5deg' }] },
  compactPrograms: { top: 64 }, wideBuddies: { bottom: 30 }, widePrograms: { top: 63 },
  flowingCard: { position: 'relative', top: undefined, right: undefined, left: undefined, bottom: undefined, maxWidth: '100%', alignSelf: 'center', transform: [] },
  floatingIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: loginColors.softGreen }, programIcon: { backgroundColor: '#FFF8D8' },
  floatingLabel: { fontFamily: loginFonts.semibold, color: loginColors.ink, fontSize: 10, lineHeight: 15, flexShrink: 1 },
});
