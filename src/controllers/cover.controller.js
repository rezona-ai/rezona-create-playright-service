const { DEFAULT_TARGET_URL } = require("../config/capture.config");
const { captureCover } = require("../services/capture.service");
const { uploadToOss } = require("../services/storage.service");
const { resolveCaptureOptions } = require("../utils/capture-options.util");
const { createHttpError } = require("../utils/http-error.util");
const { getBaseUrl } = require("../utils/request.util");
const { parseHttpUrl } = require("../utils/validator.util");
const { getCoverPreviewHtml } = require("../views/cover-preview.view");

function resolveStorageType(req) {
  return (req.body?.storage || req.query.storage || "local")
    .toString()
    .toLowerCase();
}

function resolveTargetUrl(req) {
  return parseHttpUrl(req.body?.targetUrl || req.query.targetUrl || req.query.target);
}

function resolveOptionsFromRequest(req) {
  return resolveCaptureOptions({
    device: req.body?.device ?? req.query.device,
    width: req.body?.width ?? req.query.width,
    height: req.body?.height ?? req.query.height,
    waitMs: req.body?.waitMs ?? req.query.waitMs ?? req.body?.wait ?? req.query.wait,
    readySelector: req.body?.readySelector ?? req.query.readySelector
  });
}

async function createScreenshot(req, res, next) {
  const targetUrl = resolveTargetUrl(req);
  if (!targetUrl) {
    return next(createHttpError(400, "targetUrl 无效，必须是 http/https 地址"));
  }

  const storage = resolveStorageType(req);
  if (!["local", "oss"].includes(storage)) {
    return next(createHttpError(400, "storage 仅支持 local 或 oss"));
  }

  let captureOptions;
  try {
    captureOptions = resolveOptionsFromRequest(req);
  } catch (error) {
    return next(createHttpError(400, error.message));
  }

  try {
    const captureResult = await captureCover({
      targetUrl,
      ...captureOptions
    });

    let ossData = null;
    if (storage === "oss") {
      ossData = await uploadToOss(captureResult.localPath, captureResult.fileName);
    }

    return res.json({
      code: 0,
      message: "截图成功",
      data: {
        storage,
        device: captureOptions.device,
        width: captureOptions.width,
        height: captureOptions.height,
        waitMs: captureOptions.waitMs,
        readySelector: captureOptions.readySelector,
        targetUrl,
        fileName: captureResult.fileName,
        // storage=oss 时本地文件已立即清理，localPath 置 null 避免泄露容器内部路径；
        // previewUrl 在 OSS 模式下返回 OSS 公网 URL，保持 "可直接预览" 的契约语义，
        // 避免强迫老调用方按 storage 字段分支切换渲染路径
        localPath: storage === "oss" ? null : captureResult.localPath,
        previewUrl:
          storage === "oss"
            ? ossData?.url || null
            : `${getBaseUrl(req)}${captureResult.publicPath}`,
        imageWidth: captureResult.imageSize?.width || null,
        imageHeight: captureResult.imageSize?.height || null,
        ossObjectKey: ossData?.objectKey || null,
        ossUrl: ossData?.url || null
      }
    });
  } catch (error) {
    return next(error);
  }
}

function renderCoverPreview(req, res, next) {
  let captureOptions;
  try {
    captureOptions = resolveCaptureOptions({
      device: req.query.device,
      width: req.query.width,
      height: req.query.height,
      waitMs: req.query.waitMs ?? req.query.wait
    });
  } catch (error) {
    return next(createHttpError(400, error.message));
  }

  const targetUrl = parseHttpUrl(req.query.target) || DEFAULT_TARGET_URL;
  const captureMode = req.query.mode === "capture";

  res.set("Content-Type", "text/html; charset=utf-8");
  return res.send(
    getCoverPreviewHtml({
      targetUrl,
      captureMode,
      ...captureOptions
    })
  );
}

module.exports = {
  createScreenshot,
  renderCoverPreview
};
