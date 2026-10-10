import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { API_URL } from '../config';
import { Button, colors, Notice } from '../components/ui';

export function Captcha({ visible, onToken, onClose }: { visible: boolean; onToken: (token: string) => void; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [serviceReady, setServiceReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const visibleRef = useRef(visible);
  const acceptedRef = useRef(false);
  const onTokenRef = useRef(onToken);
  visibleRef.current = visible;
  onTokenRef.current = onToken;
  useEffect(() => {
    acceptedRef.current = false;
    setError(null); setServiceReady(false); setLoading(true);
    if (!visible) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 10000);
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/mobile/captcha`, {
          signal: controller.signal, headers: { Accept: 'text/html' }, cache: 'no-store',
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error('The security check is unavailable. Please try again or contact your school.');
        }
        if (!cancelled) setServiceReady(true);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error && caught.message.startsWith('The security check is unavailable')
            ? caught.message : 'The security check could not load. Check your connection and try again.');
          setLoading(false);
        }
      } finally { clearTimeout(timeout); }
    })();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [visible, retry]);
  useEffect(() => {
    if (!visible) return;
    const receive = (event: MessageEvent) => {
      if (!visibleRef.current || acceptedRef.current) return;
      if (event.origin !== new URL(API_URL).origin || event.source !== frame.current?.contentWindow) return;
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) as Record<string, unknown> : event.data;
        if (payload?.type === 'captcha' && typeof payload.token === 'string' && payload.token.length > 10 && payload.token.length < 10000) {
          acceptedRef.current = true; setError(null); onTokenRef.current(payload.token); return;
        }
        if (payload?.type === 'expired') setError('The security check expired. Please try again.');
        if (payload?.type === 'error') setError('The security check is unavailable. Retry, or contact your school if it keeps failing.');
      } catch { if (visibleRef.current && !acceptedRef.current) setError('The security check failed. Please try again.'); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [visible]);
  const close = () => { visibleRef.current = false; acceptedRef.current = true; onClose(); };
  const panelWidth = Math.min(480, Math.max(0, width - 32));
  const frameScale = Math.min(1, panelWidth / 344);
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
    <View style={styles.backdrop}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>Verify your sign-in</Text>
            <Text style={styles.help}>Complete the security check to continue.</Text>
            {error && <Notice message={error} tone="error" />}
          </View>
          {(loading || serviceReady) && <View style={[styles.frame, { height: 600 * frameScale }]}>
            {serviceReady && <iframe key={retry} ref={frame} title="EduMatch security check" src={`${API_URL}/mobile/captcha`}
              onLoad={() => setLoading(false)}
              onError={() => { setLoading(false); setError('The security check could not load. Check your connection and try again.'); }}
              style={{ border: 0, width: Math.max(344, panelWidth), height: 600, backgroundColor: 'transparent', transform: `scale(${frameScale})`, transformOrigin: 'top left' }} />}
            {loading && <View pointerEvents="none" style={styles.loading}>
              <ActivityIndicator color={colors.primary} />
              <Text accessibilityLiveRegion="polite" style={styles.help}>Loading security check…</Text>
            </View>}
          </View>}
          <View style={styles.actions}>
            {error && <Button title="Retry security check" onPress={() => { setServiceReady(false); setLoading(true); setError(null); setRetry(value => value + 1); }} />}
            <Button title="Cancel" variant="secondary" onPress={close} />
          </View>
        </View>
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)' },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 480, overflow: 'hidden', borderRadius: 24, backgroundColor: '#FFFFFF' },
  header: { padding: 24, paddingBottom: 0, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
  help: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  frame: { overflow: 'hidden', width: '100%', backgroundColor: colors.background },
  loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: 12 },
  actions: { padding: 24, gap: 12 },
});
