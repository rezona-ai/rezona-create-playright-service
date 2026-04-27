const express = require("express");
const { errorHandler } = require("./middlewares/error-handler.middleware");
const { notFoundHandler } = require("./middlewares/not-found.middleware");
const routes = require("./routes");

const app = express();

app.use(express.json());
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
