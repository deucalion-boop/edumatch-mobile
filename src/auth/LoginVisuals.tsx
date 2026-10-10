import { Image, StyleSheet, Text, View } from 'react-native';
import { LinePatternBackground } from '../components/LinePatternBackground';

export const loginColors = {
  background: '#F8FAFC', card: '#FFFFFF', darkGreen: '#1E4307', green: '#69AA47', deepGreen: '#3F7F2A',
  gold: '#FFD542', lime: '#BBFF59', ink: '#18261D', muted: '#64716A', border: '#DCE6D7',
  softBorder: '#E7EDE5', softGreen: '#EFF7E9',
};

export function LoginPattern() {
  return <LinePatternBackground />;
}

export function LoginBranding() {
  return <View style={styles.compactBrand}>
    <Image source={require('../../assets/edumatch-school-logo.png')} style={styles.compactSeal} accessibilityLabel="San Josef National High School seal" />
    <View style={styles.brandCopy}><Text style={styles.compactName}>EduMatch</Text><Text style={styles.compactTitle}>San Josef National High School</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  compactBrand: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 12, width: '100%', maxWidth: 440 },
  compactSeal: { width: 44, height: 44, flexShrink: 0, resizeMode: 'contain' },
  brandCopy: { flex: 1, minWidth: 0, flexShrink: 1 },
  compactName: { fontSize: 22, lineHeight: 28, fontWeight: '800', letterSpacing: -0.5, color: loginColors.darkGreen },
  compactTitle: { color: loginColors.muted, fontSize: 12, lineHeight: 17, marginTop: 2, flexShrink: 1 },
});
