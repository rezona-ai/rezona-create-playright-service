const fs = require("node:fs/promises");
const path = require("node:path");
const {
  SCREENSHOT_DIR,
  SCREENSHOT_TTL_MS,
  SCREENSHOT_CLEANUP_INTERVAL_MS
} = require("../config/capture.config");

async function scanAndCleanup() {
  const now = Date.now();
  let removed = 0;
  let scanned = 0;

  let entries;
  try {
    entries = await fs.readdir(SCREENSHOT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    console.warn(`[cleanup] scan failed: ${err.message}`);
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
      // 单个文件失败不影响其余文件的扫描
      console.warn(`[cleanup] stat/unlink failed: ${filePath} ${err.message}`);
    }
  }

  if (removed > 0) {
    console.log(
      `[cleanup] removed=${removed} scanned=${scanned} ttl=${SCREENSHOT_TTL_MS}ms`
    );
  }
}

function startCleanupJob() {
  // 进程启动时先跑一次，清除上次进程遗留的残件
  scanAndCleanup().catch(() => {});

  const timer = setInterval(() => {
    scanAndCleanup().catch(() => {});
  }, SCREENSHOT_CLEANUP_INTERVAL_MS);

  // 关键：定时器不阻塞进程退出
  if (typeof timer.unref === "function") timer.unref();

  return timer;
}

module.exports = {
  scanAndCleanup,
  startCleanupJob
};
