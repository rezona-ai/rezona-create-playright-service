const { DEFAULT_TARGET_URL } = require("../config/capture.config");

function getCoverPreviewHtml({ targetUrl, captureMode, device, width, height, waitMs }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cover Preview</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: ${captureMode ? "0" : "24px"};
      background: #0b1020;
      color: #e4e8f3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #toolbar {
      width: ${width}px;
      display: ${captureMode ? "none" : "flex"};
      gap: 12px;
      align-items: center;
    }
    #url-input {
      flex: 1;
      height: 40px;
      border: 1px solid #334;
      border-radius: 8px;
      padding: 0 12px;
      background: #131a30;
      color: #fff;
      font-size: 14px;
    }
    #size-input, #device-input {
      height: 40px;
      border: 1px solid #334;
      border-radius: 8px;
      padding: 0 12px;
      background: #131a30;
      color: #fff;
      font-size: 14px;
    }
    #size-input { width: 120px; }
    #device-input { width: 90px; text-transform: lowercase; }
    #reload-btn {
      height: 40px;
      border: none;
      border-radius: 8px;
      padding: 0 16px;
      cursor: pointer;
      background: #4f7cff;
      color: #fff;
      font-weight: 600;
    }
    #cover-root {
      width: ${width}px;
      height: ${height}px;
      background: #fff;
      overflow: hidden;
      position: relative;
      flex-shrink: 0;
    }
    #cover-iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    #capture-ready {
      position: absolute;
      right: 8px;
      bottom: 8px;
      opacity: 0;
      pointer-events: none;
      user-select: none;
      font-size: 10px;
    }
    #empty-state {
      position: absolute;
      inset: 0;
      display: none;
      justify-content: center;
      align-items: center;
      color: #666;
      font-size: 14px;
      padding: 24px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <input id="url-input" value="${targetUrl}" />
    <input id="size-input" value="${width}x${height}" />
    <input id="device-input" value="${device}" />
    <button id="reload-btn" type="button">刷新预览</button>
  </div>
  <div id="cover-root">
    <iframe id="cover-iframe" src="${targetUrl}" loading="eager"></iframe>
    <div id="empty-state">请传入合法 target 参数，例如 ?target=${encodeURIComponent(DEFAULT_TARGET_URL)}</div>
    <div id="capture-ready" data-ready="false">pending</div>
  </div>
  <script>
    (function() {
      const params = new URLSearchParams(window.location.search);
      const captureWait = Number(params.get("wait") || ${waitMs});
      const target = params.get("target") || "";
      const isCapture = params.get("mode") === "capture";
      const iframe = document.getElementById("cover-iframe");
      const ready = document.getElementById("capture-ready");
      const input = document.getElementById("url-input");
      const sizeInput = document.getElementById("size-input");
      const deviceInput = document.getElementById("device-input");
      const button = document.getElementById("reload-btn");
      const empty = document.getElementById("empty-state");

      const isHttpTarget = /^https?:\\/\\//i.test(target);
      if (!isHttpTarget) {
        iframe.style.display = "none";
        empty.style.display = "flex";
      }

      const markReady = () => {
        ready.dataset.ready = "true";
        ready.textContent = "ready";
      };

      iframe.addEventListener("load", () => {
        setTimeout(markReady, captureWait);
      });

      setTimeout(markReady, captureWait + 5000);

      if (!isCapture) {
        button.addEventListener("click", () => {
          const next = input.value.trim();
          const nextSize = sizeInput.value.trim();
          const nextDevice = deviceInput.value.trim();
          if (!next) return;
          const nextParams = new URLSearchParams(window.location.search);
          nextParams.set("target", next);
          nextParams.set("device", nextDevice || "pc");
          if (/^\\d+x\\d+$/i.test(nextSize)) {
            const [w, h] = nextSize.toLowerCase().split("x");
            nextParams.set("width", w);
            nextParams.set("height", h);
          }
          nextParams.delete("mode");
          window.location.search = nextParams.toString();
        });
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  getCoverPreviewHtml
};
