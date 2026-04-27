const DEFAULT_FILE_PATH = "game/cover";
const DEFAULT_SIGN_TIMEOUT_MS = 10000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30000;
const DEFAULT_PRESIGNED_PATH = "/api/v3/upload/internal/presigned-url";

function inferContentType(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function stripQuery(url) {
  return String(url || "").split("?")[0];
}

function parseObjectKey(fileUrl) {
  try {
    const parsed = new URL(fileUrl);
    return parsed.pathname.replace(/^\/+/, "") || null;
  } catch {
    return null;
  }
}

function normalizeApiBaseUrl(rawUrl) {
  return String(rawUrl || "").trim().replace(/\/+$/, "");
}

function normalizePath(rawPath) {
  const text = String(rawPath || "").trim();
  if (!text) return DEFAULT_PRESIGNED_PATH;
  if (/^https?:\/\//i.test(text)) return text;
  return text.startsWith("/") ? text : `/${text}`;
}

function buildBasicAuthHeader(username, password) {
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(createAbortError(`Request timeout after ${timeout}ms`));
  }, timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestPresignedUrl({ fileName, contentType }) {
  const apiBaseUrl = normalizeApiBaseUrl(process.env.UPLOAD_API_BASE_URL);
  const apiPath = normalizePath(process.env.UPLOAD_API_PRESIGNED_PATH || DEFAULT_PRESIGNED_PATH);
  const basicUsername = String(process.env.UPLOAD_API_BASIC_USERNAME || "").trim();
  const basicPassword = String(process.env.UPLOAD_API_BASIC_PASSWORD || "").trim();
  const filePath = String(process.env.UPLOAD_FILE_PATH || DEFAULT_FILE_PATH).trim();
  const signTimeoutMs = Number(process.env.UPLOAD_SIGN_TIMEOUT_MS || DEFAULT_SIGN_TIMEOUT_MS);
  const endpoint = /^https?:\/\//i.test(apiPath)
    ? apiPath
    : `${apiBaseUrl}${apiPath}`;

  if (!/^https?:\/\//i.test(apiPath) && !apiBaseUrl) {
    throw new Error("缺少配置: UPLOAD_API_BASE_URL");
  }
  if (!basicUsername) {
    throw new Error("缺少配置: UPLOAD_API_BASIC_USERNAME");
  }
  if (!basicPassword) {
    throw new Error("缺少配置: UPLOAD_API_BASIC_PASSWORD");
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: buildBasicAuthHeader(basicUsername, basicPassword),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content_type: contentType,
        file_name: fileName,
        file_path: filePath || DEFAULT_FILE_PATH
      })
    },
    signTimeoutMs
  );

  const bodyText = await response.text();
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && typeof payload.msg === "string" && payload.msg) ||
      bodyText ||
      `status=${response.status}`;
    throw new Error(`获取 presigned url 失败: ${detail}`);
  }

  if (!payload || payload.code !== 0 || !payload.data || typeof payload.data.url !== "string") {
    const detail =
      (payload && typeof payload.msg === "string" && payload.msg) ||
      bodyText ||
      "invalid response";
    throw new Error(`获取 presigned url 失败: ${detail}`);
  }

  return payload.data.url;
}

async function uploadToOss(fileBuffer, fileName) {
  if (!fileBuffer || typeof fileBuffer.length !== "number") {
    throw new Error("上传文件失败: 空截图数据");
  }

  const uploadTimeoutMs = Number(process.env.UPLOAD_PUT_TIMEOUT_MS || DEFAULT_UPLOAD_TIMEOUT_MS);
  const contentType = inferContentType(fileName);
  const presignedUrl = await requestPresignedUrl({ fileName, contentType });

  const response = await fetchWithTimeout(
    presignedUrl,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType
      },
      body: fileBuffer
    },
    uploadTimeoutMs
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`上传文件失败: status=${response.status}${detail ? ` body=${detail}` : ""}`);
  }

  const url = stripQuery(presignedUrl);
  return {
    objectKey: parseObjectKey(url),
    url
  };
}

module.exports = {
  uploadToOss
};
