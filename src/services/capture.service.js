const { randomUUID } = require("node:crypto");
const {
  DEFAULT_NAVIGATION_TIMEOUT,
  DEFAULT_READY_TIMEOUT,
  DEFAULT_SCREENSHOT_TIMEOUT,
  DEFAULT_CAPTURE_CONCURRENCY,
  DEFAULT_CAPTURE_MAX_QUEUE,
  DEFAULT_CAPTURE_QUEUE_WAIT_TIMEOUT_MS
} = require("../config/capture.config");
const { readPngDimensionsFromBuffer } = require("../utils/png.util");

// Browser 级单例：同一 Node 进程内复用 Chromium，避免每次冷启动
let browserPromise = null;
let browserStartedAtMs = 0;
let capturesOnCurrentBrowser = 0;

// 简易并发控制：active + queue
let activeCaptures = 0;
const pendingCaptures = [];

// 服务排空标记：用于优雅停机时拒绝新任务
let isDraining = false;

// 运行时异常计数：连续超时/卡死后触发 browser 重建
let consecutiveRuntimeTimeouts = 0;

// 业务错误码（用于前端/调用方识别限流类型）
const CAPTURE_ERROR_CODE = {
  queueFull: 42901,
  queueTimeout: 42902,
  serviceDraining: 50301,
  hardTimeout: 50401,
  stepTimeout: 50402
};

function isTimeoutError(error) {
  return error?.name === "TimeoutError";
}

function isStepTimeoutError(error) {
  return error?.name === "CaptureStepTimeoutError";
}

function createCaptureError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function createStepTimeoutError(scope, timeoutMs) {
  const error = createCaptureError(
    504,
    CAPTURE_ERROR_CODE.stepTimeout,
    `截图阶段超时: ${scope} 超过 ${timeoutMs}ms`
  );
  error.name = "CaptureStepTimeoutError";
  error.scope = scope;
  return error;
}

function resolveBoundedEnvInt(name, fallback, { min = 1, max = 60000 } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < min || integer > max) return fallback;
  return integer;
}

function resolveCaptureConcurrency() {
  return resolveBoundedEnvInt("CAPTURE_MAX_CONCURRENCY", DEFAULT_CAPTURE_CONCURRENCY, {
    min: 1,
    max: 20
  });
}

function resolveCaptureMaxQueue() {
  return resolveBoundedEnvInt("CAPTURE_MAX_QUEUE", DEFAULT_CAPTURE_MAX_QUEUE, {
    min: 0,
    max: 5000
  });
}

function resolveCaptureQueueWaitTimeout() {
  return resolveBoundedEnvInt(
    "CAPTURE_QUEUE_WAIT_TIMEOUT_MS",
    DEFAULT_CAPTURE_QUEUE_WAIT_TIMEOUT_MS,
    { min: 100, max: 600000 }
  );
}

function resolveConsoleLogLimit() {
  return resolveBoundedEnvInt("CAPTURE_CONSOLE_LOG_LIMIT", 3000, {
    min: 100,
    max: 100000
  });
}

function resolveCaptureHardTimeout() {
  return resolveBoundedEnvInt("CAPTURE_HARD_TIMEOUT_MS", 60000, {
    min: 5000,
    max: 600000
  });
}

function resolveCaptureStageTimeout() {
  return resolveBoundedEnvInt("CAPTURE_STAGE_TIMEOUT_MS", 20000, {
    min: 500,
    max: 180000
  });
}

function resolveCaptureContextCloseTimeout() {
  return resolveBoundedEnvInt("CAPTURE_CONTEXT_CLOSE_TIMEOUT_MS", 5000, {
    min: 200,
    max: 60000
  });
}

function resolveBrowserLaunchTimeout() {
  return resolveBoundedEnvInt("CAPTURE_BROWSER_LAUNCH_TIMEOUT_MS", 20000, {
    min: 1000,
    max: 120000
  });
}

function resolveBrowserCloseTimeout() {
  return resolveBoundedEnvInt("CAPTURE_BROWSER_CLOSE_TIMEOUT_MS", 8000, {
    min: 500,
    max: 120000
  });
}

function resolveBrowserRecycleEveryCaptures() {
  return resolveBoundedEnvInt("CAPTURE_BROWSER_RECYCLE_EVERY", 500, {
    min: 1,
    max: 100000
  });
}

function resolveBrowserMaxAgeMs() {
  return resolveBoundedEnvInt("CAPTURE_BROWSER_MAX_AGE_MS", 30 * 60 * 1000, {
    min: 60 * 1000,
    max: 24 * 60 * 60 * 1000
  });
}

function resolveBrowserTimeoutThreshold() {
  return resolveBoundedEnvInt("CAPTURE_BROWSER_TIMEOUT_THRESHOLD", 3, {
    min: 1,
    max: 100
  });
}

function resolveHealthCheckTimeout() {
  return resolveBoundedEnvInt("CAPTURE_HEALTHCHECK_TIMEOUT_MS", 5000, {
    min: 500,
    max: 60000
  });
}

function readConsoleText(message) {
  if (!message || typeof message.text !== "function") return "";
  return message.text();
}

function createServiceDrainingError() {
  return createCaptureError(503, CAPTURE_ERROR_CODE.serviceDraining, "服务正在重启，请稍后重试");
}

function withTimeout(promise, timeoutMs, scope) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createStepTimeoutError(scope, timeoutMs));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function resolveRemaining(deadlineMs) {
  return Math.max(deadlineMs - Date.now(), 0);
}

function rejectPendingCaptures(errorFactory) {
  while (pendingCaptures.length > 0) {
    const item = pendingCaptures.shift();
    if (!item || item.done) continue;
    item.reject(errorFactory());
  }
}

function setCaptureServiceDraining(value = true) {
  isDraining = Boolean(value);
  if (isDraining) {
    rejectPendingCaptures(() => createServiceDrainingError());
  }
}

function getCaptureRuntimeState() {
  return {
    draining: isDraining,
    activeCaptures,
    pendingCaptures: pendingCaptures.length,
    hasBrowserInstance: Boolean(browserPromise),
    capturesOnCurrentBrowser,
    consecutiveRuntimeTimeouts
  };
}

async function acquireCaptureSlot() {
  if (isDraining) {
    throw createServiceDrainingError();
  }

  const maxConcurrency = resolveCaptureConcurrency();
  if (activeCaptures < maxConcurrency) {
    activeCaptures += 1;
    return;
  }

  const maxQueue = resolveCaptureMaxQueue();
  if (pendingCaptures.length >= maxQueue) {
    throw createCaptureError(429, CAPTURE_ERROR_CODE.queueFull, "截图任务过多，请稍后重试");
  }

  const queueWaitTimeout = resolveCaptureQueueWaitTimeout();

  await new Promise((resolve, reject) => {
    const item = {
      done: false,
      resolve: () => {
        if (item.done) return;
        item.done = true;
        clearTimeout(item.timer);
        resolve();
      },
      reject: (error) => {
        if (item.done) return;
        item.done = true;
        clearTimeout(item.timer);
        const index = pendingCaptures.indexOf(item);
        if (index >= 0) pendingCaptures.splice(index, 1);
        reject(error);
      },
      timer: null
    };

    item.timer = setTimeout(() => {
      item.reject(
        createCaptureError(429, CAPTURE_ERROR_CODE.queueTimeout, "截图排队超时，请稍后重试")
      );
    }, queueWaitTimeout);

    pendingCaptures.push(item);
  });

  if (isDraining) {
    // 从队列被唤醒时可能已经进入排空，主动归还槽位并拒绝请求
    releaseCaptureSlot();
    throw createServiceDrainingError();
  }
}

function releaseCaptureSlot() {
  activeCaptures = Math.max(activeCaptures - 1, 0);

  while (pendingCaptures.length > 0) {
    const item = pendingCaptures.shift();
    if (!item || item.done) continue;
    activeCaptures += 1;
    item.resolve();
    return;
  }
}

function getPlaywrightChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    throw new Error(
      "未安装 playwright。请执行: npm i playwright && npx playwright install chromium"
    );
  }
}

async function forceRecycleBrowser(reason) {
  const previousPromise = browserPromise;
  browserPromise = null;
  browserStartedAtMs = 0;
  capturesOnCurrentBrowser = 0;

  if (!previousPromise) {
    return;
  }

  let browser;
  try {
    browser = await withTimeout(previousPromise, resolveBrowserLaunchTimeout(), "browser.await-recycle");
  } catch {
    return;
  }

  if (!browser || typeof browser.close !== "function") return;

  try {
    await withTimeout(browser.close(), resolveBrowserCloseTimeout(), "browser.close-recycle");
  } catch {
    // 回收失败只记录，不阻塞后续重建
  }

  console.warn(`[capture] browser recycled reason=${reason}`);
}

function shouldRecycleCurrentBrowser() {
  if (!browserStartedAtMs) return false;
  const byCount = capturesOnCurrentBrowser >= resolveBrowserRecycleEveryCaptures();
  const byAge = Date.now() - browserStartedAtMs >= resolveBrowserMaxAgeMs();
  return byCount || byAge;
}

async function launchReusableBrowser() {
  const chromium = getPlaywrightChromium();
  const launching = chromium.launch({ headless: true });
  browserPromise = launching;

  const browser = await withTimeout(launching, resolveBrowserLaunchTimeout(), "browser.launch");
  browserStartedAtMs = Date.now();
  capturesOnCurrentBrowser = 0;
  return browser;
}

async function getReusableBrowser() {
  if (!browserPromise) {
    return launchReusableBrowser();
  }

  let browser;
  try {
    browser = await withTimeout(browserPromise, resolveBrowserLaunchTimeout(), "browser.await");
  } catch (error) {
    browserPromise = null;
    throw error;
  }

  if (!browser.isConnected()) {
    browserPromise = null;
    return launchReusableBrowser();
  }

  if (shouldRecycleCurrentBrowser()) {
    await forceRecycleBrowser("periodic-recycle");
    return launchReusableBrowser();
  }

  return browser;
}

async function waitCaptureReady(page, { readySelector }) {
  const readyTimeout = resolveBoundedEnvInt("CAPTURE_READY_TIMEOUT", DEFAULT_READY_TIMEOUT);
  const flagProbeTimeout = resolveBoundedEnvInt("CAPTURE_FLAG_PROBE_TIMEOUT", 2000);
  const assetsReadyProbeTimeout = resolveBoundedEnvInt(
    "CAPTURE_ASSETS_READY_PROBE_TIMEOUT",
    1500
  );
  const assetsReadyTimeout = resolveBoundedEnvInt(
    "CAPTURE_ASSETS_READY_TIMEOUT",
    readyTimeout
  );
  const networkIdleTimeout = resolveBoundedEnvInt(
    "CAPTURE_NETWORKIDLE_TIMEOUT",
    readyTimeout
  );

  const deadline = Date.now() + readyTimeout;
  const remaining = () => Math.max(deadline - Date.now(), 1);

  const probeTimeout = Math.min(remaining(), flagProbeTimeout);
  if (probeTimeout > 1) {
    try {
      await page.waitForFunction(() => window.__REZONA_CAPTURE_READY__ === true, null, {
        timeout: probeTimeout
      });
      return;
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }
    }
  }

  let hasAssetsReady = false;
  const assetsProbeTimeout = Math.min(remaining(), assetsReadyProbeTimeout);
  if (assetsProbeTimeout > 1) {
    try {
      await page.waitForFunction(() => typeof window.assetsReady !== "undefined", null, {
        timeout: assetsProbeTimeout
      });
      hasAssetsReady = true;
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }
    }
  }
  if (!hasAssetsReady) {
    try {
      hasAssetsReady = await page.evaluate(() => typeof window.assetsReady !== "undefined");
    } catch {
      hasAssetsReady = false;
    }
  }
  if (hasAssetsReady) {
    try {
      await page.waitForFunction(() => window.assetsReady === true, null, {
        timeout: Math.min(remaining(), assetsReadyTimeout)
      });
      return;
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }
    }
  }

  if (readySelector) {
    await page.waitForSelector(readySelector, {
      state: "visible",
      timeout: remaining()
    });
    return;
  }

  await page.waitForLoadState("networkidle", {
    timeout: Math.min(remaining(), networkIdleTimeout)
  });
}

async function captureByCdp(page, { stageTimeoutMs, deadlineMs }) {
  const context = page.context();
  const remaining = resolveRemaining(deadlineMs);
  const timeoutMs = Math.max(1, Math.min(stageTimeoutMs, remaining));

  const cdpSession = await withTimeout(
    context.newCDPSession(page),
    timeoutMs,
    "context.newCDPSession"
  );
  try {
    const result = await withTimeout(
      cdpSession.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false
      }),
      timeoutMs,
      "cdp.captureScreenshot"
    );
    return Buffer.from(result.data, "base64");
  } finally {
    await withTimeout(cdpSession.detach(), Math.min(timeoutMs, 2000), "cdp.detach").catch(
      () => undefined
    );
  }
}

async function takeScreenshot(page, { stageTimeoutMs, deadlineMs }) {
  const screenshotTimeout = resolveBoundedEnvInt(
    "CAPTURE_SCREENSHOT_TIMEOUT",
    DEFAULT_SCREENSHOT_TIMEOUT
  );
  const engine = (process.env.CAPTURE_SCREENSHOT_ENGINE || "cdp").toLowerCase();

  if (engine === "cdp") {
    try {
      return await captureByCdp(page, { stageTimeoutMs, deadlineMs });
    } catch {
      // fallback to Playwright screenshot
    }
  }

  const remaining = resolveRemaining(deadlineMs);
  const timeoutMs = Math.max(1, Math.min(stageTimeoutMs, remaining));

  try {
    return await withTimeout(
      page.screenshot({
        type: "png",
        scale: "css",
        timeout: Math.min(screenshotTimeout, timeoutMs)
      }),
      timeoutMs,
      "page.screenshot"
    );
  } catch (error) {
    if (!isTimeoutError(error) && !isStepTimeoutError(error)) {
      throw error;
    }
    return captureByCdp(page, { stageTimeoutMs, deadlineMs });
  }
}

function normalizeCaptureError(error) {
  if (!error) return createCaptureError(500, 500, "截图失败");
  if (error.status && error.code) return error;
  if (isTimeoutError(error) || isStepTimeoutError(error)) {
    return createCaptureError(
      504,
      CAPTURE_ERROR_CODE.hardTimeout,
      error.message || "截图流程超时，请稍后重试"
    );
  }
  return error;
}

function createStageRunner(deadlineMs) {
  return async (scope, requestedTimeoutMs, task) => {
    const remaining = resolveRemaining(deadlineMs);
    if (remaining <= 0) {
      throw createCaptureError(
        504,
        CAPTURE_ERROR_CODE.hardTimeout,
        "截图流程超时，请稍后重试"
      );
    }

    const timeoutMs = Math.max(1, Math.min(remaining, requestedTimeoutMs));
    return withTimeout(Promise.resolve().then(task), timeoutMs, scope);
  };
}

async function captureCover({
  targetUrl,
  device,
  width,
  height,
  waitMs,
  readySelector,
  isMobile,
  hasTouch,
  deviceScaleFactor,
  userAgent
}) {
  await acquireCaptureSlot();

  const hardTimeoutMs = resolveCaptureHardTimeout();
  const stageTimeoutMs = resolveCaptureStageTimeout();
  const navigationTimeout = resolveBoundedEnvInt(
    "CAPTURE_NAVIGATION_TIMEOUT",
    DEFAULT_NAVIGATION_TIMEOUT
  );
  const consoleLogLimit = resolveConsoleLogLimit();
  const consoleLogs = [];

  const deadlineMs = Date.now() + hardTimeoutMs;
  const runStage = createStageRunner(deadlineMs);

  let context;

  try {
    const browser = await runStage("browser.get", stageTimeoutMs, () => getReusableBrowser());

    context = await runStage("browser.newContext", stageTimeoutMs, () =>
      browser.newContext({
        viewport: { width, height },
        isMobile,
        hasTouch,
        deviceScaleFactor,
        userAgent
      })
    );

    const page = await runStage("context.newPage", stageTimeoutMs, () => context.newPage());

    page.on("console", (message) => {
      if (consoleLogs.length >= consoleLogLimit) return;
      try {
        consoleLogs.push(readConsoleText(message));
      } catch {
        // 日志采集失败不应影响截图主流程
      }
    });

    await runStage("page.goto", navigationTimeout + 1000, () =>
      page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout
      })
    );

    await runStage("capture.waitReady", Math.max(stageTimeoutMs, DEFAULT_READY_TIMEOUT + 1000), () =>
      waitCaptureReady(page, { readySelector })
    );

    if (waitMs > 0) {
      await runStage("page.waitForTimeout", waitMs + 1000, () => page.waitForTimeout(waitMs));
    }

    const fileName = `cover-${device}-${width}x${height}-${Date.now()}-${randomUUID()}.png`;
    const imageBuffer = await runStage("capture.screenshot", stageTimeoutMs, () =>
      takeScreenshot(page, { stageTimeoutMs, deadlineMs })
    );

    capturesOnCurrentBrowser += 1;
    consecutiveRuntimeTimeouts = 0;

    return {
      fileName,
      imageBuffer,
      imageSize: readPngDimensionsFromBuffer(imageBuffer),
      consoleLogs
    };
  } catch (rawError) {
    const error = normalizeCaptureError(rawError);

    if (error.status === 504) {
      consecutiveRuntimeTimeouts += 1;
      if (consecutiveRuntimeTimeouts >= resolveBrowserTimeoutThreshold()) {
        await forceRecycleBrowser(`timeout-threshold-${consecutiveRuntimeTimeouts}`);
        consecutiveRuntimeTimeouts = 0;
      }
    }

    throw error;
  } finally {
    if (context) {
      const remaining = resolveRemaining(deadlineMs);
      const closeTimeoutMs = Math.max(
        1,
        Math.min(resolveCaptureContextCloseTimeout(), remaining > 0 ? remaining : 1000)
      );
      await withTimeout(context.close(), closeTimeoutMs, "context.close").catch(() => undefined);
    }
    releaseCaptureSlot();
  }
}

async function waitForCaptureIdle(timeoutMs) {
  const timeout = Number(timeoutMs);
  const deadlineMs = Date.now() + (Number.isFinite(timeout) && timeout > 0 ? timeout : 10000);

  while (activeCaptures > 0 && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function shutdownCaptureService({ timeoutMs = 15000 } = {}) {
  setCaptureServiceDraining(true);
  await waitForCaptureIdle(timeoutMs);
  await forceRecycleBrowser("shutdown");
}

async function checkCaptureRuntime() {
  if (isDraining) {
    throw createServiceDrainingError();
  }

  const timeoutMs = resolveHealthCheckTimeout();
  const browser = await withTimeout(getReusableBrowser(), timeoutMs, "health.browser");

  let context;
  try {
    context = await withTimeout(
      browser.newContext({ viewport: { width: 200, height: 200 } }),
      timeoutMs,
      "health.newContext"
    );
    const page = await withTimeout(context.newPage(), timeoutMs, "health.newPage");
    await withTimeout(page.goto("about:blank"), timeoutMs, "health.aboutBlank");
  } finally {
    if (context) {
      await withTimeout(context.close(), timeoutMs, "health.context.close").catch(() => undefined);
    }
  }

  return getCaptureRuntimeState();
}

module.exports = {
  CAPTURE_ERROR_CODE,
  captureCover,
  checkCaptureRuntime,
  getCaptureRuntimeState,
  setCaptureServiceDraining,
  shutdownCaptureService
};
