const fs = require("node:fs/promises");
const path = require("node:path");
const {
  SCREENSHOT_DIR,
  SCREENSHOT_TTL_MS,
  SCREENSHOT_CLEANUP_INTERVAL_MS
} = require("../config/capture.config");

// 模块级状态：保证 setTimeout 自调度链不会重叠执行
let inFlight = false;
let stopped = false;
let scheduledTimer = null;

function logWarn(scope, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.warn(`[cleanup] scope=${scope} ${parts}`);
}

async function scanAndCleanup() {
  const now = Date.now();
  let removed = 0;
  let scanned = 0;

  let entries;
  try {
    entries = await fs.readdir(SCREENSHOT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    logWarn("scan", { action: "readdir", code: err.code, message: err.message });
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    scanned += 1;
    const filePath = path.join(SCREENSHOT_DIR, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > SCREENSHOT_TTL_MS) {
        await fs.unlink(filePath);
        removed += 1;
      }
    } catch (err) {
      // ENOENT 是与 OSS 上传后异步 unlink 的正常竞争，静默跳过
      if (err && err.code === "ENOENT") continue;
      logWarn("scan", {
        action: "stat-or-unlink",
        path: filePath,
        code: err.code,
        message: err.message
      });
    }
  }

  if (removed > 0) {
    console.log(
      `[cleanup] scope=scan removed=${removed} scanned=${scanned} ttl=${SCREENSHOT_TTL_MS}ms`
    );
  }
}

function schedule() {
  if (stopped) return;
  scheduledTimer = setTimeout(runOnce, SCREENSHOT_CLEANUP_INTERVAL_MS);
  // 定时器不阻塞进程退出
  if (scheduledTimer && typeof scheduledTimer.unref === "function") {
    scheduledTimer.unref();
  }
}

async function runOnce() {
  // 上一轮未结束就直接跳到下一个周期，避免并发扫描同一目录
  if (inFlight) {
    logWarn("schedule", { action: "skip", reason: "previous-scan-in-flight" });
    schedule();
    return;
  }
  inFlight = true;
  try {
    await scanAndCleanup();
  } catch (err) {
    // 顶层异常：与单文件失败区分开，代表编程错误或不可恢复的 I/O 故障
    logWarn("top-level", { code: err && err.code, message: err && err.message });
  } finally {
    inFlight = false;
    schedule();
  }
}

function startCleanupJob() {
  stopped = false;
  // 启动首轮走同一条 runOnce 链路，由 inFlight 互斥兜底：
  // 若首轮扫描耗时超过 INTERVAL，下一次调度会在 runOnce 的 finally 里才发起，
  // 从而彻底消除启动窗口内重叠扫描同一目录的可能。
  runOnce();

  return {
    stop() {
      stopped = true;
      if (scheduledTimer) {
        clearTimeout(scheduledTimer);
        scheduledTimer = null;
      }
    }
  };
}

module.exports = {
  scanAndCleanup,
  startCleanupJob
};
