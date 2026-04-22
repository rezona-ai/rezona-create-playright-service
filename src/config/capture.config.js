const fs = require("node:fs");
const path = require("node:path");

// 本地截图输出目录（HTTP 层会将该目录映射为可访问静态资源）
const SCREENSHOT_DIR = path.resolve(__dirname, "../../screenshots");

// 默认目标页（未传 targetUrl 时兜底）
const DEFAULT_TARGET_URL = "https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/ee04c02c-99b8-4c4f-a674-894c5df34a10/68e66781-fa27-4428-8975-a4bbe404ce2c/index.html";

// 截图前额外等待时长（毫秒）
const DEFAULT_CAPTURE_WAIT = 0;

// page.goto 导航超时（毫秒）
const DEFAULT_NAVIGATION_TIMEOUT = 45000;

// 就绪判定总超时（毫秒）
const DEFAULT_READY_TIMEOUT = 30000;

// Playwright 原生 screenshot 超时（毫秒）
const DEFAULT_SCREENSHOT_TIMEOUT = 8000;

// 默认并发截图上限（可被 CAPTURE_MAX_CONCURRENCY 覆盖）
const DEFAULT_CAPTURE_CONCURRENCY = 7;

// 默认排队长度上限（超过时直接拒绝）
const DEFAULT_CAPTURE_MAX_QUEUE = 50;

// 默认排队等待超时（毫秒）
const DEFAULT_CAPTURE_QUEUE_WAIT_TIMEOUT_MS = 10000;

// Node setTimeout/setInterval 的 32-bit 有符号整数上限（~24.8 天）。超过该值
// 会触发 TimeoutOverflowWarning 并被夹成 1ms，直接退化为忙循环。
const NODE_TIMER_MAX_MS = 2_147_483_647;

// 解析正整数毫秒配置；非法值（NaN / 超出 [min, max] 区间）回退到 fallback，
// 避免 0ms 扫描循环、立即清空新截图、或 interval 溢出忙循环等灾难性行为。
function parsePositiveIntMs(
  raw,
  fallback,
  { min = 1000, max = NODE_TIMER_MAX_MS } = {}
) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return Math.floor(parsed);
}

// 本地截图文件 TTL（毫秒）：超过此时长的残留文件将被兜底清理。
// 下限 60s：必须大于 OSS 签名 (默认 10s) + 上传 PUT (默认 30s) + 余量，
// 否则 cleanup 会与仍在上传的新截图竞争，导致 uploadToOss 读取时 ENOENT。
const SCREENSHOT_TTL_MS = parsePositiveIntMs(
  process.env.SCREENSHOT_TTL_MS,
  30 * 60 * 1000,
  { min: 60 * 1000 }
);

// 清理任务扫描周期（毫秒）
// 下限 10s：避免近似忙循环占用 I/O。
// 上限保持 NODE_TIMER_MAX_MS：超限回退到默认值，防止定时器溢出退化为 1ms。
const SCREENSHOT_CLEANUP_INTERVAL_MS = parsePositiveIntMs(
  process.env.SCREENSHOT_CLEANUP_INTERVAL_MS,
  5 * 60 * 1000,
  { min: 10 * 1000 }
);

// 设备预设：当请求未完整传入终端参数时使用
const DEVICE_PRESETS = {
  pc: {
    width: 1200,
    height: 630,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  },
  mobile: {
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  }
};

function ensureScreenshotDir() {
  // 启动时确保截图目录存在
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

module.exports = {
  SCREENSHOT_DIR,
  DEFAULT_TARGET_URL,
  DEFAULT_CAPTURE_WAIT,
  DEFAULT_NAVIGATION_TIMEOUT,
  DEFAULT_READY_TIMEOUT,
  DEFAULT_SCREENSHOT_TIMEOUT,
  DEFAULT_CAPTURE_CONCURRENCY,
  DEFAULT_CAPTURE_MAX_QUEUE,
  DEFAULT_CAPTURE_QUEUE_WAIT_TIMEOUT_MS,
  SCREENSHOT_TTL_MS,
  SCREENSHOT_CLEANUP_INTERVAL_MS,
  DEVICE_PRESETS,
  ensureScreenshotDir
};
