const {
  DEFAULT_CAPTURE_WAIT,
  DEVICE_PRESETS
} = require("../config/capture.config");
const { toBoundedInt } = require("./validator.util");

function resolveCaptureOptions(input = {}) {
  const deviceRaw = (input.device || "pc").toString().toLowerCase();
  const preset = DEVICE_PRESETS[deviceRaw];
  if (!preset) {
    throw new Error("device 仅支持 pc 或 mobile");
  }

  const width = toBoundedInt(input.width, { min: 200, max: 3000 }) ?? preset.width;
  const height = toBoundedInt(input.height, { min: 200, max: 4000 }) ?? preset.height;
  const waitMs = toBoundedInt(input.waitMs ?? input.wait, { min: 0, max: 20000 }) ?? DEFAULT_CAPTURE_WAIT;
  const readySelectorRaw = input.readySelector ?? input.ready_selector ?? input.selector ?? null;
  const readySelector = typeof readySelectorRaw === "string" ? readySelectorRaw.trim() : "";
  if (readySelector.length > 200) {
    throw new Error("readySelector 不能超过 200 个字符");
  }

  return {
    device: deviceRaw,
    width,
    height,
    waitMs,
    readySelector: readySelector || null,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
    deviceScaleFactor: preset.deviceScaleFactor,
    userAgent: preset.userAgent
  };
}

module.exports = {
  resolveCaptureOptions
};
