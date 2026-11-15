#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"
CONFIG_DIR="${WOLOLO_CONFIG_DIR:-/config}"

require_number() {
  case "$2" in
    '' | *[!0-9]*)
      echo "Wololo: $1 must be a number, got '$2'" >&2
      exit 1
      ;;
  esac
}

require_number PUID "${PUID}"
require_number PGID "${PGID}"

if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null || true
fi

umask "${UMASK}"

if [ "$(id -u)" = "0" ]; then
  [ "$(id -g wololo)" = "${PGID}" ] || groupmod -o -g "${PGID}" wololo
  [ "$(id -u wololo)" = "${PUID}" ] || usermod -o -u "${PUID}" wololo
  mkdir -p "${CONFIG_DIR}"
  if [ "$(stat -c %u:%g "${CONFIG_DIR}")" != "${PUID}:${PGID}" ]; then
    chown -R "${PUID}:${PGID}" "${CONFIG_DIR}" ||
      echo "Wololo: warning: could not chown ${CONFIG_DIR} (NFS root_squash or read-only mount?); continuing" >&2
  fi
  echo "Wololo: running as uid=${PUID} gid=${PGID} umask=${UMASK}"
  export HOME="${CONFIG_DIR}"
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --init-groups "$@"
fi

exec "$@"
