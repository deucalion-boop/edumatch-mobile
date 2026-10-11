const { createProfileHandlers } = require('./selfProfileController');

const { getProfile: getAdminProfile, updateProfile: updateAdminProfile } = createProfileHandlers({ requiredRole: 'admin' });

module.exports = { getAdminProfile, updateAdminProfile };
