import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { User } from '../api/types';

const TOKEN_KEY = 'edumatch.access-token';
const USER_KEY = 'edumatch.user';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const memory = new Map<string, string>();
export async function readSecure(key: string) {
  return Platform.OS === 'web' ? memory.get(key) || null : SecureStore.getItemAsync(key);
}
export async function writeSecure(key: string, value: string) {
  if (Platform.OS === 'web') { memory.set(key, value); return; }
  await SecureStore.setItemAsync(key, value, options);
}
export async function deleteSecure(key: string) {
  if (Platform.OS === 'web') { memory.delete(key); return; }
  await SecureStore.deleteItemAsync(key);
}
export async function saveSession(token: string, user: User) {
  // Keep the keychain snapshot small; the profile is refreshed from the server.
  const snapshot = { id: user.id, name: user.name, role: user.role, forcePasswordChange: user.forcePasswordChange };
  try {
    await writeSecure(USER_KEY, JSON.stringify(snapshot));
    await writeSecure(TOKEN_KEY, token);
  } catch (error) { await clearSession(); throw error; }
}
export async function loadSession(): Promise<{ token: string; user: User } | null> {
  const [token, rawUser] = await Promise.all([readSecure(TOKEN_KEY), readSecure(USER_KEY)]);
  if (!token || !rawUser) return null;
  try { return { token, user: JSON.parse(rawUser) as User }; } catch { await clearSession(); return null; }
}
export async function clearSession() { await Promise.all([deleteSecure(TOKEN_KEY), deleteSecure(USER_KEY)]); }
