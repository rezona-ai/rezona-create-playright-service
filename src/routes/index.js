const express = require("express");
const coverRoutes = require("./cover.routes");

const router = express.Router();

router.use(coverRoutes);

module.exports = router;
