import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, ScrollView, Share, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { edumatchApi } from '../api/edumatch';
import { api } from '../api/client';
import type { Assessment, DataRow, Lesson } from '../api/types';
import { Badge, Button, Card, Chip, confirmAction, Empty, errorMessage, Field, Heading, Notice, QueryStatus, Screen, styles } from '../components/ui';
import { ReadingModal } from '../components/ReadingModal';
import { displayDate, rawText } from './roleConfig';
import { getLearningPage, LEARNING_PAGE_SIZE } from './learningPagination';

async function openMaterial(url: string) {
  try {
    const resolved = /^https?:\/\//i.test(url) ? url : new URL(url, api.defaults.baseURL || '').toString();
    if (!/^https?:\/\//i.test(resolved)) throw new Error('This material has an unsupported link.');
    await Linking.openURL(resolved);
  } catch (error) { Alert.alert('Unable to open material', errorMessage(error)); }
}

function appendAsset(form: FormData, field: string, asset: DocumentPicker.DocumentPickerAsset) {
  if (asset.file) form.append(field, asset.file, asset.name);
  else form.append(field, { uri: asset.uri, name: asset.name, type: asset.mimeType || 'application/octet-stream' } as unknown as Blob);
}

export function SubjectsScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const client = useQueryClient();
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [className, setClassName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const query = useQuery({ queryKey: ['subjects', role], queryFn: () => edumatchApi.subjects(role), staleTime: 20_000 });
  const join = useMutation({ mutationFn: () => edumatchApi.joinSubject(code.trim()), onSuccess: async () => { setCode(''); setMessage('Enrollment requested. Your teacher will review your request.'); await client.invalidateQueries({ queryKey: ['subjects'] }); } });
  const create = useMutation({ mutationFn: () => edumatchApi.createSubject({ subject: name.trim(), className: className.trim(), description: description.trim() || undefined }),
    onSuccess: async () => { setCreating(false); setName(''); setClassName(''); setDescription(''); setMessage('Your subject has been created. Share its enrollment code with your class.'); await Promise.all([client.invalidateQueries({ queryKey: ['subjects'] }), client.invalidateQueries({ queryKey: ['dashboard'] })]); } });
  return <Screen title="Your subjects" subtitle={role === 'student' ? 'Join your teacher’s class using its enrollment code.' : 'Manage your classes and share enrollment codes with students.'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    {message ? <Notice message={message} tone="success" /> : null}
    {role === 'student' ? <Card><Heading title="Join a subject" /><Field label="Enrollment code" value={code} onChangeText={setCode} autoCapitalize="characters" placeholder="Enter the code from your teacher" />{join.error ? <Notice message={errorMessage(join.error)} tone="error" /> : null}<Button title="Request enrollment" loading={join.isPending} disabled={!code.trim()} onPress={() => join.mutate()} /></Card> : null}
    {role === 'teacher' && !creating ? <Button title="Create a subject" icon="add-outline" onPress={() => { setCreating(true); create.reset(); }} /> : null}
    {creating ? <Card><Heading title="New subject" /><Field label="Subject name" value={name} onChangeText={setName} placeholder="Your assigned teaching subject" /><Field label="Class name" value={className} onChangeText={setClassName} placeholder="For example: Grade 10 – Section A" /><Field label="Description" value={description} onChangeText={setDescription} multiline placeholder="Class information (optional)" />
      {create.error ? <Notice message={errorMessage(create.error)} tone="error" /> : null}<Button title="Create subject" disabled={!name.trim() || !className.trim()} loading={create.isPending} onPress={() => create.mutate()} /><Button title="Cancel" variant="plain" disabled={create.isPending} onPress={() => setCreating(false)} /></Card> : null}
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.data?.map(subject => <Card key={subject.id}><View style={styles.between}><Text style={[styles.heading, { flex: 1 }]}>{subject.name}</Text><Badge label={subject.enrollmentStatus} /></View><Text style={styles.bodyMuted}>{subject.className}</Text>{subject.description ? <Text style={styles.body}>{subject.description}</Text> : null}
      {role === 'teacher' ? <><View style={styles.between}><Text style={styles.smallLabel}>Enrollment code</Text><Text selectable style={[styles.heading, { letterSpacing: 2 }]}>{subject.code}</Text></View><Text style={styles.bodyMuted}>{subject.approvedStudentsCount ?? 0} enrolled · {subject.pendingRequestsCount ?? 0} pending</Text><Button title="Share enrollment code" variant="secondary" icon="share-outline" onPress={() => void Share.share({ message: `Join ${subject.name} (${subject.className}) on EduMatch using enrollment code: ${subject.code}` })} /></> : null}
    </Card>)}
    {query.isSuccess && !query.data.length ? <Empty title="No subjects yet" detail={role === 'student' ? 'Ask your teacher for a subject enrollment code.' : 'Create your first subject to bring your class together.'} /> : null}
  </Screen>;
}

export function LessonsScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const client = useQueryClient();
  const [tab, setTab] = useState<'lessons' | 'assessments'>('lessons');
  const [selected, setSelected] = useState<Lesson | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [lessonPage, setLessonPage] = useState(1);
  const [assessmentPage, setAssessmentPage] = useState(1);
  const listScroll = useRef<ScrollView>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [track, setTrack] = useState(user!.strand || '');
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [creatingAssessment, setCreatingAssessment] = useState(false);
  const [points, setPoints] = useState('10');
  const [deadline, setDeadline] = useState('');
  const [submissionTypes, setSubmissionTypes] = useState(['written', 'link', 'file']);
  const [resubmission, setResubmission] = useState(true);
  const [lateSubmissions, setLateSubmissions] = useState(false);
  const [message, setMessage] = useState('');
  const lessons = useQuery({ queryKey: ['lessons', role], queryFn: () => edumatchApi.lessons(role), staleTime: 30_000 });
  const assessments = useQuery({ queryKey: ['assessments', role], queryFn: () => edumatchApi.assessments(role), staleTime: 20_000 });
  const subjects = useQuery({ queryKey: ['subjects', 'teacher'], queryFn: () => edumatchApi.subjects('teacher'), enabled: role === 'teacher' && (creating || creatingAssessment), staleTime: 30_000 });
  const teachers = useQuery({ queryKey: ['lesson-teachers'], queryFn: () => edumatchApi.users('headteacher'), enabled: role === 'headteacher' && creating, staleTime: 30_000 });
  const create = useMutation({ mutationFn: async () => {
    const form = new FormData();
    form.append('title', title.trim()); form.append('description', description.trim()); form.append('track', track.trim());
    if (role === 'teacher') {
      const subject = subjects.data!.find(item => item.id === subjectId)!;
      form.append('subjectId', subjectId); form.append('subject', subject.name);
    } else form.append('teacherId', teacherId);
    appendAsset(form, 'lessonPlanFile', file!);
    return edumatchApi.createLesson(role === 'headteacher' ? 'headteacher' : 'teacher', form);
  }, onSuccess: async () => { setCreating(false); setTitle(''); setDescription(''); setFile(null); setMessage('Your lesson has been published.'); await client.invalidateQueries({ queryKey: ['lessons'] }); } });
  const createActivity = useMutation({ mutationFn: () => {
    const subject = subjects.data!.find(item => item.id === subjectId)!;
    return edumatchApi.createAssessment('teacher', { title: title.trim(), subjectId, subject: subject.name, assessmentMode: 'activity', challengeDescription: description.trim(), activityPoints: Number(points), examDurationMinutes: 30, allowedSubmissionTypes: submissionTypes, allowResubmission: resubmission, allowLateSubmissions: lateSubmissions, submissionDeadline: deadline.trim() ? new Date(deadline.trim().replace(' ', 'T')).toISOString() : undefined });
  }, onSuccess: async () => { setCreatingAssessment(false); setTitle(''); setDescription(''); setMessage('Your activity has been published.'); await client.invalidateQueries({ queryKey: ['assessments'] }); } });
  async function pickPdf() { const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true }); if (!result.canceled) setFile(result.assets[0] || null); }
  const lessonPagination = getLearningPage(lessons.data || [], lessonPage);
  const assessmentPagination = getLearningPage(assessments.data || [], assessmentPage);
  useEffect(() => {
    if (lessons.isSuccess) setLessonPage(page => getLearningPage(lessons.data, page).page);
  }, [lessons.data, lessons.isSuccess]);
  useEffect(() => {
    if (assessments.isSuccess) setAssessmentPage(page => getLearningPage(assessments.data, page).page);
  }, [assessments.data, assessments.isSuccess]);
  function changeTab(next: 'lessons' | 'assessments') { setTab(next); listScroll.current?.scrollTo({ y: 0, animated: false }); }
  function changePage(page: number) {
    if (tab === 'lessons') setLessonPage(page); else setAssessmentPage(page);
    listScroll.current?.scrollTo({ y: 0, animated: false });
  }
  const selectedLesson = selected && (lessons.data?.find(item => item.id === selected.id) || selected);
  const selectedAssessment = assessment && (assessments.data?.find(item => item.id === assessment.id) || assessment);
  const readerOpen = !!selectedLesson || !!selectedAssessment;
  const activeQuery = tab === 'lessons' ? lessons : assessments;
  return <><View style={{ flex: 1 }} aria-hidden={readerOpen} accessibilityElementsHidden={readerOpen} importantForAccessibility={readerOpen ? 'no-hide-descendants' : 'auto'}>
    <Screen scrollRef={listScroll} title="Lessons & activities" subtitle={role === 'student' ? 'Open your materials, track your reading, and submit your work.' : 'Review teaching materials and class assessments.'} refreshing={activeQuery.isRefetching} onRefresh={() => void activeQuery.refetch()}>
    <View style={styles.chipRow}><Chip label="Lessons" active={tab === 'lessons'} onPress={() => changeTab('lessons')} /><Chip label="Assessments" active={tab === 'assessments'} onPress={() => changeTab('assessments')} /></View>
    {message ? <Notice message={message} tone="success" /> : null}
    {(role === 'teacher' || role === 'headteacher') && tab === 'lessons' && !creating ? <Button title="Publish a lesson" icon="add-outline" onPress={() => { setCreating(true); setTitle(''); setDescription(''); create.reset(); }} /> : null}
    {creating && tab === 'lessons' ? <Card><Heading title="Publish a lesson" />{role === 'teacher' ? <><QueryStatus loading={subjects.isPending} error={subjects.error} retry={() => void subjects.refetch()} /><View style={styles.chipRow}>{subjects.data?.map(subject => <Chip key={subject.id} label={`${subject.name} · ${subject.className}`} active={subjectId === subject.id} onPress={() => setSubjectId(subject.id)} />)}</View></> : <><Heading title="Assign to a teacher" /><QueryStatus loading={teachers.isPending} error={teachers.error} retry={() => void teachers.refetch()} /><View style={styles.chipRow}>{teachers.data?.map(teacher => <Chip key={teacher.id} label={teacher.name} active={teacherId === teacher.id} onPress={() => setTeacherId(teacher.id)} />)}</View></>}
      <Field label="Lesson title" value={title} onChangeText={setTitle} placeholder="What will students learn?" /><Field label="Description" value={description} onChangeText={setDescription} multiline placeholder="Lesson overview" /><Heading title="Track / strand" /><View style={styles.chipRow}>{['STEM', 'HUMSS', 'ABM', 'TVL', 'GENERAL'].map(option => <Chip key={option} label={option} active={track === option} onPress={() => setTrack(option)} />)}</View><Button title={file ? `PDF: ${file.name}` : 'Choose lesson plan PDF'} variant="secondary" icon="attach-outline" onPress={() => void pickPdf()} />
      {create.error ? <Notice message={errorMessage(create.error)} tone="error" /> : null}<Button title="Publish lesson" disabled={!title.trim() || !description.trim() || !track.trim() || !(role === 'teacher' ? subjectId : teacherId) || !file} loading={create.isPending} onPress={() => create.mutate()} /><Button title="Cancel" variant="plain" disabled={create.isPending} onPress={() => setCreating(false)} /></Card> : null}
    {role === 'teacher' && tab === 'assessments' && !creatingAssessment ? <Button title="Publish an activity" icon="add-outline" onPress={() => { setCreatingAssessment(true); setTitle(''); setDescription(''); createActivity.reset(); }} /> : null}
    {creatingAssessment && tab === 'assessments' ? <Card><Heading title="New class activity" /><QueryStatus loading={subjects.isPending} error={subjects.error} retry={() => void subjects.refetch()} /><View style={styles.chipRow}>{subjects.data?.map(subject => <Chip key={subject.id} label={`${subject.name} · ${subject.className}`} active={subjectId === subject.id} onPress={() => setSubjectId(subject.id)} />)}</View>
      <Field label="Activity title" value={title} onChangeText={setTitle} placeholder="Name your activity" /><Field label="Instructions" value={description} onChangeText={setDescription} multiline placeholder="Tell students what to submit" /><Field label="Available points" value={points} onChangeText={setPoints} keyboardType="decimal-pad" /><Field label="Due date and time (optional)" value={deadline} onChangeText={setDeadline} placeholder="2026-10-15 17:00" />
      <Heading title="Accepted responses" /><View style={styles.chipRow}>{['written', 'link', 'file'].map(type => <Chip key={type} label={type.charAt(0).toUpperCase() + type.slice(1)} active={submissionTypes.includes(type)} onPress={() => setSubmissionTypes(previous => previous.includes(type) ? previous.filter(item => item !== type) : [...previous, type])} />)}</View><View style={styles.chipRow}><Chip label="Allow resubmission" active={resubmission} onPress={() => setResubmission(!resubmission)} /><Chip label="Allow late submissions" active={lateSubmissions} onPress={() => setLateSubmissions(!lateSubmissions)} /></View>
      {createActivity.error ? <Notice message={errorMessage(createActivity.error)} tone="error" /> : null}<Button title="Publish activity" disabled={!subjectId || !title.trim() || !description.trim() || !points.trim() || !Number.isFinite(Number(points)) || !submissionTypes.length} loading={createActivity.isPending} onPress={() => createActivity.mutate()} /><Button title="Cancel" variant="plain" disabled={createActivity.isPending} onPress={() => setCreatingAssessment(false)} />
    </Card> : null}
    <QueryStatus loading={activeQuery.isPending} error={activeQuery.error} retry={() => void activeQuery.refetch()} />
    {activeQuery.data?.length ? <Heading title={tab === 'lessons' ? 'Class lessons' : 'Class assessments'} detail={`${LEARNING_PAGE_SIZE} records per page`} /> : null}
    {tab === 'lessons' ? lessonPagination.records.map(lesson => <Card key={lesson.id}><Text style={styles.heading}>{lesson.title}</Text><Text style={styles.bodyMuted}>{lesson.subject} · {lesson.className || lesson.track || ''}</Text><Text style={styles.body} numberOfLines={3}>{lesson.description}</Text>
      {role === 'student' && lesson.progress ? <Badge label={`Progress: ${rawText(lesson.progress, ['progressPercent'], '0')}%`} /> : null}
      <Button title="Open lesson" variant="secondary" icon="book-outline" onPress={() => { setAssessment(null); setSelected(lesson); }} /></Card>) : assessmentPagination.records.map(item => <Card key={item.id}><View style={styles.between}><Text style={[styles.heading, { flex: 1 }]}>{item.title}</Text><Badge label={item.assessmentMode} /></View><Text style={styles.bodyMuted}>{item.subject}</Text>{item.challengeDescription ? <Text style={styles.body} numberOfLines={3}>{item.challengeDescription}</Text> : null}
      {item.submissionDeadline ? <Text style={styles.bodyMuted}>Due {displayDate(item.submissionDeadline)}</Text> : null}
      {item.isLocked ? <Notice message={item.lockReason || 'This assessment is locked.'} /> : null}
      <Button title={role === 'student' ? 'Open assessment' : 'Review assessment'} variant="secondary" onPress={() => { setSelected(null); setAssessment(item); }} /></Card>)}
    {activeQuery.data?.length ? <LearningPagination pagination={tab === 'lessons' ? lessonPagination : assessmentPagination} onChange={changePage} /> : null}
    {activeQuery.isSuccess && !activeQuery.data.length ? <Empty title={tab === 'lessons' ? 'No lessons yet' : 'No assessments yet'} detail="Your class materials will appear here when they are published." /> : null}
  </Screen></View>
    {selectedLesson ? <ReadingModal title={selectedLesson.title} subtitle={[selectedLesson.subject, selectedLesson.className || selectedLesson.track].filter(Boolean).join(' · ')} backLabel="Back to lessons" onClose={() => setSelected(null)}>
      <LessonReader key={selectedLesson.id} lesson={selectedLesson} />
    </ReadingModal> : null}
    {selectedAssessment ? <ReadingModal title={selectedAssessment.title} backLabel="Back to assessments" onClose={() => setAssessment(null)}>
      <AssessmentWorkspace key={selectedAssessment.id} assessment={selectedAssessment} />
    </ReadingModal> : null}
  </>;
}

function LearningPagination({ pagination, onChange }: {
  pagination: { page: number; totalPages: number; totalRecords: number; start: number; end: number }; onChange: (page: number) => void;
}) {
  return <Card>
    <View style={[styles.between, { flexWrap: 'wrap' }]}><Text style={styles.bodyMuted}>Showing {pagination.start}–{pagination.end} of {pagination.totalRecords}</Text><Text accessibilityLiveRegion="polite" style={styles.body}>Page {pagination.page} of {pagination.totalPages}</Text></View>
    <View style={styles.row}><View style={{ flex: 1 }}><Button title="Previous" variant="secondary" disabled={pagination.page <= 1} onPress={() => onChange(pagination.page - 1)} /></View><View style={{ flex: 1 }}><Button title="Next" variant="secondary" disabled={pagination.page >= pagination.totalPages} onPress={() => onChange(pagination.page + 1)} /></View></View>
  </Card>;
}

function LessonReader({ lesson }: { lesson: Lesson }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const openedAt = useRef(Date.now());
  const [message, setMessage] = useState('');
  const progress = useMutation({ mutationFn: () => edumatchApi.lessonProgress(lesson.id, { progressPercent: 100, reachedEnd: true, engagementSeconds: Math.max(0, Math.floor((Date.now() - openedAt.current) / 1000)) }),
    onSuccess: async () => { setMessage('Your lesson progress has been saved.'); await client.invalidateQueries({ queryKey: ['lessons'] }); } });
  return <>
    <Card><Heading title="Lesson overview" /><Text style={styles.body}>{lesson.description}</Text></Card>
    {lesson.attachments.length || lesson.downloadUrl ? <Card><Heading title="Learning materials" />
      {lesson.attachments.map((attachment, index) => <Button key={attachment.id || index} title={attachment.fileName || 'Open lesson material'} variant="secondary" icon="document-text-outline" onPress={() => void openMaterial(attachment.downloadUrl || attachment.url)} />)}
      {lesson.downloadUrl ? <Button title="Open lesson plan" variant="secondary" icon="document-text-outline" onPress={() => void openMaterial(lesson.downloadUrl!)} /> : null}
    </Card> : null}
    {user!.role === 'student' ? <Card><Heading title="Your progress" />{lesson.progress ? <Badge label={`Progress: ${rawText(lesson.progress, ['progressPercent'], '0')}%`} /> : null}
      {message ? <Notice message={message} tone="success" /> : null}{progress.error ? <Notice message={errorMessage(progress.error)} tone="error" /> : null}<Button title="Mark lesson as reviewed" loading={progress.isPending} onPress={() => progress.mutate()} />
    </Card> : null}
  </>;
}

function AssessmentWorkspace({ assessment }: { assessment: Assessment }) {
  const { user } = useAuth();
  const student = user!.role === 'student';
  const activity = assessment.assessmentMode.toLowerCase() === 'activity';
  return <Card>
    <Text style={styles.bodyMuted}>{assessment.subject} · {assessment.assessmentMode}</Text>{assessment.challengeDescription ? <Text style={styles.body}>{assessment.challengeDescription}</Text> : null}
    {assessment.attachments.map((file, index) => <Button key={file.id || index} title={file.fileName || 'Open attachment'} variant="secondary" icon="attach-outline" onPress={() => void openMaterial(file.downloadUrl || file.url)} />)}
    {assessment.isLocked ? <Notice message={assessment.lockReason || 'This assessment is locked.'} /> : null}
    {student && !assessment.isLocked ? activity ? <ActivityResponse assessment={assessment} /> : <ExamResponse assessment={assessment} /> : null}
  </Card>;
}

function ActivityResponse({ assessment }: { assessment: Assessment }) {
  const client = useQueryClient();
  const [response, setResponse] = useState('');
  const [links, setLinks] = useState('');
  const [files, setFiles] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const initialized = useRef(false);
  const query = useQuery({ queryKey: ['activity-response', assessment.id], queryFn: () => edumatchApi.activityResponse(assessment.id), staleTime: 0 });
  useEffect(() => {
    if (!query.isSuccess || initialized.current) return;
    initialized.current = true;
    if (query.data) {
      setResponse(rawText(query.data, ['responseText']));
      const savedLinks = Array.isArray(query.data.links) ? query.data.links : [];
      setLinks(savedLinks.map(link => typeof link === 'string' ? link : rawText(object(link), ['url'])).join('\n'));
    }
  }, [query.data, query.isSuccess]);
  const attachments = Array.isArray(query.data?.attachments) ? query.data.attachments.map(object) : [];
  const retained = attachments.filter(file => !removed.includes(rawText(file, ['id', '_id'])));
  const save = useMutation({ mutationFn: (submit: boolean) => {
    const input = { responseText: response.trim(), links: links.split('\n').map(link => link.trim()).filter(Boolean), retainedAttachmentIds: retained.map(file => rawText(file, ['id', '_id'])) };
    if (!files.length) return edumatchApi.saveActivityResponse(assessment.id, input, submit);
    const form = new FormData();
    form.append('responseText', input.responseText); form.append('links', JSON.stringify(input.links)); form.append('retainedAttachmentIds', JSON.stringify(input.retainedAttachmentIds));
    files.forEach(file => appendAsset(form, 'attachments', file));
    return edumatchApi.saveActivityResponse(assessment.id, form, submit);
  }, onSuccess: async (_, submit) => { setFiles([]); setRemoved([]); setMessage(submit ? 'Your activity has been submitted for review.' : 'Your activity draft has been saved.'); await Promise.all([client.invalidateQueries({ queryKey: ['activity-response', assessment.id] }), client.invalidateQueries({ queryKey: ['assessments'] }), client.invalidateQueries({ queryKey: ['grades'] })]); } });
  const unsubmit = useMutation({ mutationFn: () => edumatchApi.unsubmitActivity(assessment.id), onSuccess: async () => { setMessage('Your activity is open for editing.'); save.reset(); await client.invalidateQueries({ queryKey: ['activity-response', assessment.id] }); } });
  const hasGrade = query.data?.gradeValue !== undefined && query.data.gradeValue !== null;
  const submitted = /submitted|graded|completed|terminated/.test(rawText(query.data || {}, ['status']).toLowerCase()) || hasGrade;
  const canUnsubmit = !hasGrade && !query.data?.gradedAt && assessment.allowResubmission !== false;
  const allowedTypes = assessment.allowedSubmissionTypes || ['written', 'link', 'file'];
  async function pickFiles() { const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }); if (!result.canceled) setFiles(previous => [...previous, ...result.assets]); }
  function submit() { confirmAction('Submit this activity?', 'Your response will be sent to your teacher for review.', 'Submit', () => save.mutate(true)); }
  return <><QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.isSuccess ? <><Badge label={rawText(query.data || {}, ['status'], 'Draft')} />{allowedTypes.includes('written') ? <Field label="Your written response" editable={!submitted} value={response} onChangeText={setResponse} placeholder="Write your answer here" multiline /> : null}{allowedTypes.includes('link') ? <Field label="Supporting links (one per line)" editable={!submitted} value={links} onChangeText={setLinks} autoCapitalize="none" multiline placeholder="https://…" /> : null}
      {retained.map((file, index) => <View key={rawText(file, ['id', '_id'], String(index))} style={{ gap: 8 }}><Button title={rawText(file, ['fileName', 'name'], 'Open submitted file')} variant="secondary" icon="document-text-outline" onPress={() => void openMaterial(rawText(file, ['downloadUrl', 'url']))} />{!submitted ? <Button title="Remove attachment" variant="plain" onPress={() => setRemoved(previous => [...previous, rawText(file, ['id', '_id'])])} /> : null}</View>)}
      {files.map((file, index) => <View key={`${file.uri}-${index}`} style={styles.between}><Text style={[styles.body, { flex: 1 }]}>{file.name}</Text><Button title="Remove" variant="plain" onPress={() => setFiles(previous => previous.filter((_, fileIndex) => fileIndex !== index))} /></View>)}
      {allowedTypes.includes('file') && !submitted ? <Button title="Attach files" variant="secondary" icon="attach-outline" onPress={() => void pickFiles()} /> : null}
      {message ? <Notice message={message} tone="success" /> : null}{save.error || unsubmit.error ? <Notice message={errorMessage(save.error || unsubmit.error)} tone="error" /> : null}
      {rawText(query.data || {}, ['teacherFeedback']) ? <Notice message={rawText(query.data || {}, ['teacherFeedback'])} /> : null}
      {submitted ? canUnsubmit ? <Button title="Unsubmit to edit" variant="secondary" loading={unsubmit.isPending} onPress={() => confirmAction('Unsubmit this activity?', 'EduMatch will check whether this submission can still be edited.', 'Unsubmit', () => unsubmit.mutate())} /> : <Notice message="This submission has been finalized. View your grade and feedback in Grades & feedback." /> : <><Button title="Save draft" variant="secondary" disabled={save.isPending} loading={save.isPending && save.variables === false} onPress={() => save.mutate(false)} />
      <Button title="Submit activity" disabled={save.isPending || (!response.trim() && !links.trim() && !files.length && !retained.length)} loading={save.isPending && save.variables === true} onPress={submit} /></>}
    </> : null}</>;
}

function object(value: unknown): DataRow { return value && typeof value === 'object' && !Array.isArray(value) ? value as DataRow : {}; }
function ExamResponse({ assessment }: { assessment: Assessment }) {
  const client = useQueryClient();
  const [live, setLive] = useState<DataRow | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [message, setMessage] = useState('');
  const initialized = useRef('');
  const query = useQuery({ queryKey: ['exam', assessment.id], queryFn: () => edumatchApi.exam(assessment.id), staleTime: 0 });
  const start = useMutation({ mutationFn: () => edumatchApi.startExam(assessment.id), onSuccess: data => setLive(data) });
  const data = live || query.data;
  const session = object(data?.session);
  const exam = object(data?.assessment);
  const questions = Array.isArray(exam.questions) ? exam.questions.map(object) : [];
  const active = session.status === 'in_progress' || session.status === 'started' || session.status === 'active';
  const finalized = ['completed', 'auto_submitted', 'terminated'].includes(rawText(session, ['status'])) || !!data?.submission;
  useEffect(() => {
    const sessionId = rawText(session, ['id']);
    if (sessionId && initialized.current !== sessionId) {
      initialized.current = sessionId;
      const saved = Array.isArray(session.answers) ? session.answers.map(object) : [];
      setAnswers(Object.fromEntries(saved.map(answer => [Number(answer.questionIndex), rawText(answer, ['answer'])])));
    }
  }, [session]);
  const answerRows = () => Object.entries(answers).map(([questionIndex, answer]) => ({ questionIndex: Number(questionIndex), answer }));
  const save = useMutation({ mutationFn: () => edumatchApi.saveExamProgress(assessment.id, answerRows()), onSuccess: () => setMessage('Your answers have been saved.') });
  const submit = useMutation({ mutationFn: () => edumatchApi.submitExam(assessment.id, answerRows()), onSuccess: async data => { setLive(data); setMessage('Your assessment has been submitted. Your results will appear in Grades & feedback.'); await Promise.all([client.invalidateQueries({ queryKey: ['exam', assessment.id] }), client.invalidateQueries({ queryKey: ['grades'] }), client.invalidateQueries({ queryKey: ['assessments'] })]); } });
  const errors = start.error || save.error || submit.error;
  function confirmSubmit() { confirmAction('Submit your answers?', 'EduMatch will save and finalize your assessment on the server.', 'Submit', () => submit.mutate()); }
  return <><QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {message ? <Notice message={message} tone="success" /> : null}{errors ? <Notice message={errorMessage(errors)} tone="error" /> : null}
    {finalized ? <Notice message={`This assessment has been finalized${session.status ? ` (${String(session.status).replace(/_/g, ' ')})` : ''}. See your official results in Grades & feedback.`} /> : null}
    {session.expiresAt ? <Notice message={`Session closes ${displayDate(String(session.expiresAt))}. Save your answers before submitting.`} /> : null}
    {!active && !finalized && !submit.isSuccess && query.isSuccess ? <Button title="Start / resume assessment" loading={start.isPending} onPress={() => { start.reset(); start.mutate(); }} /> : null}
    {active && !submit.isSuccess ? <>{questions.map((question, index) => <View key={index} style={{ gap: 10, paddingVertical: 12 }}><Text style={styles.heading}>{index + 1}. {rawText(question, ['questionText', 'question'])}</Text>
      {Array.isArray(question.options) && question.options.length ? <View style={{ gap: 8 }}>{question.options.map((option, optionIndex) => {
        const label = typeof option === 'string' ? option : rawText(object(option), ['text', 'label', 'value']);
        return <Chip key={optionIndex} label={label} active={answers[index] === label} onPress={() => setAnswers(previous => ({ ...previous, [index]: label }))} />;
      })}</View> : <Field label={`Answer to question ${index + 1}`} value={answers[index] || ''} onChangeText={answer => setAnswers(previous => ({ ...previous, [index]: answer }))} multiline />}
    </View>)}<Button title="Save answers" variant="secondary" loading={save.isPending} disabled={submit.isPending} onPress={() => save.mutate()} /><Button title="Submit assessment" loading={submit.isPending} disabled={save.isPending} onPress={confirmSubmit} /></> : null}
  </>;
}
