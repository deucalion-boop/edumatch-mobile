'use strict';

const { assertRole, fail } = require('./errors');

// Existing controllers keep their permission checks and server grade formulas.
function invokeController(controller, req) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = { status(code) { status = code; return this; }, json(value) {
      if (status >= 400) reject(fail(value.message || 'Dashboard unavailable', status));
      else resolve(value);
      return this;
    } };
    const scopedRequest = Object.create(req);
    Object.defineProperties(scopedRequest, {
      query: { value: {}, writable: true }, params: { value: {}, writable: true }, body: { value: {}, writable: true },
    });
    Promise.resolve(controller(scopedRequest, response, reject)).catch(reject);
  });
}

function createDashboardService(controllers) {
  return async function dashboard(req) {
    assertRole(req.user, 'admin', 'secretary', 'headteacher', 'teacher', 'student');
    const metric = (label, value) => ({ label, value: Number(value || 0) });
    const role = req.user.role;
    if (role === 'teacher') {
      const [subjects, requests] = await Promise.all([
        invokeController(controllers.teacher.getTeacherSubjects, req),
        invokeController(controllers.teacher.getEnrollmentRequests, req),
      ]);
      return { metrics: [metric('Classes', subjects.subjects?.length),
        metric('Approved enrollments', subjects.subjects?.reduce((sum, subject) => sum + Number(subject.approvedStudentsCount || 0), 0)),
        metric('Enrollment requests', requests.requests?.length)],
        capabilities: ['classes', 'announcements', 'grading', 'enrollment-approvals', 'attendance-qr', 'attendance-finalize'] };
    }
    if (role === 'student') {
      const [subjects, notifications] = await Promise.all([
        invokeController(controllers.student.getMySubjects, req),
        invokeController(controllers.notifications.getMyNotifications, req),
      ]);
      return { metrics: [metric('Subjects', subjects.subjects?.length), metric('Pending enrollments', subjects.pendingSubjects?.length),
        metric('Unread notifications', notifications.unreadCount)],
        insights: subjects.insights || {}, capabilities: ['subjects', 'lessons', 'activities', 'grades', 'attendance-scan', 'announcements'] };
    }
    if (role === 'headteacher') {
      const teachers = await invokeController(controllers.headteacher.getManagedTeachers, req);
      return { metrics: [metric('Managed teachers', teachers.teachers?.length),
        metric('Active teachers', teachers.teachers?.filter((teacher) => teacher.status === 'active').length)],
        capabilities: ['managed-teachers', 'academic-monitoring', 'attendance-overview', 'management-announcements'] };
    }
    if (role === 'secretary') {
      const [students, directory] = await Promise.all([
        invokeController(controllers.secretary.getStudentRecords, req),
        invokeController(controllers.secretary.getDirectory, req),
      ]);
      return { metrics: [metric('Student records', students.students?.length), metric('Directory members', directory.users?.length)],
        capabilities: ['directory', 'records', 'archives', 'export-requests', 'attendance-overview'] };
    }
    const [users, requests] = await Promise.all([
      invokeController(controllers.admin.getUsers, req),
      invokeController(controllers.admin.getArchivedPdfExportRequests, req),
    ]);
    return { metrics: [metric('Accounts', users.users?.length), metric('Active accounts', users.users?.filter((user) => user.status === 'active').length),
      metric('Pending export approvals', requests.requests?.filter((request) => request.status === 'pending').length)],
      capabilities: ['accounts', 'approvals', 'audit', 'academic-monitoring', 'attendance-report', 'announcements', 'settings'] };
  };
}

module.exports = { createDashboardService, invokeController };
