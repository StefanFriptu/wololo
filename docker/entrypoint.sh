#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"
CONFIG_DIR="${WOLOLO_CONFIG_DIR:-/config}"

fail() {
  echo "Wololo: $*" >&2
  exit 1
}

require_number() {
  case "$2" in
    '' | *[!0-9]*) fail "$1 must be a number, got '$2'" ;;
  esac
}

require_number PUID "${PUID}"
require_number PGID "${PGID}"
case "${UMASK}" in
  '' | *[!0-7]* | ?????*) fail "UMASK must be an octal mask such as 002 or 022, got '${UMASK}'" ;;
esac

if [ -n "${TZ:-}" ]; then
  if [ -f "/usr/share/zoneinfo/${TZ}" ]; then
    if [ "$(id -u)" = "0" ]; then
      { ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime && echo "${TZ}" > /etc/timezone; } 2>/dev/null ||
        echo "Wololo: warning: could not set /etc/localtime (read-only root?); TZ still applies to Wololo" >&2
    fi
  else
    echo "Wololo: warning: unknown TZ '${TZ}', using UTC" >&2
  fi
fi

umask "${UMASK}"
export HOME="${CONFIG_DIR}"

if [ "$(id -u)" = "0" ]; then
  [ "$(id -g wololo)" = "${PGID}" ] || groupmod -o -g "${PGID}" wololo
  [ "$(id -u wololo)" = "${PUID}" ] || usermod -o -u "${PUID}" wololo
  mkdir -p "${CONFIG_DIR}"
  if [ "$(stat -c %u:%g "${CONFIG_DIR}")" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" "${CONFIG_DIR}" ||
      echo "Wololo: warning: could not chown ${CONFIG_DIR} (NFS root_squash or read-only mount?); continuing" >&2
  fi
  setpriv --reuid="${PUID}" --regid="${PGID}" --init-groups test -w "${CONFIG_DIR}" ||
    fail "${CONFIG_DIR} is not writable by ${PUID}:${PGID}: chown it on the host or set PUID/PGID to its owner"
  echo "Wololo: running as uid=${PUID} gid=${PGID} umask=${UMASK}"
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --init-groups "$@"
fi

{ mkdir -p "${CONFIG_DIR}" && [ -w "${CONFIG_DIR}" ]; } 2>/dev/null ||
  fail "${CONFIG_DIR} is not writable by $(id -u):$(id -g): chown it on the host or change the container user"
echo "Wololo: running as uid=$(id -u) gid=$(id -g) (container user set by Docker; PUID/PGID ignored)"
exec "$@"
