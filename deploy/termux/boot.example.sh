#!/data/data/com.termux/files/usr/bin/bash
set -eu

termux-wake-lock

# This hook must enter the Ubuntu chroot and run:
#   /path/to/shepherd/deploy/ubuntu/start-shepherd.sh
# Keep the device-specific mount and chroot command outside this repository.
CHROOT_HOOK="${SHEPHERD_CHROOT_HOOK:-${HOME}/.shepherd-start-in-ubuntu}"

if [ ! -x "${CHROOT_HOOK}" ]; then
  echo "missing executable chroot hook: ${CHROOT_HOOK}" >&2
  exit 1
fi

mkdir -p "${HOME}/.cache"
nohup "${CHROOT_HOOK}" >>"${HOME}/.cache/shepherd-boot.log" 2>&1 </dev/null &
