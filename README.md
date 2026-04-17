# 截图服务接入文档

## 1. 服务概览

- **用途**：对指定网页 URL 进行截图，并返回本地访问地址或 OSS 地址。
- **基地址**：`http://<host>:<port>`
- **推荐接口**：`POST /covers/screenshot`

> 说明：`GET /covers/screenshot` 也支持（主要用于调试）。

---

## 2. 接口定义

### 2.1 创建截图

- **URL**：`/covers/screenshot`
- **Method**：`POST`
- **Content-Type**：`application/json`

### 2.2 请求参数

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `targetUrl` | string | 是 | - | 目标页面 URL，必须是 `http/https` |
| `storage` | string | 否 | `local` | `local` 或 `oss` |
| `device` | string | 否 | `pc` | `pc` / `mobile` |
| `width` | number/string | 否 | 设备默认 | 范围 `200~3000` |
| `height` | number/string | 否 | 设备默认 | 范围 `200~4000` |
| `waitMs` | number/string | 否 | `0` | 就绪后额外等待毫秒，范围 `0~20000` |
| `readySelector` | string | 否 | - | 就绪选择器，长度 <= 200；不传时使用 `networkidle` |

> 兼容参数：`wait` 可替代 `waitMs`。  
> `GET` 请求时可用 query 传参。

---

## 3. 请求示例

```bash
curl -X POST "http://localhost:3000/covers/screenshot" \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl":"https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/f636c73b-bd7a-4299-b2d5-d9d1729a0cf6/index.html",
    "storage":"local",
    "device":"mobile",
    "width":"430",
    "height":"870",
    "readySelector":"canvas",
    "waitMs":1200
  }'
```

---

## 4. 响应格式

### 4.1 成功响应

```json
{
  "code": 0,
  "message": "截图成功",
  "data": {
    "storage": "local",
    "device": "mobile",
    "width": 430,
    "height": 870,
    "waitMs": 1200,
    "readySelector": "canvas",
    "targetUrl": "https://...",
    "fileName": "cover-mobile-430x870-xxx.png",
    "localPath": "/abs/path/screenshots/cover-xxx.png",
    "previewUrl": "http://localhost:3000/screenshots/cover-xxx.png",
    "imageWidth": 430,
    "imageHeight": 870,
    "ossObjectKey": null,
    "ossUrl": null
  }
}
```

---

## 5. 错误码与状态码

| HTTP | code | 场景 |
|---:|---:|---|
| 400 | 400 | 参数错误（如 `targetUrl`/`storage`/`device` 非法） |
| 429 | 42901 | 并发槽位已满且队列已满（任务过多） |
| 429 | 42902 | 排队超时 |
| 500 | 500 | 导航/渲染/截图等内部异常 |

---

## 6. 当前就绪判定逻辑（重要）

1. 先尝试等待 `window.__REZONA_CAPTURE_READY__ === true`（短探测）。
2. 若未命中，若检测到页面存在 `window.assetsReady`，优先等待其为 `true`（超时则继续后续判定）。
3. 若仍未命中，优先等待 `readySelector` 可见；未传时等待页面 `networkidle`。
4. 成功后额外等待 `waitMs` 毫秒。
5. 执行截图。

---

## 7. 并发与队列（当前默认）

- `CAPTURE_MAX_CONCURRENCY=7`（同一时刻最多 7 个截图执行）
- `CAPTURE_MAX_QUEUE=50`（最多 50 个排队）
- `CAPTURE_QUEUE_WAIT_TIMEOUT_MS=10000`（排队超时 10 秒）

> 超过能力会返回 `42901/42902`，调用方建议重试（指数退避 + 抖动）。

---

## 8. OSS 存储接入（`storage=oss`）

当前实现为 **Presigned URL 上传**（服务端先向业务 API 申请签名，再 PUT 上传截图文件）。

需配置环境变量：

- `UPLOAD_API_BASE_URL`（示例：`https://api.rezona.ai`）
- `UPLOAD_API_BASIC_USERNAME`（用于 Basic 鉴权）
- `UPLOAD_API_BASIC_PASSWORD`（用于 Basic 鉴权）
- （可选）`UPLOAD_API_PRESIGNED_PATH`（默认 `/api/v3/upload/internal/presigned-url`）
- （可选）`UPLOAD_FILE_PATH`（默认 `game/cover`）
- （可选）`UPLOAD_SIGN_TIMEOUT_MS`（默认 `10000`）
- （可选）`UPLOAD_PUT_TIMEOUT_MS`（默认 `30000`）

签名接口：`POST {UPLOAD_API_BASE_URL}/api/v3/upload/internal/presigned-url`  
请求头：`Authorization: Basic <base64(username:password)>`  
请求体字段：`content_type`、`file_name`、`file_path`

---

## 9. 调用方最佳实践

- 客户端超时建议 `35~60s`。
- 对 `429` 做重试（指数退避）。
- 尽量传稳定、可预测的 `readySelector`。
- 高并发调用建议批次化，避免瞬时洪峰。
- 生产环境建议配置固定 `BASE_URL`，保证 `previewUrl` 可被外部访问。

---

## 10. 压测脚本使用

项目内已提供压测脚本：

- 脚本路径：`scripts/bench-screenshot.sh`

### 10.1 直接执行（默认参数）

```bash
cd /Users/admin/Desktop/rezona-web-service
./scripts/bench-screenshot.sh
```

### 10.2 常用压测命令（推荐）

```bash
cd /Users/admin/Desktop/rezona-web-service
TOTAL=100 CONCURRENCY=10 WAIT_MS=0 READY_SELECTOR=canvas \
BASE_URL=http://localhost:3000/covers/screenshot \
./scripts/bench-screenshot.sh
```

### 10.3 关键参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `BASE_URL` | `http://localhost:3000/covers/screenshot` | 压测目标接口 |
| `TARGET_URL` | 默认小游戏 URL | 被截图页面 |
| `TOTAL` | `40` | 总请求数 |
| `CONCURRENCY` | `8` | 并发请求数 |
| `DEVICE` | `mobile` | `pc` / `mobile` |
| `WIDTH` | `430` | 截图宽度 |
| `HEIGHT` | `870` | 截图高度 |
| `WAIT_MS` | `1200` | 就绪后额外等待 |
| `READY_SELECTOR` | `canvas` | 就绪选择器（可置空） |
| `STORAGE` | `local` | 存储类型 |
| `CURL_MAX_TIME` | `90` | 单请求 curl 超时秒数 |

### 10.4 输出结果说明

脚本会输出以下核心指标：

- 总请求数、HTTP 200/429、Curl 失败数
- 业务错误码 `42901`（队列满）与 `42902`（排队超时）统计
- 延迟统计：`min/avg/p50/p90/p95/p99/max`
- 最慢 Top 5 请求明细

### 11 不同类型游戏调用示例

##### 游戏1:

游戏链接：https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/ee04c02c-99b8-4c4f-a674-894c5df34a10/68e66781-fa27-4428-8975-a4bbe404ce2c/index.html

调用示例：curl -X POST "http://104.196.52.37:3000/covers/screenshot" -H "Content-Type: application/json" -d '{"targetUrl":"https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/ee04c02c-99b8-4c4f-a674-894c5df34a10/68e66781-fa27-4428-8975-a4bbe404ce2c/index.html","storage":"oss", "device": "mobile", "width": "430", "height": "870” }'

readySelector参数不传。

##### 游戏2:

游戏链接：https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/e9b41ce8-f3d4-4e39-959a-f257f34f5c84/f8c3e9cd-2acd-4e05-b432-8c35c26cfcd0/index.html

调用示例：curl -X POST "http://104.196.52.37:3000/covers/screenshot" -H "Content-Type: application/json" -d '{"targetUrl":"https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/e9b41ce8-f3d4-4e39-959a-f257f34f5c84/f8c3e9cd-2acd-4e05-b432-8c35c26cfcd0/index.html","storage":"oss", "device": "mobile", "width": "430", "height": "870”, "readySelector": "#app canvas" }'

readySelector参数传："#app canvas"。

###### 游戏3:

游戏链接：https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/f636c73b-bd7a-4299-b2d5-d9d1729a0cf6/index.html

调用示例：curl -X POST "http://localhost:3000/covers/screenshot" -H "Content-Type: application/json" -d '{"targetUrl":"https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/f636c73b-bd7a-4299-b2d5-d9d1729a0cf6/index.html","storage":"oss", "device": "mobile", "width": "430", "height": "870”, "readySelector": "#game canvas" }'

readySelector参数传: "#game canvas"。

##### 游戏4:

游戏链接：https://storage.googleapis.com/rezona-ai-prod/minigame/c9460120-bbbf-4efd-9dac-1547ea904345/index.html

调用示例：跟游戏1保持一致 readySelector 不传
