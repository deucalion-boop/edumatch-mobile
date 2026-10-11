import React, { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { edumatchApi } from '../api/edumatch';
import type { AiUsageDays, AiUsageGeneration, AiUsageTrend } from '../api/types';
import { Badge, Button, Card, Chip, Heading, Notice, QueryStatus, Screen, colors, styles } from '../components/ui';
import { aiUsageDate, aiUsageTimestamp, buildAiUsageChart } from './aiUsagePresentation';
import { featureNames, roleNames } from './roleConfig';

function UsageChart({ trend }: { trend: AiUsageTrend[] }) {
  const buckets = buildAiUsageChart(trend);
  const maximum = Math.max(1, ...buckets.map(bucket => bucket.requests));
  return <>
    <View style={local.legend}>
      <View style={styles.row}><View style={[local.dot, { backgroundColor: colors.darkGreen }]} /><Text style={styles.bodyMuted}>Successful drafts</Text></View>
      <View style={styles.row}><View style={[local.dot, { backgroundColor: colors.danger }]} /><Text style={styles.bodyMuted}>Failed requests</Text></View>
    </View>
    <View style={local.chart}>
      {buckets.map(bucket => <View key={bucket.start} accessible
        accessibilityLabel={`${aiUsageDate(bucket.start)}${bucket.end !== bucket.start ? ` to ${aiUsageDate(bucket.end)}` : ''}: ${bucket.requests} requests, ${bucket.successfulDrafts} successful drafts, ${bucket.failedRequests} failed requests`}
        style={local.column}>
        <Text style={local.chartCount}>{bucket.requests}</Text>
        <View style={local.barTrack}>
          {bucket.requests > 0 ? <View style={[local.bar, { height: `${100 * bucket.requests / maximum}%` }]}>
            {bucket.failedRequests > 0 ? <View style={{ flex: bucket.failedRequests, backgroundColor: colors.danger }} /> : null}
            {bucket.successfulDrafts > 0 ? <View style={{ flex: bucket.successfulDrafts, backgroundColor: colors.darkGreen }} /> : null}
          </View> : null}
        </View>
        <Text style={local.chartDate}>{aiUsageDate(bucket.start)}{bucket.end !== bucket.start ? `\n${aiUsageDate(bucket.end)}` : ''}</Text>
      </View>)}
    </View>
    <Text style={styles.bodyMuted}>Dates follow the school time zone (Asia/Manila).</Text>
  </>;
}

function GenerationRow({ generation }: { generation: AiUsageGeneration }) {
  const fallback = generation.generationMode === 'provider-local-fallback';
  const outcome = !generation.succeeded ? 'Failed' : fallback ? 'Local fallback' : 'Draft generated';
  const provider = [generation.provider, generation.model].filter(Boolean).join(' / ');
  return <View style={local.generation}>
    <View style={styles.between}><Text style={[styles.body, local.creatorName]}>{generation.creatorName || 'School account'}</Text><Badge label={outcome} /></View>
    <Text style={styles.bodyMuted}>{roleNames[generation.creatorRole]}{generation.subject ? ` · ${generation.subject}` : ''}</Text>
    {provider ? <Text style={styles.body}>{provider}</Text> : null}
    {generation.generatedQuestions !== undefined && generation.succeeded ? <Text style={styles.bodyMuted}>
      {generation.generatedQuestions} questions generated{generation.requestedQuestions !== undefined ? ` / ${generation.requestedQuestions} requested` : ''}
    </Text> : null}
    <Text style={styles.bodyMuted}>{aiUsageTimestamp(generation.createdAt)}{generation.durationMs > 0 ? ` · ${(generation.durationMs / 1000).toFixed(1)}s` : ''}</Text>
  </View>;
}

export function AiUsageScreen() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<{ days: AiUsageDays; page: number }>({ days: 30, page: 1 });
  const scrollRef = useRef<ScrollView>(null);
  const historyOffset = useRef(0);
  const query = useQuery({
    queryKey: ['ai-usage', user?.id, filter.days, filter.page],
    queryFn: () => edumatchApi.aiUsage(user!.role, { ...filter, pageSize: 5 }),
    enabled: user?.role === 'admin',
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) => previousQuery && previousQuery.queryKey[1] === user?.id && previousQuery.queryKey[2] === filter.days ? previousData : undefined,
  });
  const data = query.data;
  const pagination = data?.pagination;
  const changePage = (page: number) => {
    setFilter(current => ({ ...current, page }));
    scrollRef.current?.scrollTo({ y: historyOffset.current, animated: true });
  };
  return <Screen title={featureNames['ai-usage']} subtitle="Monitor AI requests made while creating assessments."
    scrollRef={scrollRef} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <View style={styles.chipRow}>{([7, 30, 90] as const).map(days => <Chip key={days} label={`Last ${days} days`}
      active={filter.days === days} onPress={() => { setFilter({ days, page: 1 }); scrollRef.current?.scrollTo({ y: 0, animated: true }); }} />)}</View>
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {data && !query.error ? <>
      <Card>
        <Heading title="Generation overview" detail="Each request creates an assessment draft. Successful drafts can be reviewed and edited before publishing." />
        <Text style={styles.bodyMuted}>{aiUsageDate(data.period.start)} – {aiUsageDate(data.period.end)}</Text>
        <View style={local.metricGrid}>{[
          { label: 'Generation requests', value: data.summary.requests },
          { label: 'Successful drafts', value: data.summary.successfulDrafts },
          { label: 'Failed requests', value: data.summary.failedRequests },
          { label: 'Active creators', value: data.summary.activeCreators },
        ].map(metric => <View key={metric.label} style={local.metric}>
          <Text style={local.metricValue}>{metric.value.toLocaleString()}</Text><Text style={styles.bodyMuted}>{metric.label}</Text>
        </View>)}</View>
        {data.summary.localFallbacks > 0 ? <Notice message={`${data.summary.localFallbacks} successful drafts used local fallback questions after the AI returned an unusable draft.`} /> : null}
      </Card>
      <Card><Heading title="Usage over time" detail={data.summary.requests ? 'Generation requests in the selected period.' : 'No AI generation requests in this period.'} /><UsageChart trend={data.trend} /></Card>
      <Card><Heading title="Most active creators" detail="Teachers and head teachers with the most generation requests." />
        {data.creators.length ? data.creators.slice(0, 5).map(creator => <View key={creator.id} style={local.creator}>
          <View style={styles.between}><Text style={[styles.body, local.creatorName]}>{creator.name || 'School account'}</Text><Text style={local.requestCount}>{creator.requests.toLocaleString()}</Text></View>
          <Text style={styles.bodyMuted}>{roleNames[creator.role]}{creator.department ? ` · ${creator.department}` : ''}</Text>
          <Text style={styles.bodyMuted}>{creator.successfulDrafts} successful drafts · {creator.failedRequests} failed requests</Text>
          <View style={local.creatorTrack}><View style={[local.creatorBar, { width: `${100 * creator.requests / Math.max(1, data.creators[0]!.requests)}%` }]} /></View>
        </View>) : <Text style={styles.bodyMuted}>Creators will appear after they request an AI assessment draft.</Text>}
      </Card>
      <View onLayout={event => { historyOffset.current = event.nativeEvent.layout.y; }}>
        <Card><Heading title="Recent generations" detail="Requests and their outcomes for the selected period." />
          {query.isPlaceholderData ? <Text accessibilityLiveRegion="polite" style={styles.bodyMuted}>Updating history…</Text> : null}
          {data.recent.length ? data.recent.map(generation => <GenerationRow key={generation.id} generation={generation} />)
            : <Text style={styles.bodyMuted}>No generation requests in this period. Choose a longer period to see earlier activity.</Text>}
          {pagination && pagination.totalRecords > 0 ? <>
            <Text style={styles.bodyMuted}>Showing {(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.totalRecords)} of {pagination.totalRecords} · Page {pagination.page} of {pagination.totalPages}</Text>
            <View style={local.pagination}>
              <View style={local.paginationButton}><Button title="Previous" icon="chevron-back-outline" variant="secondary" disabled={pagination.page <= 1 || query.isFetching} onPress={() => changePage(pagination.page - 1)} /></View>
              <View style={local.paginationButton}><Button title="Next" icon="chevron-forward-outline" variant="secondary" disabled={pagination.page >= pagination.totalPages || query.isFetching} onPress={() => changePage(pagination.page + 1)} /></View>
            </View>
          </> : null}
        </Card>
      </View>
    </> : null}
  </Screen>;
}

const local = StyleSheet.create({
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metric: { flexBasis: '45%', flexGrow: 1, minWidth: 0, backgroundColor: colors.pale, borderRadius: 14, padding: 14, gap: 4 },
  metricValue: { color: colors.darkGreen, fontWeight: '800', fontSize: 28 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  dot: { height: 8, width: 8, borderRadius: 4 },
  chart: { flexDirection: 'row', gap: 7, paddingTop: 10 },
  column: { flex: 1, minWidth: 0, gap: 7, alignItems: 'center' },
  chartCount: { color: colors.ink, fontWeight: '700', fontSize: 12 },
  barTrack: { height: 100, width: '100%', maxWidth: 36, backgroundColor: colors.pale, borderRadius: 5, justifyContent: 'flex-end', overflow: 'hidden' },
  bar: { width: '100%' },
  chartDate: { color: colors.muted, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  creator: { gap: 5, paddingVertical: 8 },
  creatorName: { flex: 1, fontWeight: '700' },
  requestCount: { fontWeight: '800', color: colors.darkGreen, fontSize: 18 },
  creatorTrack: { height: 5, borderRadius: 3, backgroundColor: colors.pale, overflow: 'hidden' },
  creatorBar: { height: '100%', backgroundColor: colors.primary },
  generation: { gap: 5, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  pagination: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  paginationButton: { flex: 1, minWidth: 120 },
});
