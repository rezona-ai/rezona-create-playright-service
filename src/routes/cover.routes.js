const express = require("express");
const {
  createScreenshot,
  renderCoverPreview,
  getCaptureHealth,
  getCaptureRuntimeStateView
} = require("../controllers/cover.controller");

const router = express.Router();

router.get("/cover-preview", renderCoverPreview);
router.get("/healthz", getCaptureRuntimeStateView);
router.get("/healthz/capture", getCaptureHealth);
router.get("/covers/screenshot", createScreenshot);
router.post("/covers/screenshot", createScreenshot);

module.exports = router;
