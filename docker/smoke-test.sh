#!/bin/sh
# Starts the image like a user would and checks what CI cannot see from unit tests:
# privilege drop to PUID/PGID, /config ownership, TZ, bundled tools, health, auth, backups, restart and graceful stop.
# Usage: docker/smoke-test.sh <image>   (needs docker, curl and jq)
set -eu

IMAGE="${1:?usage: docker/smoke-test.sh <image>}"
NAME="wololo-smoke-$$"
VOLUME="wololo-smoke-config-$$"
PORT="${SMOKE_PORT:-18585}"
BASE="http://127.0.0.1:${PORT}"
KEY="smoke0123456789abcdef0123456789ab"
SMOKE_UID=1234
SMOKE_GID=2345

cleanup() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "${NAME}" 2>&1 | tail -n 200 || true
  fi
  docker rm -f "${NAME}" > /dev/null 2>&1 || true
  docker volume rm -f "${VOLUME}" > /dev/null 2>&1 || true
  exit "${status}"
}
trap cleanup EXIT

step() {
  echo "==> $*"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_until() {
  description="$1"
  seconds="$2"
  shift 2
  elapsed=0
  until "$@" > /dev/null 2>&1; do
    elapsed=$((elapsed + 1))
    [ "${elapsed}" -lt "${seconds}" ] || fail "timed out after ${seconds}s waiting for ${description}"
    sleep 1
  done
}

api() {
  curl -fsS -H "X-Api-Key: ${KEY}" "$@"
}

status_code() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

container_state() {
  docker inspect -f "$1" "${NAME}"
}

is_healthy() {
  [ "$(container_state '{{.State.Health.Status}}')" = healthy ]
}

has_restarted() {
  [ "$(container_state '{{.RestartCount}}')" -ge 1 ] && curl -fsS "${BASE}/health"
}

step "start ${IMAGE}"
docker volume create "${VOLUME}" > /dev/null
docker run -d --name "${NAME}" --restart unless-stopped \
  -p "127.0.0.1:${PORT}:8585" \
  -e PUID="${SMOKE_UID}" -e PGID="${SMOKE_GID}" -e UMASK=022 -e TZ=Europe/Bucharest \
  -e WOLOLO__API_KEY="${KEY}" \
  -v "${VOLUME}:/config" \
  "${IMAGE}" > /dev/null

step "GET /health"
wait_until "/health" 60 curl -fsS "${BASE}/health"
curl -fsS "${BASE}/health" | jq -e '.status == "ok"' > /dev/null || fail "/health is not ok"

step "web UI and auth"
curl -fsS "${BASE}/" | grep -q '__WOLOLO__' || fail "index.html has no runtime config"
[ "$(status_code "${BASE}/api/v1/system/status")" = 401 ] || fail "API answered without a key"
[ "$(status_code "${BASE}/api/v1/docs")" = 200 ] || fail "API docs page is not public"

step "PID 1 runs as ${SMOKE_UID}:${SMOKE_GID} and owns /config"
[ "$(docker exec "${NAME}" awk '/^Uid:/{print $2}' /proc/1/status)" = "${SMOKE_UID}" ] || fail "wrong uid"
[ "$(docker exec "${NAME}" awk '/^Gid:/{print $2}' /proc/1/status)" = "${SMOKE_GID}" ] || fail "wrong gid"
[ "$(docker exec "${NAME}" stat -c %u:%g /config)" = "${SMOKE_UID}:${SMOKE_GID}" ] || fail "/config not chowned"
[ "$(docker exec "${NAME}" stat -c %u /config/config.json)" = "${SMOKE_UID}" ] || fail "config.json owner"
docker exec "${NAME}" readlink /etc/localtime | grep -q 'Europe/Bucharest' || fail "TZ not applied"

step "bundled tools"
docker exec "${NAME}" sh -c 'ffmpeg -hide_banner -protocols 2>/dev/null | grep -Eq "^[[:space:]]*bluray$"' ||
  fail "ffmpeg lacks libbluray"
docker exec "${NAME}" mkvmerge --version
docker exec "${NAME}" 7z i > /dev/null || fail "7z missing"
api "${BASE}/api/v1/system/status" | jq -e '[.tools[] | .available] | all' > /dev/null ||
  fail "system status reports a missing tool: $(api "${BASE}/api/v1/system/status" | jq -c '.tools')"
# Config warnings (low free space on the runner's disk) say nothing about the image; config errors do.
api "${BASE}/api/v1/system/health" |
  jq -e 'map(select(.source == "tools" or .source == "docker" or (.source == "config" and .level == "error"))) | length == 0' > /dev/null ||
  fail "health checks: $(api "${BASE}/api/v1/system/health" | jq -c '.')"

step "backup and OpenAPI"
api -X POST "${BASE}/api/v1/system/backups" | jq -e '.kind == "manual" and .sizeBytes > 0' > /dev/null || fail "backup"
api "${BASE}/api/v1/openapi.json" | jq -e '.openapi == "3.1.0"' > /dev/null || fail "openapi.json"

step "Docker health check"
wait_until "Docker health status healthy" 120 is_healthy

step "restart through the API (container restart policy brings it back)"
[ "$(status_code -X POST -H "X-Api-Key: ${KEY}" "${BASE}/api/v1/system/restart")" = 204 ] || fail "restart"
wait_until "restart" 90 has_restarted

step "graceful stop"
docker stop -t 30 "${NAME}" > /dev/null
[ "$(container_state '{{.State.ExitCode}}')" = 0 ] || fail "exit code $(container_state '{{.State.ExitCode}}')"

echo "smoke test passed"
