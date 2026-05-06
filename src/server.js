require("dotenv").config();
const app = require("./app");
const { startCleanupJob } = require("./services/cleanup.service");
const {
  setCaptureServiceDraining,
  shutdownCaptureService
} = require("./services/capture.service");

const port = Number(process.env.PORT || 3000);
const shutdownTimeoutMs = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 20000);

setCaptureServiceDraining(false);
const cleanupJob = startCleanupJob();

const server = app.listen(port, () => {
  console.log(`server running at http://localhost:${port}`);
});

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.warn(`[shutdown] received ${signal}, start graceful shutdown`);

  setCaptureServiceDraining(true);
  cleanupJob.stop();

  const forceExitTimer = setTimeout(() => {
    console.error(`[shutdown] force exit after ${shutdownTimeoutMs}ms`);
    process.exit(1);
  }, shutdownTimeoutMs + 2000);

  if (typeof forceExitTimer.unref === "function") {
    forceExitTimer.unref();
  }

  try {
    await new Promise((resolve) => {
      server.close(() => {
        console.warn("[shutdown] http server closed");
        resolve();
      });
    });

    await shutdownCaptureService({ timeoutMs: shutdownTimeoutMs });
    console.warn("[shutdown] capture service closed");
    process.exit(0);
  } catch (error) {
    console.error("[shutdown] graceful shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT");
});
