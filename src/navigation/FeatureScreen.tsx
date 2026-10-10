import { Redirect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import { FEATURES } from '../auth/roles';
import { AcademicScreen, ApprovalsScreen, GradesScreen, NotificationsScreen } from '../screens/ResourceScreens';
import { AttendanceScreen } from '../screens/AttendanceScreen';
import { SubjectsScreen, LessonsScreen } from '../screens/LearningScreens';

export function FeatureScreen() {
  const { user } = useAuth();
  const { feature } = useLocalSearchParams<{ feature: string }>();
  if (!user || !FEATURES[user.role].includes(feature)) return <Redirect href={user ? `/${user.role}/workspace` : '/login'} />;
  switch (feature) {
    case 'approvals': return <ApprovalsScreen />;
    case 'academic': return <AcademicScreen />;
    case 'grades': return <GradesScreen />;
    case 'attendance': return <AttendanceScreen />;
    case 'subjects': return <SubjectsScreen />;
    case 'lessons': return <LessonsScreen />;
    case 'notifications': return <NotificationsScreen />;
    default: return <Redirect href={`/${user.role}/workspace`} />;
  }
}
