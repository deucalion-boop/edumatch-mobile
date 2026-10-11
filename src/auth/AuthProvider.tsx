import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { authApi } from '../api/edumatch';
import type { AuthSession, User } from '../api/types';
import { errorMessage, onSessionExpired, setAccessToken } from '../api/client';
import { clearSession, loadSession, saveSession } from './storage';
import { normalizeRole } from './roles';
import { queryClient } from '../query/QueryProvider';
import { unregisterDevice } from '../notifications/push';

type AuthContextValue = {
  user: User | null; loading: boolean; bootstrapError: string | null;
  acceptSession: (result: AuthSession, persistSession?: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
  refreshProfile: () => Promise<User>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const authEpoch = useRef(0);
  const sessionWrites = useRef<Promise<void>>(Promise.resolve());
  // Serialize keychain changes so a delayed restore cannot overwrite a new sign-in.
  const writeSession = useCallback((operation: () => Promise<void>) => {
    const pending = sessionWrites.current.then(operation, operation);
    sessionWrites.current = pending.catch(() => {});
    return pending;
  }, []);
  const clear = useCallback(async () => {
    const epoch = ++authEpoch.current;
    setAccessToken(null); setUser(null); setBootstrapError(null); setLoading(false);
    await queryClient.cancelQueries();
    if (epoch !== authEpoch.current) return;
    queryClient.clear();
    await writeSession(async () => { if (epoch === authEpoch.current) await clearSession(); });
  }, [writeSession]);
  const retryBootstrap = useCallback(async () => {
    const epoch = ++authEpoch.current;
    setLoading(true); setBootstrapError(null);
    try {
      await sessionWrites.current;
      const saved = await loadSession();
      if (epoch !== authEpoch.current) return;
      if (!saved) { setUser(null); return; }
      setAccessToken(saved.token);
      const snapshot = { ...saved.user, role: normalizeRole(saved.user.role) };
      if (snapshot.forcePasswordChange) { setUser(snapshot); return; }
      const refreshed = await authApi.me();
      if (epoch !== authEpoch.current) return;
      const normalized = { ...refreshed, role: normalizeRole(refreshed.role) };
      await writeSession(async () => { if (epoch === authEpoch.current) await saveSession(saved.token, normalized); });
      if (epoch === authEpoch.current) setUser(normalized);
    } catch (error) { if (epoch === authEpoch.current) setBootstrapError(errorMessage(error)); }
    finally { if (epoch === authEpoch.current) setLoading(false); }
  }, [writeSession]);
  useEffect(() => {
    onSessionExpired(() => { void clear(); });
    void retryBootstrap();
    return () => onSessionExpired(undefined);
  }, [clear, retryBootstrap]);
  const acceptSession = useCallback(async (result: AuthSession, persistSession = true) => {
    const epoch = ++authEpoch.current;
    const normalized = { ...result.user, role: normalizeRole(result.user.role) };
    await queryClient.cancelQueries();
    if (epoch !== authEpoch.current) return;
    queryClient.clear();
    await writeSession(async () => {
      if (epoch !== authEpoch.current) return;
      if (persistSession) await saveSession(result.token, normalized);
      else await clearSession();
    });
    if (epoch !== authEpoch.current) return;
    setAccessToken(result.token); setBootstrapError(null); setUser(normalized); setLoading(false);
  }, [writeSession]);
  const signOut = useCallback(async () => {
    const epoch = authEpoch.current;
    // Best effort server cleanup; device delivery also checks the active JWT session.
    try { await unregisterDevice(); } catch { /* Logout must remain possible offline. */ }
    if (epoch !== authEpoch.current) return;
    try { await authApi.logout(); } catch { /* Cached private data is cleared locally. */ }
    if (epoch !== authEpoch.current) return;
    await clear();
  }, [clear]);
  const refreshProfile = useCallback(async () => {
    if (!user) throw new Error('Sign in to update your profile.');
    const epoch = authEpoch.current;
    const refreshed = await authApi.me();
    if (epoch !== authEpoch.current || refreshed.id !== user.id || refreshed.role !== user.role) {
      throw new Error('Your account changed while refreshing the profile.');
    }
    setUser(refreshed);
    return refreshed;
  }, [user]);
  return <AuthContext.Provider value={{ user, loading, bootstrapError, acceptSession, signOut, retryBootstrap, refreshProfile }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
