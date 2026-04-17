function errorHandler(err, req, res, next) {
  const status = Number(err.status || err.statusCode || 500);
  const code = Number.isInteger(err.code) ? err.code : status;
  const message = err.message || "服务器内部错误";

  if (status >= 500) {
    console.error("[UnhandledError]", err);
  }

  res.status(status).json({
    code,
    message
  });
}

module.exports = {
  errorHandler
};
