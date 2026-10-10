const { sendSuccess } = require('../utils/responseHelper');
const { listSectionsWithAdvisers, normalizeSectionId } = require('../services/sectionService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const getSectionDirectory = asyncHandler(async (req, res) => {
  const sections = await listSectionsWithAdvisers();
  const advisorySectionId = normalizeSectionId(req.user?.advisorySectionId);
  const advisorySection = sections.find((section) => section.id === advisorySectionId) || null;

  return sendSuccess(res, 200, 'Sections fetched successfully', {
    sections,
    advisorySection,
  });
});

module.exports = {
  getSectionDirectory,
};
