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

// 简易并发控制：active + queue
let activeCaptures = 0;
const pendingCaptures = [];

// 业务错误码（用于前端/调用方识别限流类型）
const CAPTURE_ERROR_CODE = {
  queueFull: 42901,
  queueTimeout: 42902
};

function isTimeoutError(error) {
  return error?.name === "TimeoutError";
}

function createCaptureError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function resolveBoundedEnvInt(name, fallback, { min = 1, max = 60000 } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < min || integer > max) return fallback;
  return integer;
}

// 并发上限：默认值来自配置，可由环境变量覆盖
function resolveCaptureConcurrency() {
  return resolveBoundedEnvInt("CAPTURE_MAX_CONCURRENCY", DEFAULT_CAPTURE_CONCURRENCY, {
    min: 1,
    max: 20
  });
}

// 队列上限：超过后直接拒绝，避免无限堆积
function resolveCaptureMaxQueue() {
  return resolveBoundedEnvInt("CAPTURE_MAX_QUEUE", DEFAULT_CAPTURE_MAX_QUEUE, {
    min: 0,
    max: 5000
  });
}

// 队列等待超时：避免请求无限等待
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

function readConsoleText(message) {
  if (!message || typeof message.text !== "function") return "";
  return message.text();
}

async function acquireCaptureSlot() {
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

async function getReusableBrowser() {
  const chromium = getPlaywrightChromium();
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }

  let browser;
  try {
    browser = await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }

  if (!browser.isConnected()) {
    // 断连后自动拉起新实例，保证后续请求可继续服务
    browserPromise = chromium.launch({ headless: true });
    browser = await browserPromise;
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

  // 1) 业务显式信号：调用方可在页面中主动设置 window.__REZONA_CAPTURE_READY__ = true
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

  // 2) 兼容老游戏：若页面存在 assetsReady，则优先等待其为 true
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

  // 3) 用户指定 readySelector 时，等待该元素可见
  if (readySelector) {
    await page.waitForSelector(readySelector, {
      state: "visible",
      timeout: remaining()
    });
    return;
  }

  // 4) 最后兜底：等待网络空闲
  await page.waitForLoadState("networkidle", {
    timeout: Math.min(remaining(), networkIdleTimeout)
  });
}

async function captureByCdp(page) {
  const context = page.context();
  const cdpSession = await context.newCDPSession(page);
  try {
    const result = await cdpSession.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    return Buffer.from(result.data, "base64");
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

async function takeScreenshot(page) {
  const screenshotTimeout = resolveBoundedEnvInt(
    "CAPTURE_SCREENSHOT_TIMEOUT",
    DEFAULT_SCREENSHOT_TIMEOUT
  );
  const engine = (process.env.CAPTURE_SCREENSHOT_ENGINE || "cdp").toLowerCase();

  // 优先 CDP 直出，失败再回退 Playwright screenshot
  if (engine === "cdp") {
    try {
      return await captureByCdp(page);
    } catch {
      // fallback to Playwright screenshot
    }
  }

  try {
    return await page.screenshot({
      type: "png",
      scale: "css",
      timeout: screenshotTimeout
    });
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
    return await captureByCdp(page);
  }
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

  const navigationTimeout = resolveBoundedEnvInt(
    "CAPTURE_NAVIGATION_TIMEOUT",
    DEFAULT_NAVIGATION_TIMEOUT
  );
  const consoleLogLimit = resolveConsoleLogLimit();
  const consoleLogs = [];

  let context;

  try {
    const browser = await getReusableBrowser();

    // 请求级隔离：每次截图使用独立 context/page，避免状态互相污染
    context = await browser.newContext({
      viewport: { width, height },
      isMobile,
      hasTouch,
      deviceScaleFactor,
      userAgent
    });

    const page = await context.newPage();
    page.on("console", (message) => {
      if (consoleLogs.length >= consoleLogLimit) return;
      try {
        consoleLogs.push(readConsoleText(message));
      } catch {
        // 日志采集失败不应影响截图主流程
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout
    });

    await waitCaptureReady(page, { readySelector });

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const fileName = `cover-${device}-${width}x${height}-${Date.now()}-${randomUUID()}.png`;
    const imageBuffer = await takeScreenshot(page);

    return {
      fileName,
      imageBuffer,
      imageSize: readPngDimensionsFromBuffer(imageBuffer),
      consoleLogs
    };
  } finally {
    if (context) {
      // 只关闭 context，不关闭 browser（browser 由单例复用）
      await context.close();
    }
    releaseCaptureSlot();
  }
}

module.exports = {
  captureCover
};
