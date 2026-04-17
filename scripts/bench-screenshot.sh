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
READY_SELECTOR="${READY_SELECTOR:-canvas}"
STORAGE="${STORAGE:-local}"
CURL_MAX_TIME="${CURL_MAX_TIME:-90}"

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

TMP_DIR="$(mktemp -d /tmp/bench-screenshot.XXXXXX)"
RESULTS_FILE="$TMP_DIR/results.tsv"
TIMES_FILE="$TMP_DIR/times.txt"
SLOW_FILE="$TMP_DIR/slow.tsv"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

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

PAYLOAD="$(build_payload)"

run_one() {
  local idx="$1"
  local body_file="$TMP_DIR/body-$idx.json"
  local meta_file="$TMP_DIR/meta-$idx.txt"

  curl -sS -m "$CURL_MAX_TIME" \
    -o "$body_file" \
    -w 'http_code=%{http_code} time_total=%{time_total}\n' \
    -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >"$meta_file" 2>"$TMP_DIR/err-$idx.log"
  local curl_exit=$?

  local http_code time_total biz_code
  http_code="$(awk -F'http_code=' 'NR==1{split($2,a," "); print a[1]}' "$meta_file" 2>/dev/null)"
  time_total="$(awk -F'time_total=' 'NR==1{print $2}' "$meta_file" 2>/dev/null)"
  biz_code="$(sed -n 's/.*"code":[[:space:]]*\([0-9]\+\).*/\1/p' "$body_file" | head -n1)"

  [ -z "$http_code" ] && http_code="000"
  [ -z "$time_total" ] && time_total="0"
  [ -z "$biz_code" ] && biz_code="-"

  printf "%s\t%s\t%s\t%s\t%s\n" "$idx" "$http_code" "$time_total" "$curl_exit" "$biz_code" >>"$RESULTS_FILE"
}

echo "== Screenshot Benchmark =="
echo "BASE_URL=$BASE_URL"
echo "TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY DEVICE=$DEVICE ${WIDTH}x${HEIGHT} WAIT_MS=$WAIT_MS READY_SELECTOR=${READY_SELECTOR:-<empty>}"
echo

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
  echo "无有效压测结果。"
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
CURL_FAIL="$(awk -F'\t' '$4!="0"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_42901="$(awk -F'\t' '$5=="42901"{c++} END{print c+0}' "$RESULTS_FILE")"
CODE_42902="$(awk -F'\t' '$5=="42902"{c++} END{print c+0}' "$RESULTS_FILE")"

echo "== Summary =="
echo "Total Requests : $N"
echo "HTTP 200       : $HTTP_200"
echo "HTTP 429       : $HTTP_429"
echo "Curl Failures  : $CURL_FAIL"
echo "Biz 42901      : $CODE_42901 (queue full)"
echo "Biz 42902      : $CODE_42902 (queue timeout)"
echo
echo "Latency (s)"
printf "min=%s avg=%s p50=%s p90=%s p95=%s p99=%s max=%s\n" \
  "$MIN" "$AVG" "$P50" "$P90" "$P95" "$P99" "$MAX"
echo
echo "Top 5 Slow Requests (time_s, req_id, http, biz_code)"
head -n 5 "$SLOW_FILE"

