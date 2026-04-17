function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = Number.isInteger(code) ? code : status;
  return error;
}

module.exports = {
  createHttpError
};
