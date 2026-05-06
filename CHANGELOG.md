# Changelog

## 2026-05-06

### Summary
- 增强截图服务的抗阻塞能力：加入硬超时、阶段超时、浏览器自愈回收与优雅停机。
- 增强可观测性与可运维性：新增运行态健康接口与截图链路健康接口。
- 升级自检压测脚本：支持健康预检/后检、压测后 idle 断言、更多状态码与业务码统计。

### Backend Changes
- `src/services/capture.service.js`
  - 新增错误码：
    - `50301`：服务排空中（draining）
    - `50401`：截图流程硬超时
    - `50402`：截图阶段超时
  - 新增超时控制：
    - `CAPTURE_HARD_TIMEOUT_MS`（默认 `60000`）
    - `CAPTURE_STAGE_TIMEOUT_MS`（默认 `20000`）
    - `CAPTURE_CONTEXT_CLOSE_TIMEOUT_MS`（默认 `5000`）
    - `CAPTURE_BROWSER_LAUNCH_TIMEOUT_MS`（默认 `20000`）
    - `CAPTURE_BROWSER_CLOSE_TIMEOUT_MS`（默认 `8000`）
  - 新增浏览器自愈/回收策略：
    - `CAPTURE_BROWSER_TIMEOUT_THRESHOLD`（默认 `3`）
    - `CAPTURE_BROWSER_RECYCLE_EVERY`（默认 `500`）
    - `CAPTURE_BROWSER_MAX_AGE_MS`（默认 `1800000`）
  - 新增服务状态与停机能力：
    - `setCaptureServiceDraining`
    - `getCaptureRuntimeState`
    - `shutdownCaptureService`
    - `checkCaptureRuntime`

- `src/server.js`
  - 增加 `SIGTERM/SIGINT` 优雅停机流程：
    - 进入 draining，拒绝新截图请求
    - 停止 cleanup job
    - 关闭 HTTP server
    - 等待 capture 服务收敛并关闭 browser
  - 新增 `GRACEFUL_SHUTDOWN_TIMEOUT_MS`（默认 `20000`）

- `src/controllers/cover.controller.js`
  - 增加健康检查处理：
    - `getCaptureRuntimeStateView`
    - `getCaptureHealth`

- `src/routes/cover.routes.js`
  - 新增接口：
    - `GET /healthz`
    - `GET /healthz/capture`

### Script Changes
- `scripts/bench-screenshot.sh`
  - 新增健康检查流程：
    - 压测前/后检查 `/healthz`
    - 压测前/后检查 `/healthz/capture`
  - 新增压测后 idle 断言：轮询并校验 `activeCaptures=0` 且 `pendingCaptures=0`
  - 新增更多统计项：
    - HTTP: `503`、`504`
    - Biz code: `50301`、`50401`、`50402`
  - 新增断言与结果总状态：输出 `RESULT: PASSED/FAILED` 并通过 exit code 反馈
  - 修复 `READY_SELECTOR` 置空兼容，支持测试无 selector 场景

### Documentation Changes
- `README.md`
  - 补充健康检查接口说明
  - 补充新增错误码（`50301`、`50401`、`50402`）
  - 补充新增核心配置项与浏览器回收策略说明

### Validation Notes
- 压测结果显示：高并发场景下主要是 `42902`（排队超时）限流，不存在阻塞后资源不回收的迹象。
- 压测后 `active/pending` 能回归 `0`，`/healthz` 与 `/healthz/capture` 通过，说明防阻塞改造生效。
