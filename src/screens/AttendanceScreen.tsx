import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { useFocusEffect } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceSessions, edumatchApi } from '../api/edumatch';
import type { AttendanceRecord, AttendanceScope, AttendanceSessionQr, AttendanceStatus } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Button, Card, Chip, colors, confirmAction, Empty, errorMessage, Field, Heading, Notice, QueryStatus, Screen, styles } from '../components/ui';
import { displayDate, rawText } from './roleConfig';

const statuses: AttendanceStatus[] = ['Present', 'Late', 'Absent', 'Excused'];
function useScreenFocus() {
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  return focused;
}
function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function AttendanceScreen() {
  const { user } = useAuth();
  const role = user!.role;
  return role === 'teacher' ? <TeacherAttendance /> : role === 'student' ? <StudentAttendance /> : <AttendanceHistory />;
}

function AttendanceRecordCard({ record }: { record: AttendanceRecord }) {
  const summary = record.summary || {};
  return <Card><View style={styles.between}><Text style={[styles.heading, { flex: 1 }]}>{record.title || rawText(record.subject || {}, ['name', 'subject']) || rawText(record.section || {}, ['name']) || 'Attendance record'}</Text><Badge label={record.status || (record.isLocked ? 'Finalized' : 'Open')} /></View>
    <Text style={styles.bodyMuted}>{record.dateKey}{record.attendanceScope === 'advisory_class' ? ' · Advisory class' : ''}</Text>
    {rawText(record.teacher || {}, ['name']) ? <Text style={styles.bodyMuted}>Teacher: {rawText(record.teacher || {}, ['name'])}</Text> : null}
    <View style={styles.chipRow}>{statuses.map(status => {
      const count = rawText(summary, [status.toLowerCase(), `${status.toLowerCase()}Count`]);
      return count ? <Badge key={status} label={`${status}: ${count}`} /> : null;
    })}</View>
    {record.entries?.length ? <Text style={styles.bodyMuted}>{record.entries.length} student records</Text> : null}
  </Card>;
}

function AttendanceHistory() {
  const { user } = useAuth();
  const role = user!.role;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const query = useQuery({ queryKey: ['attendance', role, range], queryFn: () => edumatchApi.attendance(role, range), staleTime: 20_000 });
  return <Screen title="Attendance records" subtitle="Review the school's attendance records for your authorized scope." refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <Card><Heading title="Filter dates" /><Field label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} placeholder="2026-10-01" autoCapitalize="none" /><Field label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} placeholder="2026-10-31" autoCapitalize="none" />
      <Button title="Apply dates" variant="secondary" onPress={() => setRange({ from: from.trim() || undefined, to: to.trim() || undefined })} /></Card>
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.data ? <Card><Heading title="Attendance summary" /><View style={styles.chipRow}>{statuses.map(status => <Badge key={status} label={`${status}: ${rawText(query.data!.summary, [`${status.toLowerCase()}Count`], '—')}`} />)}</View></Card> : null}
    {query.data?.records.map(record => <AttendanceRecordCard key={record.id} record={record} />)}
    {query.isSuccess && !query.data.records.length ? <Empty title="No attendance records" detail="Choose another date range or check again after teachers finalize attendance." /> : null}
  </Screen>;
}

function StudentAttendance() {
  const focused = useScreenFocus();
  const client = useQueryClient();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const inFlight = useRef(false);
  const query = useQuery({ queryKey: ['attendance', 'student'], queryFn: () => edumatchApi.attendance('student'), staleTime: 15_000 });
  const scan = useMutation({
    mutationFn: (payload: string) => attendanceSessions.scan(payload),
    onSuccess: async () => { setScanning(false); await client.invalidateQueries({ queryKey: ['attendance'] }); },
    onError: () => setScanning(false), onSettled: () => { inFlight.current = false; },
  });
  useEffect(() => { if (!focused) setScanning(false); }, [focused]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') setScanning(false); });
    return () => subscription.remove();
  }, []);
  async function beginScan() {
    if (inFlight.current) return;
    scan.reset();
    setCameraError('');
    try {
      const result = permission?.granted ? permission : await requestPermission();
      if (result.granted) setScanning(true);
    } catch (error) { setCameraError(errorMessage(error)); }
  }
  const onBarcode = useCallback(({ data }: { data: string }) => {
    if (!data || inFlight.current) return;
    inFlight.current = true;
    setScanning(false);
    scan.mutate(data);
  }, [scan]);
  return <Screen title="Your attendance" subtitle="Scan your teacher's current QR code to record class attendance." refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <Card><Heading title="Class QR scanner" detail="Your teacher opens a session before you scan." />
      {focused && scanning && permission?.granted ? <View style={local.cameraFrame}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onBarcode} onMountError={error => { setScanning(false); setCameraError(error.message || 'The camera could not be opened.'); }} /><View pointerEvents="none" style={local.scanGuide} /><Text style={local.cameraLabel}>Place the teacher's QR code inside the frame</Text></View> : null}
      {permission && !permission.granted && !permission.canAskAgain ? <><Notice message="Camera access is disabled. Enable camera permission for EduMatch in your device settings." tone="error" /><Button title="Open device settings" variant="secondary" onPress={() => void Linking.openSettings().catch(error => setCameraError(errorMessage(error)))} /></> : null}
      {cameraError ? <Notice message={cameraError} tone="error" /> : null}
      {scan.isPending ? <Notice message="Recording attendance with EduMatch…" /> : null}
      {scan.data ? <Notice tone="success" message={`${scan.data.duplicate ? 'Your attendance was already recorded' : 'Attendance recorded'}: ${scan.data.attendance.status} · ${scan.data.attendance.dateKey}.`} /> : null}
      {scan.error ? <Notice tone="error" message={errorMessage(scan.error)} /> : null}
      {scanning ? <Button title="Close scanner" variant="secondary" onPress={() => setScanning(false)} /> : <Button title={scan.data || scan.error ? 'Scan another code' : 'Scan attendance QR'} icon="qr-code-outline" onPress={() => void beginScan()} disabled={scan.isPending} loading={scan.isPending} />}
    </Card>
    <Heading title="Your attendance history" />
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.data?.records.map(record => <AttendanceRecordCard key={record.id} record={record} />)}
    {query.isSuccess && !query.data.records.length ? <Empty title="No attendance yet" detail="Your attendance will appear here after your first class session." /> : null}
  </Screen>;
}

function TeacherAttendance() {
  const { user } = useAuth();
  const focused = useScreenFocus();
  const client = useQueryClient();
  const [mode, setMode] = useState<'qr' | 'manual' | 'history'>('qr');
  const [subjectId, setSubjectId] = useState('');
  const [date, setDate] = useState(todayKey());
  const [duration, setDuration] = useState('15');
  const [lateAfter, setLateAfter] = useState('5');
  const [activeId, setActiveId] = useState('');
  const [qr, setQr] = useState<AttendanceSessionQr | null>(null);
  const [scope, setScope] = useState<AttendanceScope>('handled_class');
  const [manual, setManual] = useState<Record<string, AttendanceStatus>>({});
  const [overrides, setOverrides] = useState<Record<string, AttendanceStatus>>({});
  const [message, setMessage] = useState('');
  const subjects = useQuery({ queryKey: ['subjects', 'teacher'], queryFn: () => edumatchApi.subjects('teacher'), staleTime: 30_000 });
  const sessions = useQuery({ queryKey: ['attendance-sessions', subjectId], queryFn: () => attendanceSessions.list(subjectId || undefined), enabled: mode === 'qr', staleTime: 15_000 });
  const detail = useQuery({ queryKey: ['attendance-session', activeId], queryFn: () => attendanceSessions.read(activeId), enabled: mode === 'qr' && !!activeId && focused,
    refetchInterval: focused && mode === 'qr' ? 5_000 : false });
  const roster = useQuery({ queryKey: ['attendance-roster', subjectId, date, scope], queryFn: () => edumatchApi.attendanceRoster({ subjectId: scope === 'handled_class' ? subjectId : undefined, date, scope }), enabled: mode === 'manual' && !!date && (scope === 'advisory_class' || !!subjectId), staleTime: 15_000 });
  const history = useQuery({ queryKey: ['attendance', 'teacher'], queryFn: () => edumatchApi.attendance('teacher'), enabled: mode === 'history', staleTime: 20_000 });
  async function invalidateAttendance() { await Promise.all([client.invalidateQueries({ queryKey: ['attendance'] }), client.invalidateQueries({ queryKey: ['attendance-sessions'] }), client.invalidateQueries({ queryKey: ['attendance-session'] }), client.invalidateQueries({ queryKey: ['attendance-roster'] })]); }
  const create = useMutation({ mutationFn: () => attendanceSessions.create({ subjectId, dateKey: date, durationMinutes: Number(duration), lateAfterMinutes: Number(lateAfter) }),
    onSuccess: async value => { setQr(value); setActiveId(value.session.id); setOverrides({}); setMessage('Session opened. Students can scan this QR code.'); await invalidateAttendance(); } });
  const rotate = useMutation({ mutationFn: () => attendanceSessions.rotate(activeId), onSuccess: value => { setQr(value); setMessage('QR refreshed. The previous code is no longer valid.'); } });
  const finalize = useMutation({ mutationFn: () => attendanceSessions.finalize(activeId, Object.entries(overrides).map(([studentId, status]) => ({ studentId, status }))),
    onSuccess: async () => { setQr(null); setOverrides({}); setMessage('Attendance finalized and locked in the official school record.'); await invalidateAttendance(); } });
  const cancel = useMutation({ mutationFn: () => attendanceSessions.cancel(activeId), onSuccess: async () => { setQr(null); setOverrides({}); setMessage('The QR session has been cancelled.'); await invalidateAttendance(); } });
  const save = useMutation({ mutationFn: () => edumatchApi.saveAttendance({ subjectId: scope === 'handled_class' ? subjectId : undefined, scope, date,
    entries: roster.data!.students.map(student => ({ studentId: student.id, status: manual[student.id] || student.attendanceStatus as AttendanceStatus })) }),
    onSuccess: async () => { setManual({}); setMessage('Attendance saved. Finalize the record when your review is complete.'); await invalidateAttendance(); } });
  const lock = useMutation({ mutationFn: (recordId: string) => edumatchApi.lockAttendance(recordId), onSuccess: async () => { setMessage('Attendance finalized and locked.'); await invalidateAttendance(); } });
  const currentSession = detail.data?.session || (qr?.session.id === activeId ? qr.session : undefined);
  const open = currentSession?.status === 'open';
  const manualComplete = !!roster.data?.students.length && roster.data.students.every(student => !!(manual[student.id] || student.attendanceStatus));
  const busy = create.isPending || rotate.isPending || finalize.isPending || cancel.isPending || save.isPending || lock.isPending;
  function selectSubject(id: string) { setSubjectId(id); setActiveId(''); setQr(null); setManual({}); setOverrides({}); setMessage(''); }
  function confirmFinalize() { confirmAction('Finalize attendance?', 'Review the roster first. This saves and locks the official attendance record. Students who have not scanned will be marked absent unless you select an override.', 'Finalize', () => finalize.mutate()); }
  function confirmLock() { if (roster.data?.attendance) confirmAction('Finalize this record?', 'The saved attendance record will be locked.', 'Finalize', () => lock.mutate(roster.data!.attendance!.id)); }
  return <Screen title="Class attendance" subtitle="Open a QR session, review your roster, and finalize the official record." refreshing={mode === 'history' ? history.isRefetching : mode === 'manual' ? roster.isRefetching : detail.isRefetching}
    onRefresh={() => { if (mode === 'history') void history.refetch(); else if (mode === 'manual' && roster.isEnabled) void roster.refetch(); else { void sessions.refetch(); if (activeId) void detail.refetch(); } }}>
    <View style={styles.chipRow}><Chip label="QR sessions" active={mode === 'qr'} onPress={() => setMode('qr')} /><Chip label="Manual roster" active={mode === 'manual'} onPress={() => setMode('manual')} /><Chip label="History" active={mode === 'history'} onPress={() => setMode('history')} /></View>
    {message ? <Notice message={message} tone="success" /> : null}
    {mode !== 'history' ? <Card><Heading title="Choose your class" /><QueryStatus loading={subjects.isPending} error={subjects.error} retry={() => void subjects.refetch()} />
      <View style={styles.chipRow}>{subjects.data?.map(subject => <Chip key={subject.id} label={`${subject.name} · ${subject.className}`} active={subjectId === subject.id} onPress={() => selectSubject(subject.id)} />)}</View>
      {subjects.isSuccess && !subjects.data.length ? <Text style={styles.bodyMuted}>Create a subject before opening a class attendance session.</Text> : null}
      <Field label="Attendance date (YYYY-MM-DD)" value={date} onChangeText={value => { setDate(value); setManual({}); }} autoCapitalize="none" />
      {mode === 'qr' ? <><Field label="Session duration (minutes)" value={duration} onChangeText={setDuration} keyboardType="number-pad" /><Field label="Mark late after (minutes)" value={lateAfter} onChangeText={setLateAfter} keyboardType="number-pad" />
        {create.error ? <Notice message={errorMessage(create.error)} tone="error" /> : null}<Button title="Open QR session" icon="qr-code-outline" loading={create.isPending} disabled={!subjectId || !date || !duration.trim() || !lateAfter.trim() || busy} onPress={() => { create.reset(); setMessage(''); create.mutate(); }} /></> : user!.advisorySectionId ? <View style={styles.chipRow}><Chip label="Handled class" active={scope === 'handled_class'} onPress={() => { setScope('handled_class'); setManual({}); }} /><Chip label="Advisory class" active={scope === 'advisory_class'} onPress={() => { setScope('advisory_class'); setManual({}); }} /></View> : null}
    </Card> : null}
    {mode === 'qr' ? <>
      {activeId ? <Card><Heading title="Attendance session" action={<Badge label={currentSession?.status || 'Loading'} />} />
        {qr && qr.session.id === activeId && open ? <View style={local.qr}><QRCode value={qr.qrPayload} size={220} backgroundColor="#FFFFFF" color={colors.ink} /></View> : null}
        {currentSession ? <><Text style={styles.bodyMuted}>Attendance date: {currentSession.dateKey}</Text><Text style={styles.bodyMuted}>Late after: {displayDate(currentSession.lateAfter)}</Text><Text style={styles.bodyMuted}>Closes: {displayDate(currentSession.expiresAt)}</Text></> : null}
        {open ? <Button title={qr?.session.id === activeId ? 'Refresh QR code' : 'Show a fresh QR code'} variant="secondary" icon="refresh-outline" loading={rotate.isPending} disabled={busy} onPress={() => rotate.mutate()} /> : null}
        {rotate.error ? <Notice message={errorMessage(rotate.error)} tone="error" /> : null}
        <QueryStatus loading={detail.isPending} error={detail.error} retry={() => void detail.refetch()} />
        <Heading title="Live roster" detail={`${detail.data?.roster.filter(row => row.scannedAt).length || 0} scanned`} />
        {detail.data?.roster.map(student => <View key={student.studentId} style={{ gap: 8, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border }}><View style={styles.between}><Text style={[styles.body, { flex: 1, fontWeight: '600' }]}>{student.studentName}</Text><Badge label={overrides[student.studentId] || student.status || 'Not scanned'} /></View>
          {student.scannedAt ? <Text style={styles.bodyMuted}>{displayDate(student.scannedAt)}</Text> : null}
          {open ? <View style={styles.chipRow}>{statuses.map(status => <Chip key={status} label={status} active={overrides[student.studentId] === status} onPress={() => setOverrides(value => ({ ...value, [student.studentId]: status }))} />)}{overrides[student.studentId] ? <Chip label="Use scan result" onPress={() => setOverrides(value => { const next = { ...value }; delete next[student.studentId]; return next; })} /> : null}</View> : null}
        </View>)}
        {finalize.error || cancel.error ? <Notice message={errorMessage(finalize.error || cancel.error)} tone="error" /> : null}
        {open ? <><Button title="Finalize attendance" icon="lock-closed-outline" loading={finalize.isPending} disabled={busy || !detail.data} onPress={confirmFinalize} /><Button title="Cancel QR session" variant="danger" loading={cancel.isPending} disabled={busy} onPress={() => confirmAction('Cancel this session?', 'This code will stop accepting scans. Existing official attendance records will be preserved.', 'Cancel session', () => cancel.mutate(), true)} /></> : null}
      </Card> : null}
      <Heading title="Recent sessions" /><QueryStatus loading={sessions.isPending} error={sessions.error} retry={() => void sessions.refetch()} />
      {sessions.data?.map(session => <Card key={session.id}><View style={styles.between}><Text style={styles.heading}>{session.dateKey}</Text><Badge label={session.status} /></View><Text style={styles.bodyMuted}>{session.scanCount} scanned · {displayDate(session.expiresAt)}</Text><Button title="View roster" variant="secondary" disabled={busy} onPress={() => { setActiveId(session.id); setQr(null); setOverrides({}); setMessage(''); rotate.reset(); finalize.reset(); }} /></Card>)}
      {sessions.isSuccess && !sessions.data.length ? <Empty title="No QR sessions yet" detail="Choose a class and open its attendance session." /> : null}
    </> : null}
    {mode === 'manual' ? <>
      {roster.isEnabled ? <QueryStatus loading={roster.isPending} error={roster.error} retry={() => void roster.refetch()} /> : <Notice message="Choose a subject and date to load the class roster." />}
      {roster.data ? <Card><Heading title={roster.data.section.name || roster.data.subject.name || 'Class roster'} action={<Badge label={roster.data.attendance?.isLocked ? 'Finalized' : 'Editable'} />} />
        {!roster.data.attendance?.isLocked && roster.data.students.length ? <Button title="Mark all present" variant="secondary" disabled={busy} onPress={() => setManual(Object.fromEntries(roster.data!.students.map(student => [student.id, 'Present' as AttendanceStatus])))} /> : null}
        {roster.data.students.map(student => <View key={student.id} style={{ gap: 8, paddingVertical: 8 }}><View style={styles.between}><Text style={[styles.body, { flex: 1, fontWeight: '600' }]}>{student.name}</Text><Badge label={manual[student.id] || student.attendanceStatus || 'Unmarked'} /></View>
          {!roster.data!.attendance?.isLocked ? <View style={styles.chipRow}>{statuses.map(status => <Chip key={status} label={status} active={(manual[student.id] || student.attendanceStatus) === status} onPress={() => setManual(value => ({ ...value, [student.id]: status }))} />)}</View> : null}
        </View>)}
        {!roster.data.students.length ? <Text style={styles.bodyMuted}>No approved students are in this roster.</Text> : null}
        {save.error || lock.error ? <Notice message={errorMessage(save.error || lock.error)} tone="error" /> : null}
        {!roster.data.attendance?.isLocked ? <><Button title="Save attendance" loading={save.isPending} disabled={!manualComplete || busy} onPress={() => save.mutate()} />{roster.data.attendance ? <Button title="Finalize saved record" variant="secondary" loading={lock.isPending} disabled={busy || Object.keys(manual).length > 0} onPress={confirmLock} /> : null}</> : null}
      </Card> : null}
    </> : null}
    {mode === 'history' ? <><QueryStatus loading={history.isPending} error={history.error} retry={() => void history.refetch()} />{history.data?.records.map(record => <AttendanceRecordCard key={record.id} record={record} />)}{history.isSuccess && !history.data.records.length ? <Empty title="No attendance records" detail="Save or finalize class attendance to see records here." /> : null}</> : null}
  </Screen>;
}

const local = StyleSheet.create({
  cameraFrame: { height: 320, borderRadius: 20, overflow: 'hidden', backgroundColor: '#163C33', alignItems: 'center', justifyContent: 'center' },
  scanGuide: { width: 220, height: 220, borderWidth: 3, borderColor: colors.lime, borderRadius: 23 }, cameraLabel: { position: 'absolute', bottom: 16, color: '#FFFFFF', fontWeight: '600', textAlign: 'center', paddingHorizontal: 15 },
  qr: { alignItems: 'center', paddingVertical: 18, borderRadius: 18, backgroundColor: '#FFFFFF' },
});
