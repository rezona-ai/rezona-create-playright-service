#!/usr/bin/env bash

set -u
set -o pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/covers/screenshot}"
TARGET_URL="${TARGET_URL:-https://storage.googleapis.com/rezona-ai-prod/agent-jobs/minigame/f636c73b-bd7a-4299-b2d5-d9d1729a0cf6/index.html}"
TOTAL="${TOTAL:-40}"
CONCURRENCY="${CONCURRENCY:-8}"
DEVICE="${DEVICE:-mobile}"
WIDTH="${WIDTH:-430}"
HEIGHT="${HEIGHT:-870}"
WAIT_MS="${WAIT_MS:-1200}"
READY_SELECTOR="${READY_SELECTOR-canvas}"
STORAGE="${STORAGE:-local}"
CURL_MAX_TIME="${CURL_MAX_TIME:-90}"

# 自检扩展参数
RUN_HEALTHCHECK="${RUN_HEALTHCHECK:-1}"
RUN_CAPTURE_HEALTHCHECK="${RUN_CAPTURE_HEALTHCHECK:-1}"
RUN_POST_IDLE_ASSERT="${RUN_POST_IDLE_ASSERT:-1}"
POST_IDLE_MAX_WAIT_SEC="${POST_IDLE_MAX_WAIT_SEC:-20}"
POST_IDLE_POLL_INTERVAL_SEC="${POST_IDLE_POLL_INTERVAL_SEC:-1}"
EXPECT_NO_CURL_FAILURE="${EXPECT_NO_CURL_FAILURE:-1}"
EXPECT_HTTP_200_MIN="${EXPECT_HTTP_200_MIN:-1}"
FAIL_FAST="${FAIL_FAST:-0}"

ROOT_BASE_URL="${ROOT_BASE_URL:-${BASE_URL%/covers/screenshot}}"
if [ "$ROOT_BASE_URL" = "$BASE_URL" ]; then
  ROOT_BASE_URL="$(printf '%s' "$BASE_URL" | sed 's#/covers/screenshot$##')"
fi
HEALTH_URL="${HEALTH_URL:-$ROOT_BASE_URL/healthz}"
CAPTURE_HEALTH_URL="${CAPTURE_HEALTH_URL:-$ROOT_BASE_URL/healthz/capture}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl 未安装，无法压测。"
  exit 1
fi

if ! command -v awk >/dev/null 2>&1; then
  echo "awk 未安装，无法统计结果。"
  exit 1
fi

if ! command -v mktemp >/dev/null 2>&1; then
  echo "mktemp 未安装，无法创建临时目录。"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node 未安装，无法执行 JSON 自检解析。"
  exit 1
fi

TMP_DIR="$(mktemp -d /tmp/bench-screenshot.XXXXXX)"
RESULTS_FILE="$TMP_DIR/results.tsv"
TIMES_FILE="$TMP_DIR/times.txt"
SLOW_FILE="$TMP_DIR/slow.tsv"

FAILED_ASSERTS=0

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

print_section() {
  printf '\n== %s ==\n' "$1"
}

fail_assert() {
  FAILED_ASSERTS=$((FAILED_ASSERTS + 1))
  printf '[ASSERT FAIL] %s\n' "$1"
  if [ "$FAIL_FAST" = "1" ]; then
    exit 1
  fi
}

pass_assert() {
  printf '[ASSERT PASS] %s\n' "$1"
}

json_get() {
  local file="$1"
  local key_path="$2"

  node -e '
const fs = require("node:fs");
const file = process.argv[1];
const keyPath = process.argv[2];
let data;
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(1);
}
let current = data;
for (const key of keyPath.split(".")) {
  if (!key) continue;
  if (current === null || current === undefined || !(key in current)) {
    process.exit(2);
  }
  current = current[key];
}
if (current === null || current === undefined) process.exit(3);
if (typeof current === "object") {
  process.stdout.write(JSON.stringify(current));
} else {
  process.stdout.write(String(current));
}
' "$file" "$key_path" 2>/dev/null
}

json_number_or_default() {
  local text="$1"
  local fallback="$2"
  if printf '%s' "$text" | awk 'BEGIN{ok=0} /^-?[0-9]+(\.[0-9]+)?$/{ok=1} END{exit ok?0:1}'; then
    printf '%s' "$text"
  else
    printf '%s' "$fallback"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

build_payload() {
  local target_escaped
  target_escaped="$(json_escape "$TARGET_URL")"
  if [ -n "$READY_SELECTOR" ]; then
    local selector_escaped
    selector_escaped="$(json_escape "$READY_SELECTOR")"
    printf '{"targetUrl":"%s","storage":"%s","device":"%s","width":"%s","height":"%s","waitMs":%s,"readySelector":"%s"}' \
      "$target_escaped" "$STORAGE" "$DEVICE" "$WIDTH" "$HEIGHT" "$WAIT_MS" "$selector_escaped"
  else
    printf '{"targetUrl":"%s","storage":"%s","device":"%s","width":"%s","height":"%s","waitMs":%s}' \
      "$target_escaped" "$STORAGE" "$DEVICE" "$WIDTH" "$HEIGHT" "$WAIT_MS"
  fi
}

http_get_json() {
  local url="$1"
  local body_file="$2"
  local meta_file="$3"
  local err_file="$4"

  curl -sS -m "$CURL_MAX_TIME" \
    -o "$body_file" \
    -w 'http_code=%{http_code} time_total=%{time_total}\n' \
    "$url" >"$meta_file" 2>"$err_file"
}

read_meta_field() {
  local file="$1"
  local field="$2"
  awk -v key="$field" 'NR==1 {
    n = split($0, arr, " ");
    for (i=1; i<=n; i++) {
      split(arr[i], kv, "=");
      if (kv[1] == key) { print kv[2]; exit }
    }
  }' "$file" 2>/dev/null
}

check_health_endpoint() {
  local title="$1"
  local url="$2"
  local mode="$3"

  local body_file="$TMP_DIR/${mode}-body.json"
  local meta_file="$TMP_DIR/${mode}-meta.txt"
  local err_file="$TMP_DIR/${mode}-err.log"

  print_section "$title"
  if ! http_get_json "$url" "$body_file" "$meta_file" "$err_file"; then
    fail_assert "$mode 请求失败: $url"
    [ -s "$err_file" ] && sed 's/^/[curl] /' "$err_file"
    return 1
  fi

  local http_code api_code active pending draining
  http_code="$(read_meta_field "$meta_file" "http_code")"
  api_code="$(json_get "$body_file" "code" || true)"
  active="$(json_get "$body_file" "data.activeCaptures" || true)"
  pending="$(json_get "$body_file" "data.pendingCaptures" || true)"
  draining="$(json_get "$body_file" "data.draining" || true)"

  printf 'URL=%s\n' "$url"
  printf 'HTTP=%s API_CODE=%s active=%s pending=%s draining=%s\n' \
    "${http_code:-?}" "${api_code:-?}" "${active:-?}" "${pending:-?}" "${draining:-?}"

  if [ "${http_code:-}" != "200" ]; then
    fail_assert "$mode HTTP 不是 200（实际 ${http_code:-空}）"
    return 1
  fi

  if [ "${api_code:-}" != "0" ]; then
    fail_assert "$mode 返回 code 不是 0（实际 ${api_code:-空}）"
    return 1
  fi

  pass_assert "$mode 可用"
  return 0
}

assert_post_idle() {
  if [ "$RUN_POST_IDLE_ASSERT" != "1" ]; then
    return 0
  fi

  print_section "Post-Run Idle Assert"

  local elapsed=0
  while [ "$elapsed" -le "$POST_IDLE_MAX_WAIT_SEC" ]; do
    local body_file="$TMP_DIR/post-idle-body.json"
    local meta_file="$TMP_DIR/post-idle-meta.txt"
    local err_file="$TMP_DIR/post-idle-err.log"

    if http_get_json "$HEALTH_URL" "$body_file" "$meta_file" "$err_file"; then
      local active pending draining
      active="$(json_number_or_default "$(json_get "$body_file" "data.activeCaptures" || true)" "-1")"
      pending="$(json_number_or_default "$(json_get "$body_file" "data.pendingCaptures" || true)" "-1")"
      draining="$(json_get "$body_file" "data.draining" || true)"

      printf '[poll] t=%ss active=%s pending=%s draining=%s\n' "$elapsed" "$active" "$pending" "${draining:-?}"

      if [ "$active" = "0" ] && [ "$pending" = "0" ]; then
        pass_assert "压测后 active/pending 已回归 0"
        return 0
      fi
    fi

    sleep "$POST_IDLE_POLL_INTERVAL_SEC"
    elapsed=$((elapsed + POST_IDLE_POLL_INTERVAL_SEC))
  done

  fail_assert "压测后 ${POST_IDLE_MAX_WAIT_SEC}s 内 active/pending 未回归 0"
  return 1
}

PAYLOAD="$(build_payload)"

run_one() {
  local idx="$1"
  local body_file="$TMP_DIR/body-$idx.json"
  local meta_file="$TMP_DIR/meta-$idx.txt"
  local err_file="$TMP_DIR/err-$idx.log"

  curl -sS -m "$CURL_MAX_TIME" \
    -o "$body_file" \
    -w 'http_code=%{http_code} time_total=%{time_total}\n' \
    -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >"$meta_file" 2>"$err_file"
  local curl_exit=$?

  local http_code time_total biz_code
  http_code="$(read_meta_field "$meta_file" "http_code")"
  time_total="$(read_meta_field "$meta_file" "time_total")"
  biz_code="$(json_get "$body_file" "code" || true)"

  [ -z "$http_code" ] && http_code="000"
  [ -z "$time_total" ] && time_total="0"
  [ -z "$biz_code" ] && biz_code="-"

  printf "%s\t%s\t%s\t%s\t%s\n" "$idx" "$http_code" "$time_total" "$curl_exit" "$biz_code" >>"$RESULTS_FILE"
}

print_section "Screenshot Benchmark"
echo "BASE_URL=$BASE_URL"
echo "HEALTH_URL=$HEALTH_URL"
echo "CAPTURE_HEALTH_URL=$CAPTURE_HEALTH_URL"
echo "TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY DEVICE=$DEVICE ${WIDTH}x${HEIGHT} WAIT_MS=$WAIT_MS READY_SELECTOR=${READY_SELECTOR:-<empty>}"
echo ""

if [ "$RUN_HEALTHCHECK" = "1" ]; then
  check_health_endpoint "Preflight /healthz" "$HEALTH_URL" "pre-healthz"
fi

if [ "$RUN_CAPTURE_HEALTHCHECK" = "1" ]; then
  check_health_endpoint "Preflight /healthz/capture" "$CAPTURE_HEALTH_URL" "pre-healthz-capture"
fi

i=1
while [ "$i" -le "$TOTAL" ]; do
  end=$((i + CONCURRENCY - 1))
  if [ "$end" -gt "$TOTAL" ]; then
    end="$TOTAL"
  fi

  pids=""
  j="$i"
  while [ "$j" -le "$end" ]; do
    run_one "$j" &
    pids="$pids $!"
    j=$((j + 1))
  done

  for pid in $pids; do
    wait "$pid"
  done

  i=$((end + 1))
done

awk -F'\t' '{print $3}' "$RESULTS_FILE" | sort -n >"$TIMES_FILE"
awk -F'\t' '{print $3"\t"$1"\t"$2"\t"$5}' "$RESULTS_FILE" | sort -nr >"$SLOW_FILE"

count_lines() {
  wc -l <"$1" | tr -d ' '
}

N="$(count_lines "$TIMES_FILE")"
if [ "$N" -eq 0 ]; then
  fail_assert "无有效压测结果"
  echo ""
  echo "RESULT: FAILED"
  exit 1
fi

nth_percentile() {
  local percent="$1"
  local idx=$(( (N * percent + 99) / 100 ))
  [ "$idx" -lt 1 ] && idx=1
  [ "$idx" -gt "$N" ] && idx="$N"
  sed -n "${idx}p" "$TIMES_FILE"
}

MIN="$(sed -n '1p' "$TIMES_FILE")"
MAX="$(sed -n "${N}p" "$TIMES_FILE")"
AVG="$(awk -F'\t' '{s+=$3} END{if(NR==0) print 0; else printf "%.6f", s/NR}' "$RESULTS_FILE")"
P50="$(nth_percentile 50)"
P90="$(nth_percentile 90)"
P95="$(nth_percentile 95)"
P99="$(nth_percentile 99)"

HTTP_200="$(awk -F'\t' '$2=="200"{c++} END{print c+0}' "$RESULTS_FILE")"
HTTP_429="$(awk -F'\t' '$2=="429"{c++} END{print c+0}' "$RESULTS_FILE")"
HTTP_503="$(awk -F'\t' '$2=="503"{c++} END{print c+0}' "$RESULTS_FILE")"
HTTP_504="$(awk -F'\t' '$2=="504"{c++} END{print c+0}' "$RESULTS_FILE")"
CURL_FAIL="$(awk -F'\t' '$4!="0"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_42901="$(awk -F'\t' '$5=="42901"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_42902="$(awk -F'\t' '$5=="42902"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_50301="$(awk -F'\t' '$5=="50301"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_50401="$(awk -F'\t' '$5=="50401"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_50402="$(awk -F'\t' '$5=="50402"{c++} END{print c+0}' "$RESULTS_FILE")"

print_section "Summary"
echo "Total Requests : $N"
echo "HTTP 200       : $HTTP_200"
echo "HTTP 429       : $HTTP_429"
echo "HTTP 503       : $HTTP_503"
echo "HTTP 504       : $HTTP_504"
echo "Curl Failures  : $CURL_FAIL"
echo "Biz 42901      : $CODE_42901 (queue full)"
echo "Biz 42902      : $CODE_42902 (queue timeout)"
echo "Biz 50301      : $CODE_50301 (service draining)"
echo "Biz 50401      : $CODE_50401 (hard timeout)"
echo "Biz 50402      : $CODE_50402 (stage timeout)"
echo ""
echo "Latency (s)"
printf 'min=%s avg=%s p50=%s p90=%s p95=%s p99=%s max=%s\n' \
  "$MIN" "$AVG" "$P50" "$P90" "$P95" "$P99" "$MAX"
echo ""
echo "Top 5 Slow Requests (time_s, req_id, http, biz_code)"
head -n 5 "$SLOW_FILE"

print_section "Assertions"
if [ "$EXPECT_NO_CURL_FAILURE" = "1" ]; then
  if [ "$CURL_FAIL" -eq 0 ]; then
    pass_assert "curl 失败数为 0"
  else
    fail_assert "curl 失败数应为 0，实际 $CURL_FAIL"
  fi
fi

if [ "$HTTP_200" -ge "$EXPECT_HTTP_200_MIN" ]; then
  pass_assert "HTTP 200 数量 >= ${EXPECT_HTTP_200_MIN}"
else
  fail_assert "HTTP 200 数量不足：期望 >= ${EXPECT_HTTP_200_MIN}，实际 ${HTTP_200}"
fi

if [ "$RUN_HEALTHCHECK" = "1" ]; then
  check_health_endpoint "Postflight /healthz" "$HEALTH_URL" "post-healthz"
fi

if [ "$RUN_CAPTURE_HEALTHCHECK" = "1" ]; then
  check_health_endpoint "Postflight /healthz/capture" "$CAPTURE_HEALTH_URL" "post-healthz-capture"
fi

assert_post_idle

echo ""
if [ "$FAILED_ASSERTS" -eq 0 ]; then
  echo "RESULT: PASSED"
  exit 0
fi

echo "RESULT: FAILED (assert_count=$FAILED_ASSERTS)"
exit 1
