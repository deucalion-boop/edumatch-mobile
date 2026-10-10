import React, { PropsWithChildren } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TextInputProps, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinePatternBackground } from './LinePatternBackground';

export const colors = {
  background: '#F8FAFC', surface: '#FFFFFF', ink: '#18261D', muted: '#64716A',
  primary: '#69AA47', darkGreen: '#3F7F2A', pale: '#EFF7E9', border: '#DCE6D7',
  gradientStart: '#1E4307', gold: '#FFD542', lime: '#BBFF59',
  danger: '#B52B33', dangerPale: '#FDECEE', amber: '#936007', amberPale: '#FFF2D9',
};

export function confirmAction(title: string, message: string, confirmLabel: string, action: () => void, destructive = false) {
  const browserConfirm = (globalThis as unknown as { confirm?: (text: string) => boolean }).confirm;
  if (Platform.OS === 'web' && browserConfirm) {
    if (browserConfirm(`${title}\n\n${message}`)) action();
    return;
  }
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: action }]);
}

export function Screen({ title, subtitle, children, refreshing = false, onRefresh, action, scrollRef }: PropsWithChildren<{
  title: string; subtitle?: string; refreshing?: boolean; onRefresh?: () => void; action?: React.ReactNode; scrollRef?: React.Ref<ScrollView>;
}>) {
  const { width } = useWindowDimensions();
  return <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
    <LinePatternBackground />
    <ScrollView ref={scrollRef} style={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.page, { paddingHorizontal: width < 360 ? 16 : 20 }]}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.darkGreen} /> : undefined}>
      <View style={styles.brand}><View style={styles.brandMark}><Ionicons name="school" size={19} color={colors.darkGreen} /></View><Text style={styles.brandText}>EduMatch</Text></View>
      <View style={styles.pageHeading}><View style={styles.headingContent}><Text accessibilityRole="header" style={styles.title}>{title}</Text>{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}</View>{action}</View>
      {children}
    </ScrollView>
  </SafeAreaView>;
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return <View style={styles.headingRow}><View style={styles.headingContent}><Text accessibilityRole="header" style={styles.heading}>{title}</Text>{detail ? <Text style={styles.bodyMuted}>{detail}</Text> : null}</View>{action}</View>;
}

export function Button({ title, onPress, loading = false, disabled = false, variant = 'primary', icon }: {
  title: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' | 'plain';
  icon?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  const quiet = variant === 'secondary' || variant === 'plain';
  const color = variant === 'danger' ? colors.danger : quiet ? colors.darkGreen : '#FFFFFF';
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || loading, busy: loading }}
    disabled={disabled || loading} onPress={onPress}
    style={({ pressed }) => [styles.button, variant === 'secondary' && styles.secondaryButton, variant === 'plain' && styles.plainButton,
      variant === 'danger' && styles.dangerButton, (disabled || loading) && { opacity: 0.55 }, pressed && { opacity: 0.8 }]}>
    {loading ? <ActivityIndicator color={color} size="small" /> : icon ? <Ionicons name={icon} size={19} color={color} /> : null}
    <Text style={[styles.buttonText, { color }]}>{title}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput accessibilityLabel={label}
    placeholderTextColor="#87988E" {...props} style={[styles.input, props.multiline && { minHeight: 104, textAlignVertical: 'top' }, props.style]} /></View>;
}

export function Chip({ label, active = false, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress}
    style={[styles.chip, active && styles.activeChip]}><Text style={[styles.chipText, active && { color: '#FFFFFF' }]}>{label}</Text></Pressable>;
}

export function Badge({ label }: { label?: string | null }) {
  if (!label) return null;
  const normalized = label.toLowerCase();
  const negative = /reject|absent|fail|inactive/.test(normalized);
  const pending = /pending|late|draft|revision/.test(normalized);
  return <View style={[styles.badge, negative && { backgroundColor: colors.dangerPale }, pending && { backgroundColor: colors.amberPale }]}>
    <Text style={[styles.badgeText, negative && { color: colors.danger }, pending && { color: colors.amber }]}>{label.replace(/_/g, ' ')}</Text>
  </View>;
}

export function Notice({ message, tone = 'info' }: { message: string; tone?: 'info' | 'success' | 'error' }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, tone === 'error' && { backgroundColor: colors.dangerPale }]}>
    <Ionicons name={tone === 'error' ? 'alert-circle-outline' : tone === 'success' ? 'checkmark-circle-outline' : 'information-circle-outline'}
      size={20} color={tone === 'error' ? colors.danger : colors.darkGreen} /><Text style={[styles.noticeText, tone === 'error' && { color: colors.danger }]}>{message}</Text>
  </View>;
}

export function Empty({ title = 'Nothing here yet', detail }: { title?: string; detail: string }) {
  return <Card><View style={styles.empty}><Ionicons name="file-tray-outline" size={32} color={colors.muted} /><Text style={styles.heading}>{title}</Text><Text style={[styles.bodyMuted, { textAlign: 'center' }]}>{detail}</Text></View></Card>;
}

export function QueryStatus({ loading, error, retry }: { loading: boolean; error: unknown; retry: () => void }) {
  if (loading) return <Card><View style={styles.empty}><ActivityIndicator size="large" color={colors.darkGreen} /><Text style={styles.bodyMuted}>Loading your school data…</Text></View></Card>;
  if (error) return <Card><Notice tone="error" message={errorMessage(error)} /><Button title="Try again" onPress={retry} variant="secondary" icon="refresh-outline" /></Card>;
  return null;
}

export function errorMessage(error: unknown): string {
  const value = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
  const message = value?.response?.data?.message || value?.response?.data?.error || value?.message;
  if (message === 'Network Error' || /network request failed|timeout/i.test(message || '')) return 'Unable to reach EduMatch. Check your connection and try again.';
  if (/invalid input syntax for type|syntax error at or near|violates (?:not-null|foreign key|unique|check) constraint|(?:relation|column) .+ does not exist|permission denied for (?:table|schema|relation|sequence)|operator does not exist|cannot cast type|malformed (?:array|record) literal/i.test(message || '')) {
    return 'We couldn’t load your school data. Please try again.';
  }
  return message || 'We could not complete this request. Please try again.';
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background }, scroll: { flex: 1 },
  page: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingVertical: 20, paddingBottom: 36, gap: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 }, brandMark: { padding: 7, borderRadius: 11, backgroundColor: colors.pale },
  brandText: { fontWeight: '800', color: colors.darkGreen, letterSpacing: -0.3, fontSize: 17 },
  pageHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 }, headingContent: { flex: 1, minWidth: 0 },
  title: { fontSize: 26, lineHeight: 33, fontWeight: '800', color: colors.ink, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, lineHeight: 21, color: colors.muted, marginTop: 5 }, card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: 18, gap: 12 },
  headingRow: { flexDirection: 'row', gap: 10, alignItems: 'center' }, heading: { fontSize: 17, color: colors.ink, fontWeight: '700', lineHeight: 24 },
  body: { color: colors.ink, fontSize: 14, lineHeight: 22 }, bodyMuted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  button: { minHeight: 48, borderRadius: 13, paddingHorizontal: 17, paddingVertical: 12, backgroundColor: colors.darkGreen, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryButton: { backgroundColor: colors.pale }, plainButton: { backgroundColor: 'transparent', paddingHorizontal: 8 }, dangerButton: { backgroundColor: colors.dangerPale },
  buttonText: { fontSize: 14, fontWeight: '700', textAlign: 'center' }, field: { gap: 7 }, fieldLabel: { fontSize: 13, color: colors.ink, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 13, backgroundColor: '#FAFCF9', paddingHorizontal: 13, paddingVertical: 12, color: colors.ink, fontSize: 16 },
  chip: { minHeight: 44, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.pale, alignItems: 'center', justifyContent: 'center' },
  activeChip: { backgroundColor: colors.darkGreen }, chipText: { color: colors.darkGreen, fontSize: 13, fontWeight: '600' }, chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: { backgroundColor: colors.pale, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, alignSelf: 'flex-start', maxWidth: '100%' }, badgeText: { fontSize: 11, color: colors.darkGreen, fontWeight: '700', textTransform: 'capitalize' },
  notice: { backgroundColor: colors.pale, borderRadius: 13, padding: 13, flexDirection: 'row', alignItems: 'flex-start', gap: 9 }, noticeText: { color: colors.darkGreen, fontSize: 13, lineHeight: 20, flex: 1 },
  empty: { paddingVertical: 20, alignItems: 'center', gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  divider: { height: 1, backgroundColor: colors.border }, smallLabel: { fontSize: 11, color: colors.muted, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
});
