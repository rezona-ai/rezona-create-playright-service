# syntax=docker/dockerfile:1.7

# Stage 1: install production dependencies only.
# Chromium + system libs are already provided by the Playwright image,
# so we skip the browser download to keep the layer lean.
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS deps
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: runtime image.
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/home/appuser \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Dedicated non-root user with a writable screenshots dir.
RUN groupadd --system --gid 10001 appuser \
 && useradd --system --uid 10001 --gid appuser \
      --create-home --home-dir /home/appuser --shell /usr/sbin/nologin appuser \
 && mkdir -p /app/screenshots \
 && chown -R appuser:appuser /app /home/appuser

COPY --chown=appuser:appuser package.json package-lock.json ./
COPY --from=deps --chown=appuser:appuser /app/node_modules ./node_modules
COPY --chown=appuser:appuser app.js ./app.js
COPY --chown=appuser:appuser src ./src

USER appuser
EXPOSE 3000

# Lightweight healthcheck: /cover-preview returns static HTML, no Playwright invocation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/cover-preview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
