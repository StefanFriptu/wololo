#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"

if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null || true
fi

umask "${UMASK}"

if [ "$(id -u)" = "0" ]; then
  groupmod -o -g "${PGID}" wololo
  usermod -o -u "${PUID}" wololo
  mkdir -p "${WOLOLO_CONFIG_DIR:-/config}"
  chown -R wololo:wololo "${WOLOLO_CONFIG_DIR:-/config}"
  echo "Wololo: running as uid=${PUID} gid=${PGID} umask=${UMASK}"
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --init-groups "$@"
fi

exec "$@"
