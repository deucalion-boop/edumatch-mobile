import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { captchaApi } from '../api/edumatch';
import { errorMessage } from '../api/client';
import type { CaptchaAction, CaptchaChallenge } from '../api/types';
import { Button, colors, Field, Notice } from '../components/ui';

type CaptchaProps = {
  visible: boolean;
  action?: CaptchaAction;
  onToken: (token: string) => void;
  onClose: () => void;
};

/** Shared native/web UI. Only the server checks the answer and issues a proof. */
export function Captcha({ visible, action = 'login', onToken, onClose }: CaptchaProps) {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const active = useRef(visible);
  const accepted = useRef(false);
  const verificationInFlight = useRef(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const tokenCallback = useRef(onToken);
  active.current = visible;
  tokenCallback.current = onToken;

  const loadChallenge = async (message: string | null = null) => {
    if (!active.current || accepted.current) return;
    const attempt = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    verificationInFlight.current = false;
    setChallenge(null); setAnswer(''); setError(message); setLoading(true); setVerifying(false);
    try {
      const next = await captchaApi.challenge(action, nextController.signal);
      if (!active.current || accepted.current || attempt !== request.current) return;
      setSeconds(Math.max(0, Math.ceil((Date.parse(next.expiresAt) - Date.now()) / 1000)));
      setChallenge(next);
    } catch (caught) {
      if (active.current && !accepted.current && attempt === request.current) {
        setError(message ? `${message} ${errorMessage(caught)}` : errorMessage(caught));
      }
    } finally {
      if (active.current && attempt === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    active.current = visible;
    accepted.current = false;
    if (visible) void loadChallenge();
    return () => { active.current = false; request.current += 1; controller.current?.abort(); };
  }, [visible, action]);

  useEffect(() => {
    if (!visible || !challenge) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - Date.now()) / 1000));
      setSeconds(remaining);
      if (!remaining && !accepted.current) {
        request.current += 1; controller.current?.abort();
        verificationInFlight.current = false;
        setChallenge(null); setAnswer(''); setVerifying(false);
        setError('The security question expired. Refresh the question and try again.');
      }
    };
    update();
    const timer = setInterval(update, 1000);
    const appState = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { clearInterval(timer); appState.remove(); };
  }, [visible, challenge]);

  const close = () => {
    active.current = false; accepted.current = true; request.current += 1;
    controller.current?.abort(); onClose();
  };

  const verify = async () => {
    if (!active.current || accepted.current || loading || verificationInFlight.current || !challenge) return;
    if (!/^-?\d{1,4}$/.test(answer.trim())) {
      setError('Enter a whole-number answer to the question.'); return;
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      void loadChallenge('The security question expired. Answer the new question.'); return;
    }
    const attempt = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    verificationInFlight.current = true;
    setVerifying(true); setError(null);
    try {
      const result = await captchaApi.verify(challenge.challengeId, answer.trim(), action, nextController.signal);
      if (!active.current || accepted.current || attempt !== request.current) return;
      accepted.current = true;
      verificationInFlight.current = false;
      setVerifying(false);
      tokenCallback.current(result.verificationToken);
    } catch (caught) {
      if (active.current && !accepted.current && attempt === request.current) {
        // Incorrect answers and uncertain network results discard the one-use
        // challenge. A retry always receives a new question from the server.
        void loadChallenge(`${errorMessage(caught)} Answer the new question to try again.`);
      }
    }
  };

  return <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>Math security check</Text>
          <Text style={styles.help}>Answer the addition or subtraction question to continue.</Text>
          {error && <Notice message={error} tone="error" />}
          {loading ? <View style={styles.loading}><ActivityIndicator color={colors.darkGreen} /><Text accessibilityLiveRegion="polite" style={styles.help}>Loading a new question...</Text></View> : null}
          {challenge && <>
            <View style={styles.question}><Text accessibilityLiveRegion="polite" style={styles.questionText}>{challenge.question}</Text></View>
            <Field label="Your answer" value={answer} onChangeText={setAnswer} placeholder="Enter the answer" keyboardType="number-pad"
              autoCapitalize="none" autoCorrect={false} autoComplete="off" maxLength={5} editable={!verifying}
              returnKeyType="done" onSubmitEditing={() => void verify()} />
            <Text style={styles.help}>Question expires in {Math.ceil(seconds / 60)} minute{Math.ceil(seconds / 60) === 1 ? '' : 's'}.</Text>
            <Button title="Verify and continue" loading={verifying} disabled={!answer.trim() || seconds === 0} onPress={() => void verify()} />
          </>}
          <Button title={challenge ? 'Refresh question' : 'Try a new question'} icon="refresh-outline" variant="secondary"
            disabled={loading || verifying} onPress={() => void loadChallenge()} />
          <Button title="Cancel" variant="plain" onPress={close} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.35)' },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 480, borderRadius: 24, backgroundColor: colors.surface, padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
  help: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  loading: { alignItems: 'center', paddingVertical: 24, gap: 12 },
  question: { padding: 20, backgroundColor: colors.pale, borderRadius: 14, alignItems: 'center' },
  questionText: { fontSize: 32, fontWeight: '700', color: colors.darkGreen },
});
