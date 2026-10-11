import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { isGradeTenStudent } from '../auth/studentAccess';
import { edumatchApi } from '../api/edumatch';
import { Badge, Button, Card, colors, Empty, errorMessage, Heading, Screen, styles } from '../components/ui';
import { availableFeatures, displayDate, featureNames, roleNames, routeFor } from './roleConfig';
import { getListPage } from './listPagination';

export function DashboardScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { width, fontScale } = useWindowDimensions();
  const account = user!;
  const role = account.role;
  const limitedAcademics = role === 'student' && !isGradeTenStudent(account);
  const singleColumn = width < 360 || fontScale > 1.25;
  const wide = width >= 1024 && !singleColumn;
  const query = useQuery({ queryKey: ['dashboard', role, account.id], queryFn: () => edumatchApi.dashboard(role, account), staleTime: 30_000 });
  const [activityPage, setActivityPage] = useState(1);
  const dashboardScroll = useRef<ScrollView>(null);
  const activityOffset = useRef(0);
  const activityPagination = getListPage(query.data?.activity || [], activityPage);
  useEffect(() => { setActivityPage(1); }, [account.id, role]);
  useEffect(() => {
    if (query.isSuccess) setActivityPage(page => getListPage(query.data.activity, page).page);
  }, [query.data?.activity, query.isSuccess]);
  function changeActivityPage(page: number) {
    setActivityPage(page);
    dashboardScroll.current?.scrollTo({ y: activityOffset.current, animated: false });
  }
  const firstName = account.name.trim().split(/\s+/)[0] || 'there';
  const tileStyle = singleColumn ? local.singleTile : wide ? local.wideTile : undefined;
  return <Screen scrollRef={dashboardScroll} title={`Hello, ${firstName}`} subtitle={`${roleNames[role]} · Your school day at a glance`}
    onRefresh={() => void query.refetch()} refreshing={query.isRefetching}
    action={<Pressable accessibilityRole="button" accessibilityLabel="Open notifications" onPress={() => router.push(routeFor(role, 'notifications'))}
      style={({ pressed }) => [local.notification, pressed && local.pressed]}><Ionicons name="notifications-outline" size={22} color={colors.darkGreen} /></Pressable>}>
    <View style={local.hero}><View style={local.heroBody}>
      <View style={local.heroHeading}><View style={local.heroIcon}><Ionicons name={role === 'student' ? 'school-outline' : 'briefcase-outline'} size={22} color={colors.darkGreen} /></View>
        <View style={local.heroCopy}><Text style={local.heroLabel}>{role === 'student' ? 'STUDENT DASHBOARD' : 'SCHOOL DASHBOARD'}</Text>
          <Text style={local.heroTitle}>{role === 'student' ? 'Your school day' : role === 'teacher' ? 'Manage your classes' : 'Your school workspace'}</Text></View>
      </View>
      <Text style={local.heroDetail}>{limitedAcademics ? 'Join your classes, check attendance, and stay informed with school updates.'
        : role === 'student' ? 'Find your classes, coursework, and feedback in one place.'
        : role === 'teacher' ? 'Keep attendance, coursework, and student feedback organized.'
        : 'Keep track of school records, requests, and academic progress.'}</Text>
    </View></View>
    {query.isPending ? <Card><View style={local.dataStatus}><ActivityIndicator color={colors.darkGreen} /><Text style={[styles.bodyMuted, local.statusCopy]}>Loading your school overview…</Text></View></Card>
      : query.error ? <Card><View style={local.dataStatus}><Ionicons name="information-circle-outline" size={22} color={colors.darkGreen} /><View style={local.statusCopy}><Text style={local.statusTitle}>School overview unavailable</Text><Text style={styles.bodyMuted}>{errorMessage(query.error)}</Text></View></View><Button title="Try again" variant="secondary" loading={query.isFetching} icon="refresh-outline" onPress={() => void query.refetch()} /></Card> : null}
    {query.data ? <>
      <Heading title="At a glance" detail="Latest figures from your school" />
      <View style={local.metricGrid}>{query.data.metrics.filter(metric => !limitedAcademics || metric.label !== 'Classes').map((metric, index) =>
        <View key={`${metric.label}-${index}`} style={[local.metric, tileStyle]}><View style={local.metricLabelRow}><View style={local.metricDot} /><Text style={local.metricLabel}>{metric.label}</Text></View><Text style={local.metricValue}>{metric.value}</Text></View>)}</View>
      <View style={local.activitySection} onLayout={event => { activityOffset.current = event.nativeEvent.layout.y; }}>
      <Heading title="Recent activity" detail="Your latest school updates" />
      {activityPagination.totalRecords ? <Card style={local.activityCard}>{activityPagination.records.map((item, index) =>
        <View key={item.id} style={[local.activityRow, index > 0 && local.activityDivider]}><View style={local.activityIcon}><Ionicons name={role === 'student' ? 'calendar-outline' : 'document-text-outline'} size={19} color={colors.darkGreen} /></View>
          <View style={local.activityCopy}><View style={local.activityHeading}><Text style={local.activityTitle}>{item.title}</Text><Badge label={item.status} /></View>{item.subtitle ? <Text style={styles.bodyMuted}>{item.subtitle}</Text> : null}{item.description ? <Text style={styles.body}>{item.description}</Text> : null}{item.createdAt ? <Text style={local.activityDate}>{displayDate(item.createdAt)}</Text> : null}</View>
        </View>)}
        <View style={local.activityPagination}>
          <View style={[styles.between, { flexWrap: 'wrap', gap: 8 }]}><Text style={styles.bodyMuted}>Showing {activityPagination.start}–{activityPagination.end} of {activityPagination.totalRecords}</Text><Text accessibilityLiveRegion="polite" style={styles.body}>Page {activityPagination.page} of {activityPagination.totalPages}</Text></View>
          <View style={styles.row}><View style={local.paginationButton}><Button title="Previous" variant="secondary" disabled={activityPagination.page <= 1} onPress={() => changeActivityPage(activityPagination.page - 1)} /></View><View style={local.paginationButton}><Button title="Next" variant="secondary" disabled={activityPagination.page >= activityPagination.totalPages} onPress={() => changeActivityPage(activityPagination.page + 1)} /></View></View>
        </View>
      </Card> : <Empty title="You're up to date" detail="Your latest school activity will appear here." />}
      </View>
    </> : null}
    <Button title="View all school tools" variant="secondary" icon="grid-outline" onPress={() => router.push(`/${role}/workspace`)} />
  </Screen>;
}

export function WorkspaceScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const role = user!.role;
  return <Screen title="Your workspace" subtitle={`${roleNames[role]} tools, organized around your school day.`}>
    {availableFeatures(user!).map(item => <Pressable key={item.feature} accessibilityRole="button" onPress={() => router.push(routeFor(role, item.feature))}>
      <Card><View style={styles.row}><View style={local.shortcutIcon}><Ionicons name={item.icon as React.ComponentProps<typeof Ionicons>['name']} color={colors.darkGreen} size={25} /></View><View style={local.shortcutCopy}><Text style={styles.heading}>{item.feature === 'approvals' && role === 'secretary' ? 'Request status' : featureNames[item.feature]}</Text><Text style={styles.bodyMuted}>{item.detail}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.darkGreen} /></View></Card>
    </Pressable>)}
  </Screen>;
}

const local = StyleSheet.create({
  notification: { width: 46, height: 46, flexShrink: 0, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }, pressed: { opacity: 0.75 },
  hero: { backgroundColor: colors.surface, borderRadius: 22, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }, heroBody: { padding: 20, gap: 12 }, heroHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroIcon: { backgroundColor: colors.pale, borderRadius: 14, width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, heroCopy: { flex: 1, minWidth: 0, gap: 4 }, heroLabel: { color: colors.darkGreen, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  heroTitle: { color: colors.ink, fontSize: 21, lineHeight: 27, fontWeight: '700' }, heroDetail: { color: colors.muted, lineHeight: 21, fontSize: 14 },
  wideTile: { width: '22%' }, singleTile: { width: '100%' },
  shortcutIcon: { width: 40, height: 40, flexShrink: 0, borderRadius: 12, backgroundColor: colors.pale, alignItems: 'center', justifyContent: 'center' }, shortcutCopy: { flex: 1, minWidth: 0, gap: 5 },
  dataStatus: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 }, statusCopy: { flex: 1, minWidth: 0, gap: 5 }, statusTitle: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, metric: { width: '45%', flexGrow: 1, minWidth: 0, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 16, gap: 10 }, metricLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, metricDot: { width: 6, height: 6, flexShrink: 0, borderRadius: 3, backgroundColor: colors.primary },
  metricLabel: { flex: 1, minWidth: 0, color: colors.muted, fontSize: 13, lineHeight: 19 }, metricValue: { fontSize: 28, lineHeight: 34, color: colors.darkGreen, fontWeight: '800' },
  activitySection: { gap: 16 }, activityPagination: { padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: colors.border }, paginationButton: { flex: 1, minWidth: 0 },
  activityCard: { padding: 0, gap: 0 }, activityRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16 }, activityDivider: { borderTopWidth: 1, borderTopColor: colors.border }, activityIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.pale, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }, activityCopy: { flex: 1, minWidth: 0, gap: 5 }, activityHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' },
  activityTitle: { flex: 1, minWidth: 80, color: colors.ink, fontSize: 14, lineHeight: 21, fontWeight: '600' }, activityDate: { color: colors.muted, fontSize: 12, lineHeight: 18 },
});
