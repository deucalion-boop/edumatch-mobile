import React, { useEffect, useRef, useState } from 'react';
import { Platform, Share, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { DEPARTMENTS } from '../auth/roles';
import { isGradeTenStudent } from '../auth/studentAccess';
import { edumatchApi, notificationApi } from '../api/edumatch';
import type { Approval, ResourceItem, Role, User } from '../api/types';
import { Badge, Button, Card, Chip, confirmAction, Empty, errorMessage, Field, Heading, Notice, QueryStatus, Screen, styles } from '../components/ui';
import { displayDate, featureNames, rawText } from './roleConfig';
import { studentSectionOptions } from './studentSections';
import { teacherDepartmentOptions } from './teacherDepartments';
import { getListPage } from './listPagination';

function ItemCard({ item, children }: { item: ResourceItem; children?: React.ReactNode }) {
  return <Card><View style={styles.between}><Text style={[styles.heading, { flex: 1 }]}>{item.title}</Text><Badge label={item.status} /></View>
    {item.subtitle ? <Text style={styles.bodyMuted}>{item.subtitle}</Text> : null}
    {item.description ? <Text style={styles.body}>{item.description}</Text> : null}
    {item.createdAt ? <Text style={styles.smallLabel}>{displayDate(item.createdAt)}</Text> : null}{children}</Card>;
}

function DetailFields({ row, fields }: { row: Record<string, unknown>; fields: { label: string; keys: string[] }[] }) {
  return <>{fields.map(field => {
    const rawValue = rawText(row, field.keys);
    const value = field.label === 'Role' ? rawValue.replace(/\b(headteacher|teacher|student|secretary|admin)\b/gi, role => role === 'headteacher' ? 'Head Teacher' : role.charAt(0).toUpperCase() + role.slice(1)) : rawValue;
    return value ? <View key={field.label} style={[styles.between, { alignItems: 'flex-start' }]}>
      <Text style={[styles.bodyMuted, { flex: 1, minWidth: 0, paddingRight: 2 }]}>{field.label}</Text>
      <Text style={[styles.body, { flex: 2, minWidth: 0, textAlign: 'right', fontWeight: '600' }]}>{value}</Text>
    </View> : null;
  })}</>;
}

export function RecordsScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const managingUsers = role !== 'student';
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [archived, setArchived] = useState(false);
  const [schoolYear, setSchoolYear] = useState('');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['records', role, user!.gradeLevel, filter, archived, schoolYear], queryFn: async (): Promise<ResourceItem[]> => {
    if (role === 'student' && !isGradeTenStudent(user!)) {
      const overview = await edumatchApi.attendance(role);
      return overview.records.map(record => ({ id: record.id, title: record.title || rawText(record.subject || {}, ['name', 'subject'], 'Attendance record'), subtitle: record.dateKey, status: record.status || (record.isLocked ? 'Finalized' : 'Open'), raw: record }))
        .filter(item => `${item.title} ${item.subtitle} ${item.status}`.toLowerCase().includes(filter.toLowerCase()));
    }
    return edumatchApi.records(role, { search: filter || undefined, archived, schoolYear: schoolYear.trim() || undefined });
  }, staleTime: 30_000 });
  const requestExport = useMutation({ mutationFn: () => edumatchApi.requestArchivedExport({ schoolYear: schoolYear.trim() || undefined, searchTerm: filter || undefined }), onSuccess: async () => { setMessage('Your archived records export request has been sent for administrator approval.'); await client.invalidateQueries({ queryKey: ['approvals'] }); } });
  const archive = useMutation({ mutationFn: () => edumatchApi.archiveSchoolYear(schoolYear.trim()), onSuccess: async () => { setMessage('The school year has been archived.'); setArchived(true); await client.invalidateQueries({ queryKey: ['records'] }); } });
  const pagination = getListPage(query.data || [], page);
  useEffect(() => { setPage(1); }, [filter, archived, schoolYear, role]);
  return <Screen title={managingUsers ? featureNames.records : 'School records'} subtitle={managingUsers ? 'Find and manage school user accounts.' : 'Find the records available to your account.'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    {message ? <Notice message={message} tone="success" /> : null}
    {role !== 'student' && !creating ? <Button title={role === 'teacher' ? 'Add a student' : role === 'headteacher' ? 'Add a teacher' : 'Add a school account'} icon="person-add-outline" onPress={() => setCreating(true)} /> : null}
    {creating ? <AccountCreator role={role} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); setMessage('The school account has been created.'); void client.invalidateQueries({ queryKey: ['records'] }); }} /> : null}
    {role === 'secretary' ? <View style={styles.chipRow}><Chip label="Current students" active={!archived} onPress={() => setArchived(false)} /><Chip label="Archived students" active={archived} onPress={() => setArchived(true)} /></View> : null}
    <Card><Field label="Search records" placeholder="Name, subject, or record title" value={search} onChangeText={setSearch} returnKeyType="search" onSubmitEditing={() => setFilter(search.trim())} />
      <Button title="Search" onPress={() => setFilter(search.trim())} variant="secondary" icon="search-outline" />{filter ? <Button title="Clear search" variant="plain" onPress={() => { setSearch(''); setFilter(''); }} /> : null}</Card>
    {role === 'secretary' ? <Card><Heading title={archived ? 'Archived school year' : 'School year management'} /><Field label="School year" placeholder="2026-2027" value={schoolYear} onChangeText={setSchoolYear} autoCapitalize="none" />
      {requestExport.error || archive.error ? <Notice tone="error" message={errorMessage(requestExport.error || archive.error)} /> : null}
      {archived ? <Button title="Request records export" variant="secondary" icon="document-text-outline" loading={requestExport.isPending} onPress={() => requestExport.mutate()} /> : <Button title="Archive school year" variant="secondary" disabled={!schoolYear.trim()} loading={archive.isPending} onPress={() => confirmAction('Archive this school year?', `Eligible inactive students in ${schoolYear.trim()} will be moved to archived records. Check the school year before continuing.`, 'Archive', () => archive.mutate())} />}
    </Card> : null}
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {pagination.records.map(item => <ItemCard key={item.id} item={item}><DetailFields row={item.raw} fields={[
      { label: 'Email', keys: ['email', 'studentEmail', 'requesterEmail'] }, { label: 'Role', keys: ['role'] },
      { label: 'Grade / section', keys: ['sectionName', 'gradeLevel', 'className'] }, { label: 'Department', keys: ['department', 'strand'] },
      { label: 'School year', keys: ['schoolYear'] },
    ]} /></ItemCard>)}
    {pagination.totalRecords ? <Card>
      <View style={[styles.between, { flexWrap: 'wrap' }]}><Text style={styles.bodyMuted}>Showing {pagination.start}–{pagination.end} of {pagination.totalRecords}</Text><Text accessibilityLiveRegion="polite" style={styles.body}>Page {pagination.page} of {pagination.totalPages}</Text></View>
      <View style={styles.row}><View style={{ flex: 1 }}><Button title="Previous" variant="secondary" disabled={pagination.page <= 1} onPress={() => setPage(pagination.page - 1)} /></View><View style={{ flex: 1 }}><Button title="Next" variant="secondary" disabled={pagination.page >= pagination.totalPages} onPress={() => setPage(pagination.page + 1)} /></View></View>
    </Card> : null}
    {query.isSuccess && !query.data.length ? <Empty title={filter ? 'No matching records' : 'No records yet'} detail={filter ? 'Try a different name or remove your search.' : 'School records will appear when they are available to your account.'} /> : null}
  </Screen>;
}

function AccountCreator({ role, onClose, onSaved }: { role: Role; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const privateStaffRegistration = role === 'admin' || role === 'secretary';
  const allowed: Role[] = role === 'teacher' ? ['student'] : role === 'headteacher' ? ['teacher'] : role === 'secretary' ? ['headteacher', 'teacher'] : ['secretary', 'teacher', 'headteacher'];
  const [accountRole, setAccountRole] = useState<Role>(allowed[0]!);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [department, setDepartment] = useState(role === 'headteacher' ? user!.department || '' : '');
  const needsDepartment = accountRole === 'headteacher' || accountRole === 'teacher';
  const needsHeadTeacherDirectory = accountRole === 'teacher' && (role === 'admin' || role === 'secretary');
  const headTeachers = useQuery({ queryKey: ['account-departments', role], queryFn: () => edumatchApi.users(role, { role: 'headteacher' }), enabled: needsHeadTeacherDirectory, staleTime: 0 });
  const availableDepartments = accountRole === 'teacher'
    ? teacherDepartmentOptions(headTeachers.isSuccess ? headTeachers.data || [] : [], user!)
    : DEPARTMENTS.filter(option => role !== 'headteacher' || option === user!.department);
  const selectedDepartment = availableDepartments.find(option => option === department);
  const [sectionId, setSectionId] = useState('');
  const [advisorySectionId, setAdvisorySectionId] = useState('');
  const canAssignAdvisory = role === 'headteacher' && accountRole === 'teacher';
  const sections = useQuery({ queryKey: ['sections', role], queryFn: () => edumatchApi.sections(role), enabled: accountRole === 'student' || canAssignAdvisory, staleTime: 60_000 });
  const availableSections = studentSectionOptions(sections.data || [], user!);
  const advisorySections = (sections.data || []).filter(section => section.isActive !== false);
  const invalidAdvisory = canAssignAdvisory && Boolean(advisorySectionId) &&
    (!sections.isSuccess || !advisorySections.some(section => section.id === advisorySectionId));
  const selectedSectionId = role === 'teacher' ? availableSections[0]?.id || '' : sectionId;
  const create = useMutation<User | { inviteLink: string; inviteExpiresAt: string | null }>({ mutationFn: () => privateStaffRegistration
    ? edumatchApi.createStaffRegistration(role, accountRole as 'secretary' | 'headteacher' | 'teacher')
    : edumatchApi.createUser(role, {
      name: name.trim(), email: email.trim(), username: username.trim(), role: accountRole,
      department: needsDepartment ? selectedDepartment : undefined,
      subject: accountRole === 'teacher' ? selectedDepartment : undefined,
      sectionId: accountRole === 'student' ? selectedSectionId || undefined : undefined,
      advisorySectionId: canAssignAdvisory ? advisorySectionId || undefined : undefined,
    }), onSuccess: result => {
      if (privateStaffRegistration && typeof result.inviteLink === 'string') setInviteLink(result.inviteLink);
      else onSaved();
    } });
  async function shareInvite() {
    if (!inviteLink) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(inviteLink);
    else await Share.share({ title: 'EduMatch private registration link', message: inviteLink, url: inviteLink });
  }
  return <Card><Heading title={privateStaffRegistration ? 'Create private registration link' : 'New school account'} detail={privateStaffRegistration ? 'Choose a staff role, then privately share the link so they can enter their own account details and password.' : undefined} /><View style={styles.chipRow}>{allowed.map(option => <Chip key={option} label={option === 'headteacher' ? 'Head Teacher' : option.charAt(0).toUpperCase() + option.slice(1)} active={accountRole === option} onPress={() => { setAccountRole(option); setInviteLink(''); create.reset(); }} />)}</View>
    {privateStaffRegistration ? <>
      <Notice message="The account remains pending until the invited staff member completes registration. The private link expires after 24 hours." />
      {inviteLink ? <><Field label="Private registration link" value={inviteLink} editable={false} /><Button title={Platform.OS === 'web' ? 'Copy private link' : 'Share private link'} icon={Platform.OS === 'web' ? 'copy-outline' : 'share-outline'} onPress={() => void shareInvite()} /><Button title="Done" variant="secondary" onPress={onSaved} /></> : <><Button title="Generate private registration link" icon="link-outline" loading={create.isPending} onPress={() => create.mutate()} /><Button title="Cancel" disabled={create.isPending} variant="plain" onPress={onClose} /></>}
      {create.error ? <Notice message={errorMessage(create.error)} tone="error" /> : null}
    </> : <>
    <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" placeholder="Student or staff name" /><Field label="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="School email address" />
    <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} maxLength={50} placeholder="Student or staff username" />
    {accountRole === 'student' ? <>
      <Heading title="Section" detail="New student accounts are automatically assigned to Grade 10." />
      <QueryStatus loading={sections.isPending} error={sections.error} retry={() => void sections.refetch()} />
      <View style={styles.chipRow}>{availableSections.map(section => <Chip key={section.id} label={section.name} active={selectedSectionId === section.id} onPress={() => setSectionId(section.id)} />)}</View>
      {sections.isSuccess && !availableSections.length ? <Notice message={role === 'teacher' ? 'You need an assigned advisory section before adding students.' : 'No active sections are available. Contact your school administrator.'} /> : null}
    </> : needsDepartment ? <>
      <Heading title="Department" detail={role === 'headteacher' ? 'Teachers are assigned to your department.' : accountRole === 'teacher' ? 'Select a department with an assigned Head Teacher.' : 'Select the department for this account.'} />
      {needsHeadTeacherDirectory ? <QueryStatus loading={headTeachers.isPending} error={headTeachers.error} retry={() => void headTeachers.refetch()} /> : null}
      <View style={styles.chipRow}>{availableDepartments.map(option => <Chip key={option} label={option} active={selectedDepartment === option} onPress={() => setDepartment(option)} />)}</View>
      {!availableDepartments.length && (!needsHeadTeacherDirectory || headTeachers.isSuccess) ? <>
        <Notice message={role === 'headteacher' ? 'Your account needs an assigned department before you can add teachers.' : 'No departments are available for teachers. Ask your school administrator to create a Head Teacher account first.'} />
      </> : null}
    </> : null}
    {canAssignAdvisory ? <>
      <Heading title="Advisory class section" detail="Choose from all active school sections for this teacher, or leave unassigned." />
      <QueryStatus loading={sections.isPending} error={sections.error} retry={() => void sections.refetch()} />
      {sections.isSuccess ? <View style={styles.chipRow}>
        <Chip label="No advisory section" active={!advisorySectionId} onPress={() => { if (!create.isPending) setAdvisorySectionId(''); }} />
        {advisorySections.map(section => <Chip key={section.id} label={section.gradeLevel ? `Grade ${section.gradeLevel.replace(/^Grade\s*/i, '')} · ${section.name}` : section.name} active={advisorySectionId === section.id} onPress={() => { if (!create.isPending) setAdvisorySectionId(section.id); }} />)}
      </View> : null}
      {sections.isSuccess && !advisorySections.length ? <Notice message="No active sections are available. You can create the teacher without an advisory section." /> : null}
    </> : null}
    {create.error ? <Notice message={errorMessage(create.error)} tone="error" /> : null}<Button title={accountRole === 'teacher' ? 'Create Teacher & Email Credentials' : 'Create Student & Email Credentials'} loading={create.isPending} disabled={!name.trim() || !email.trim() || !username.trim() || invalidAdvisory || (needsDepartment && !selectedDepartment) || (accountRole === 'student' && (!selectedSectionId || !availableSections.some(section => section.id === selectedSectionId)))} onPress={() => create.mutate()} /><Button title="Cancel" disabled={create.isPending} variant="plain" onPress={onClose} />
    </>}
  </Card>;
}

export function AcademicScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const query = useQuery({ queryKey: ['academic', role], queryFn: () => edumatchApi.academic(role), staleTime: 30_000 });
  return <Screen title="Academic monitoring" subtitle={role === 'student' ? 'Your school-reported progress and academic results.' : 'Review academic progress within your authorized school scope.'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <Notice message="Academic results and grade calculations come from the school's official records." />
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.data?.map(item => <ItemCard key={item.id} item={item}><DetailFields row={item.raw} fields={[
      { label: 'Average', keys: ['generalAverage', 'overallAverage', 'average', 'gradeAverage'] },
      { label: 'Final grade', keys: ['finalGrade', 'grade', 'gradeValue'] }, { label: 'Students', keys: ['studentCount', 'totalStudents', 'studentsCount'] },
      { label: 'Passed', keys: ['passed', 'passCount', 'passedCount'] }, { label: 'Needs attention', keys: ['failed', 'failCount', 'failedCount', 'riskLevel'] },
      { label: 'Attendance', keys: ['attendanceRate'] }, { label: 'Progress', keys: ['progressPercent'] },
    ]} /></ItemCard>)}
    {query.isSuccess && !query.data.length ? <Empty title="No academic results yet" detail="Your school will publish academic progress here as records become available." /> : null}
  </Screen>;
}

export function ApprovalsScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const client = useQueryClient();
  const [selected, setSelected] = useState<Approval | null>(null);
  const [note, setNote] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const canReview = role === 'admin' || role === 'teacher';
  const query = useQuery({ queryKey: ['approvals', role], queryFn: () => edumatchApi.approvals(role), staleTime: 20_000 });
  const review = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => edumatchApi.reviewApproval(role, selected!, decision, note.trim() || undefined, confirmation.trim() || undefined),
    onSuccess: async () => { setSelected(null); setNote(''); setConfirmation(''); setMessage('The request decision has been saved.'); await Promise.all([client.invalidateQueries({ queryKey: ['approvals'] }), client.invalidateQueries({ queryKey: ['dashboard'] }), client.invalidateQueries({ queryKey: ['subjects'] })]); },
  });
  function choose(item: Approval) { setSelected(item); setNote(''); setConfirmation(''); review.reset(); setMessage(''); }
  function decide(decision: 'approved' | 'rejected') {
    confirmAction(decision === 'approved' ? 'Approve this request?' : 'Reject this request?', selected?.title || '', decision === 'approved' ? 'Approve' : 'Reject', () => review.mutate(decision), decision === 'rejected');
  }
  return <Screen title={canReview ? 'Approvals' : 'Request status'} subtitle={canReview ? 'Review each request before making a decision.' : 'Track decisions on your authorized requests.'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    {message ? <Notice message={message} tone="success" /> : null}
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {selected ? <Card><Heading title="Review request" /><Text style={styles.heading}>{selected.title}</Text><Text style={styles.body}>{selected.subtitle}</Text>{selected.description ? <Text style={styles.body}>{selected.description}</Text> : null}
      <DetailFields row={selected.raw} fields={[{ label: 'Request type', keys: ['action', 'requestType', 'type'] }, { label: 'Account', keys: ['studentEmail', 'email', 'requesterEmail'] }]} />
      <Field label="Decision note" placeholder="Explain your decision (optional)" value={note} onChangeText={setNote} multiline />
      {selected.kind === 'account' && selected.action === 'delete' ? <Field label="Type the student's email to confirm deletion" placeholder={selected.studentEmail || 'Student email address'} value={confirmation} onChangeText={setConfirmation} autoCapitalize="none" keyboardType="email-address" /> : null}
      {review.error ? <Notice message={errorMessage(review.error)} tone="error" /> : null}
      <View style={styles.row}><View style={{ flex: 1 }}><Button title="Approve" onPress={() => decide('approved')} loading={review.isPending} /></View><View style={{ flex: 1 }}><Button title="Reject" onPress={() => decide('rejected')} disabled={review.isPending} variant="danger" /></View></View>
      <Button title="Close review" variant="plain" disabled={review.isPending} onPress={() => setSelected(null)} /></Card> : null}
    {query.data?.map(item => <ItemCard key={`${item.kind}-${item.id}`} item={item}><Badge label={`${item.kind} request`} />{canReview && (!item.status || /pending|requested/i.test(item.status)) ? <Button title="Review request" variant="secondary" onPress={() => choose(item)} /> : null}</ItemCard>)}
    {query.isSuccess && !query.data.length ? <Empty title="All caught up" detail="There are no requests to show." /> : null}
  </Screen>;
}

export function GradesScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const client = useQueryClient();
  const [selected, setSelected] = useState<ResourceItem | null>(null);
  const [score, setScore] = useState('');
  const [feedback, setFeedback] = useState('');
  const [message, setMessage] = useState('');
  const query = useQuery({ queryKey: ['grades', role], queryFn: () => edumatchApi.grades(role), staleTime: 20_000 });
  const save = useMutation({
    mutationFn: (action: 'grade' | 'return_for_revision') => edumatchApi.reviewGrade({ assessmentId: rawText(selected!.raw, ['assessmentId']), submissionId: selected!.id, action, gradeValue: action === 'grade' ? Number(score) : undefined, teacherFeedback: feedback.trim() || undefined }),
    onSuccess: async () => { setMessage('Your review has been saved to the official grade record.'); setSelected(null); await Promise.all([client.invalidateQueries({ queryKey: ['grades'] }), client.invalidateQueries({ queryKey: ['academic'] })]); },
  });
  function select(item: ResourceItem) { setSelected(item); setScore(rawText(item.raw, ['gradeValue', 'score'])); setFeedback(rawText(item.raw, ['teacherFeedback'])); save.reset(); setMessage(''); }
  return <Screen title="Grades & feedback" subtitle={role === 'teacher' ? 'Review submissions and save scores to EduMatch.' : 'Results and feedback from your official school records.'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <Notice message="EduMatch calculates grades on the server using the school's grading rules." />
    {message ? <Notice message={message} tone="success" /> : null}
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {selected ? <Card><Heading title="Review submission" /><Text style={styles.body}>{selected.title} · {selected.subtitle}</Text>
      <DetailFields row={selected.raw} fields={[{ label: 'Available points', keys: ['activityPoints', 'totalPoints'] }, { label: 'Assessment', keys: ['assessmentMode'] }]} />
      <Field label="Awarded points" value={score} onChangeText={setScore} placeholder="Enter the score" keyboardType="decimal-pad" />
      <Field label="Teacher feedback" value={feedback} onChangeText={setFeedback} placeholder="Feedback is required when returning for revision" multiline />
      {save.error ? <Notice message={errorMessage(save.error)} tone="error" /> : null}
      <Button title="Save grade" loading={save.isPending} disabled={!score.trim() || !Number.isFinite(Number(score))} onPress={() => save.mutate('grade')} />
      <Button title="Return for revision" variant="secondary" disabled={save.isPending || !feedback.trim()} onPress={() => save.mutate('return_for_revision')} />
      <Button title="Close review" variant="plain" disabled={save.isPending} onPress={() => setSelected(null)} /></Card> : null}
    {query.data?.map(item => <ItemCard key={item.id} item={item}><DetailFields row={item.raw} fields={[
      { label: 'Student', keys: ['studentName'] }, { label: 'Subject', keys: ['subject', 'subjectName'] }, { label: 'Awarded points', keys: ['gradeValue', 'score'] },
      { label: 'Available points', keys: ['activityPoints', 'totalPoints'] }, { label: 'Percentage', keys: ['percentage'] }, { label: 'Final grade', keys: ['finalGrade', 'grade'] },
    ]} />
      {role === 'teacher' && rawText(item.raw, ['assessmentId']) ? <Button title="Review submission" variant="secondary" onPress={() => select(item)} /> : null}</ItemCard>)}
    {query.isSuccess && !query.data.length ? <Empty title="No grades yet" detail={role === 'teacher' ? 'Submitted assessments will appear here for review.' : 'Your published assessment results will appear here.'} /> : null}
  </Screen>;
}

export function AnnouncementsScreen() {
  const { user } = useAuth();
  const role = user!.role;
  const client = useQueryClient();
  const canPublish = role !== 'student';
  const [compose, setCompose] = useState(false);
  const [target, setTarget] = useState('');
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [message, setMessage] = useState('');
  const requestId = useRef(`mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const query = useQuery({ queryKey: ['announcements', role], queryFn: () => edumatchApi.announcements(role), staleTime: 20_000 });
  const targets = useQuery({ queryKey: ['announcement-targets', role], enabled: canPublish && compose,
    queryFn: async () => role === 'teacher' ? (await edumatchApi.subjects(role)).map(s => ({ id: s.id, name: s.name, detail: s.className })) : (await edumatchApi.users(role, role === 'headteacher' ? { role: 'teacher' } : undefined)).map(u => ({ id: u.id, name: u.name, detail: u.email })),
  });
  const publish = useMutation({
    mutationFn: () => edumatchApi.publishAnnouncement(role, target, { title: title.trim(), content: content.trim(), urgent, requestId: requestId.current }),
    onSuccess: async () => { setMessage('Your message has been published.'); setCompose(false); setTitle(''); setContent(''); setTarget(''); setUrgent(false); requestId.current = `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`; await client.invalidateQueries({ queryKey: ['announcements'] }); },
  });
  const visibleTargets = targets.data?.filter(t => `${t.name} ${t.detail}`.toLowerCase().includes(search.toLowerCase())).slice(0, 30) || [];
  return <Screen title="Announcements" subtitle="Stay connected with updates from your school." refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    {message ? <Notice message={message} tone="success" /> : null}
    {canPublish && !compose ? <Button title={role === 'teacher' ? 'Publish to a subject' : 'Send a message'} icon="create-outline" onPress={() => { setCompose(true); publish.reset(); setMessage(''); }} /> : null}
    {compose ? <Card><Heading title={role === 'teacher' ? 'Subject announcement' : 'New message'} /><Field label={role === 'teacher' ? 'Find a subject' : 'Find a recipient'} value={search} onChangeText={setSearch} placeholder="Search by name" />
      <QueryStatus loading={targets.isPending} error={targets.error} retry={() => void targets.refetch()} />
      <View style={styles.chipRow}>{visibleTargets.map(t => <Chip key={t.id} label={`${t.name}${t.detail ? ` · ${t.detail}` : ''}`} active={target === t.id} onPress={() => setTarget(t.id)} />)}</View>
      {targets.isSuccess && !visibleTargets.length ? <Text style={styles.bodyMuted}>No matching recipients are available.</Text> : null}
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Announcement title" maxLength={180} />
      <Field label="Message" value={content} onChangeText={setContent} placeholder="Write your school update" multiline />
      {role !== 'teacher' ? <Chip label={urgent ? 'Urgent message ✓' : 'Mark as urgent'} active={urgent} onPress={() => setUrgent(!urgent)} /> : null}
      {publish.error ? <Notice message={errorMessage(publish.error)} tone="error" /> : null}
      <Button title="Publish message" loading={publish.isPending} disabled={!target || !title.trim() || !content.trim()} onPress={() => publish.mutate()} />
      <Button title="Cancel" disabled={publish.isPending} variant="plain" onPress={() => setCompose(false)} /></Card> : null}
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {query.data?.map(item => <ItemCard key={item.id} item={item} />)}
    {query.isSuccess && !query.data.length ? <Empty title="No announcements yet" detail="School updates and subject messages will appear here." /> : null}
  </Screen>;
}

export function NotificationsScreen() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['notifications'], queryFn: () => notificationApi.list(), staleTime: 10_000 });
  const mark = useMutation({ mutationFn: (id: string) => notificationApi.markViewed(id), onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  return <Screen title="Notifications" subtitle={query.data ? `${query.data.unreadCount} unread · Updates from your school` : 'Updates from your school'} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
    <QueryStatus loading={query.isPending} error={query.error} retry={() => void query.refetch()} />
    {mark.error ? <Notice message={errorMessage(mark.error)} tone="error" /> : null}
    {query.data?.notifications.map(item => <Card key={item.id}><View style={styles.between}><Text style={[styles.heading, { flex: 1 }]}>{item.title || item.subject || 'School update'}</Text><Badge label={item.urgent ? 'Urgent' : item.isViewed ? 'Read' : 'New'} /></View>
      <Text style={styles.body}>{item.message || item.preview}</Text>{item.senderName ? <Text style={styles.bodyMuted}>From {item.senderName}</Text> : null}<Text style={styles.smallLabel}>{displayDate(item.createdAt)}</Text>
      {!item.isViewed ? <Button title="Mark as read" variant="secondary" loading={mark.isPending && mark.variables === item.id} disabled={mark.isPending} onPress={() => mark.mutate(item.id)} /> : null}</Card>)}
    {query.isSuccess && !query.data.notifications.length ? <Empty title="You're up to date" detail="New notifications will appear here." /> : null}
  </Screen>;
}
