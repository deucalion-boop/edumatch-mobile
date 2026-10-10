import axios from 'axios';
import { API_URL, configurationError } from '../config';

let token: string | null = null;
let sessionExpired: (() => void) | undefined;
export const api = axios.create({ baseURL: API_URL, timeout: 20000, headers: { Accept: 'application/json' } });
export function setAccessToken(next: string | null) { token = next; }
export function onSessionExpired(callback?: () => void) { sessionExpired = callback; }
api.interceptors.request.use((config) => {
  if (configurationError) throw new Error(configurationError);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use((response) => response, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401 && error.config?.headers.Authorization && error.config.url !== '/auth/change-password') {
    sessionExpired?.();
  }
  return Promise.reject(error);
});
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const serverMessage = error.response?.data?.message;
    if (typeof serverMessage === 'string') return serverMessage;
    if (!error.response) return 'Unable to reach EduMatch. Check your connection and try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
