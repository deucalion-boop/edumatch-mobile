function sendSuccess(res, statusCode, message, data = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    ...data,
  });
}

function sendError(res, statusCode, message, details = null) {
  const payload = {
    success: false,
    message,
  };

  if (details) {
    payload.details = details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  sendSuccess,
  sendError,
};
