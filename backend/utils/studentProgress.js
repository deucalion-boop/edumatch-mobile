const Submission = require('../models/Submission');
const User = require('../models/User');

function toSafePercentage(score, totalPoints) {
  const safeScore = Number(score || 0);
  const safeTotal = Number(totalPoints || 0);
  if (safeTotal <= 0) return 0;
  const percentage = (safeScore / safeTotal) * 100;
  if (!Number.isFinite(percentage)) return 0;
  return Math.max(0, Math.min(100, percentage));
}

function computeMasteryFromSubmissions(submissions) {
  const rows = Array.isArray(submissions) ? submissions : [];
  const latestByAssessment = new Map();

  rows
    .sort((a, b) => new Date(b?.submittedAt || b?.createdAt || 0).getTime() - new Date(a?.submittedAt || a?.createdAt || 0).getTime())
    .forEach((row) => {
      const assessmentId = String(row?.assessmentId || row?.assessmentId?._id || '').trim();
      if (!assessmentId) return;
      if (!latestByAssessment.has(assessmentId)) {
        latestByAssessment.set(assessmentId, row);
      }
    });

  const percentages = [...latestByAssessment.values()]
    .filter((row) => Number(row?.totalPoints || 0) > 0)
    .map((row) => toSafePercentage(row?.score, row?.totalPoints));
  const completedAssessments = percentages.length;
  const averageScore = completedAssessments > 0
    ? Number((percentages.reduce((sum, value) => sum + value, 0) / completedAssessments).toFixed(2))
    : 0;

  return {
    masteryProgress: Math.round(averageScore),
    averageScore,
    completedAssessments,
    lastCalculatedAt: new Date(),
  };
}

async function recalculateStudentMasteryProgress(studentId) {
  const normalizedStudentId = String(studentId || '').trim();
  if (!normalizedStudentId) {
    return {
      masteryProgress: 0,
      averageScore: 0,
      completedAssessments: 0,
      lastCalculatedAt: new Date(),
    };
  }

  const submissions = await Submission.find({ studentId: normalizedStudentId })
    .select('assessmentId score totalPoints submittedAt createdAt')
    .lean();

  const computed = computeMasteryFromSubmissions(submissions);

  await User.updateOne(
    { _id: normalizedStudentId },
    {
      $set: {
        'enrollment.progress.masteryProgress': computed.masteryProgress,
        'enrollment.progress.averageScore': computed.averageScore,
        'enrollment.progress.completedAssessments': computed.completedAssessments,
        'enrollment.progress.lastCalculatedAt': computed.lastCalculatedAt,
      },
    }
  );

  return computed;
}

module.exports = {
  computeMasteryFromSubmissions,
  recalculateStudentMasteryProgress,
};
