function notFoundMiddleware(req, _res, next) {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

function errorMiddleware(error, _req, res, _next) {
  const normalizedStatusCode = Number.parseInt(error?.statusCode, 10);
  let statusCode = Number.isInteger(normalizedStatusCode) ? normalizedStatusCode : 500;
  if (!error.statusCode && error?.name === 'ValidationError') {
    statusCode = 400;
  }
  const details = {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode,
    stack: error.stack,
    errors: error.errors,
  };

  console.error('[ERROR]', details);

  return res.status(statusCode).json({
    success: false,
    message: error.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? details : undefined,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  });
}

module.exports = {
  notFoundMiddleware,
  errorMiddleware,
};
