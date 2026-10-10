import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { API_URL } from '../config';
import { Button, colors, Notice } from '../components/ui';

export function Captcha({ visible, onToken, onClose }: { visible: boolean; onToken: (token: string) => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const visibleRef = useRef(visible);
  const acceptedRef = useRef(false);
  const onTokenRef = useRef(onToken);
  visibleRef.current = visible;
  onTokenRef.current = onToken;
  useEffect(() => {
    acceptedRef.current = false;
    setError(null);
  }, [visible]);
  const close = () => { visibleRef.current = false; acceptedRef.current = true; onClose(); };
  return <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
    <View style={styles.container}>
      <Text style={styles.title}>Verify your sign-in</Text>
      <Text style={styles.help}>Complete the security check to continue.</Text>
      {error && <Notice message={error} tone="error" />}
      {Platform.OS === 'web' ? <Notice message="CAPTCHA sign-in uses the native app. Use an Android or iOS development build for the complete sign-in workflow." /> :
        <WebView source={{ uri: `${API_URL}/mobile/captcha` }} style={styles.webview}
          originWhitelist={[new URL(API_URL).origin, 'https://www.google.com', 'https://www.gstatic.com', 'https://www.recaptcha.net']}
          onError={() => { if (visibleRef.current && !acceptedRef.current) setError('The security check could not load. Check your connection and try again.'); }}
          onHttpError={() => { if (visibleRef.current && !acceptedRef.current) setError('The CAPTCHA service is not configured. Contact your administrator.'); }}
          onMessage={(event) => {
            if (!visibleRef.current || acceptedRef.current) return;
            try {
              const message: unknown = JSON.parse(event.nativeEvent.data);
              if (!message || typeof message !== 'object') return;
              const payload = message as Record<string, unknown>;
              if (payload.type === 'captcha' && typeof payload.token === 'string' && payload.token.length > 10 && payload.token.length < 10000) {
                acceptedRef.current = true; setError(null); onTokenRef.current(payload.token); return;
              }
              if (payload.type === 'error' || payload.type === 'expired') setError('The security check expired. Please try again.');
            } catch { if (visibleRef.current && !acceptedRef.current) setError('The security check failed. Please try again.'); }
          }} />}
      <Button title="Cancel" variant="secondary" onPress={close} />
    </View>
  </Modal>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: colors.background, padding: 24, paddingTop: 54, gap: 14 }, title: { fontSize: 24, fontWeight: '700', color: colors.ink }, help: { color: colors.muted, fontSize: 15 }, webview: { flex: 1, backgroundColor: 'transparent' } });
