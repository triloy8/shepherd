#!/data/data/com.termux/files/usr/bin/bash
set -eu

NIO_STARTER="${NIO_STARTER:-${HOME}/nio_starter.sh}"
LOG_FILE="${HOME}/.cache/shepherd-boot.log"

if [ ! -x "${NIO_STARTER}" ]; then
  echo "missing executable chroot launcher: ${NIO_STARTER}" >&2
  exit 1
fi

termux-wake-lock
mkdir -p "${HOME}/.cache"
exec su -c "'${NIO_STARTER}' shepherd" >>"${LOG_FILE}" 2>&1
