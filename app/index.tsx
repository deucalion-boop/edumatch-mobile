import { Redirect } from 'expo-router';
import { useAuth } from '../src/auth/AuthProvider';
export default function Index() {
  const { user } = useAuth();
  return <Redirect href={user ? user.forcePasswordChange ? '/password' : `/${user.role}` : '/login'} />;
}
