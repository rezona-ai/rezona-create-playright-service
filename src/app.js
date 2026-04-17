const express = require("express");
const { SCREENSHOT_DIR, ensureScreenshotDir } = require("./config/capture.config");
const { errorHandler } = require("./middlewares/error-handler.middleware");
const { notFoundHandler } = require("./middlewares/not-found.middleware");
const routes = require("./routes");

ensureScreenshotDir();

const app = express();

app.use(express.json());
app.use("/screenshots", express.static(SCREENSHOT_DIR));
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
