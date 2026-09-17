#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
STATE_DIR="${HOME}/.local/state/tailscale"
INSTALL_DIR="${HOME}/.local/lib/tailscale"
SESSION_NAME="shepherd-tailscale"
SOCKET="${STATE_DIR}/tailscaled.sock"
VERSION="1.102.4"

binaries() {
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64) ARCH=amd64 ;;
    *) echo "unsupported Tailscale architecture" >&2; return 1 ;;
  esac
  BIN_DIR="${INSTALL_DIR}/tailscale_${VERSION}_${ARCH}"
}

cli() {
  "${BIN_DIR}/tailscale" --socket="${SOCKET}" "$@"
}

install() (
  for dependency in curl tar sha256sum tmux flock; do
    command -v "${dependency}" >/dev/null || { echo "missing dependency: ${dependency}" >&2; return 1; }
  done
  mkdir -p "${INSTALL_DIR}" "${STATE_DIR}"
  chmod 700 "${STATE_DIR}"
  staging= archive= checksum=
  staging="$(mktemp -d "${INSTALL_DIR}/.install.XXXXXX")"
  trap 'rm -rf -- "${staging}"' EXIT
  archive="tailscale_${VERSION}_${ARCH}.tgz"
  curl --fail --silent --show-error --location "https://pkgs.tailscale.com/stable/${archive}" -o "${staging}/${archive}"
  checksum="$(curl --fail --silent --show-error --location "https://pkgs.tailscale.com/stable/${archive}.sha256")"
  [[ "${checksum}" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "invalid archive checksum" >&2; return 1; }
  printf '%s  %s\n' "${checksum}" "${staging}/${archive}" | sha256sum --check --status
  tar -xzf "${staging}/${archive}" -C "${staging}"
  # Existing version directories may be in use by a running daemon.
  if [[ ! -d "${BIN_DIR}" ]]; then
    mv "${staging}/tailscale_${VERSION}_${ARCH}" "${BIN_DIR}"
  fi
  "${BIN_DIR}/tailscale" version
  touch "${STATE_DIR}/enabled"
  echo "Tailscale enabled for host startup. Run: ${SCRIPT_PATH} login"
)

binaries
case "${1:-status}" in
  install) install ;;
  start)
    [[ -f "${STATE_DIR}/enabled" ]] || exit 0
    [[ -x "${BIN_DIR}/tailscaled" ]] || { echo "Tailscale missing; run $0 install" >&2; exit 1; }
    if tmux has-session -t "=${SESSION_NAME}" 2>/dev/null; then
      echo "Tailscale session already running"
      exit 0
    fi
    printf -v run_command 'exec %q run' "${SCRIPT_PATH}"
    tmux new-session -d -s "${SESSION_NAME}" "${run_command}"
    ;;
  run)
    mkdir -p "${STATE_DIR}"
    chmod 700 "${STATE_DIR}"
    exec 9>"${STATE_DIR}/supervisor.lock"
    flock -n 9 || exit 0
    daemon_pid=''
    trap 'if [[ -n "${daemon_pid}" ]]; then kill "${daemon_pid}" 2>/dev/null || true; wait "${daemon_pid}" 2>/dev/null || true; fi; exit 0' TERM INT HUP
    while [[ -f "${STATE_DIR}/enabled" ]]; do
      # Do not replace an independently running daemon using the same state.
      if cli status --json >/dev/null 2>&1; then
        sleep 5
        continue
      fi
      printf '\n[%s] starting tailscaled\n' "$(date --iso-8601=seconds)" >>"${STATE_DIR}/daemon.log"
      "${BIN_DIR}/tailscaled" --tun=userspace-networking --statedir="${STATE_DIR}" --socket="${SOCKET}" >>"${STATE_DIR}/daemon.log" 2>&1 &
      daemon_pid=$!
      wait "${daemon_pid}" || true
      daemon_pid=''
      sleep 5
    done
    ;;
  login)
    [[ -f "${STATE_DIR}/enabled" ]] || { echo "run $0 install first" >&2; exit 1; }
    "${SCRIPT_PATH}" start
    ready=false
    for ((attempt=0; attempt<30; attempt++)); do
      if cli status --json >/dev/null 2>&1; then ready=true; break; fi
      sleep 1
    done
    [[ "${ready}" = true ]] || { echo "Tailscale did not start; run $0 logs" >&2; exit 1; }
    cli up --hostname=shepherd-host --accept-dns=false --accept-routes=false --timeout=60s
    ;;
  stop)
    if tmux has-session -t "=${SESSION_NAME}" 2>/dev/null; then
      tmux kill-session -t "=${SESSION_NAME}"
    fi
    ;;
  disable)
    rm -f "${STATE_DIR}/enabled"
    "${SCRIPT_PATH}" stop
    ;;
  status) cli status ;;
  logs) tail -n 100 "${STATE_DIR}/daemon.log" ;;
  cli) shift; cli "$@" ;;
  *) echo "usage: $0 {install|start|stop|disable|login|status|logs|cli ...}" >&2; exit 2 ;;
esac
