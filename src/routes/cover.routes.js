const express = require("express");
const {
  createScreenshot,
  renderCoverPreview
} = require("../controllers/cover.controller");

const router = express.Router();

router.get("/cover-preview", renderCoverPreview);
router.get("/covers/screenshot", createScreenshot);
router.post("/covers/screenshot", createScreenshot);

module.exports = router;
