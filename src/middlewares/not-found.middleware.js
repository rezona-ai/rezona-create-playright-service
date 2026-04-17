const { createHttpError } = require("../utils/http-error.util");

function notFoundHandler(req, res, next) {
  next(createHttpError(404, "接口不存在"));
}

module.exports = {
  notFoundHandler
};
