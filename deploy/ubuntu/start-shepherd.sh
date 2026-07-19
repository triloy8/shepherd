#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "${SCRIPT_PATH}")"
PROJECT_DIR="${SHEPHERD_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/../.." && pwd)}"
SESSION_NAME="${SHEPHERD_TMUX_SESSION:-shepherd}"
RESTART_DELAY_SECONDS="${SHEPHERD_RESTART_DELAY_SECONDS:-5}"
LOG_DIR="${SHEPHERD_LOG_DIR:-${PROJECT_DIR}/logs}"
LOG_FILE="${LOG_DIR}/shepherd.log"
ACTION="${1:-start}"

session_exists() {
  tmux has-session -t "=${SESSION_NAME}" 2>/dev/null
}

run_shepherd() {
  cd "${PROJECT_DIR}"
  mkdir -p "${LOG_DIR}"

  while true; do
    printf '\n[%s] starting Shepherd\n' "$(date --iso-8601=seconds)" >>"${LOG_FILE}"
    set +e
    bun run start >>"${LOG_FILE}" 2>&1
    status=$?
    set -e
    printf '[%s] Shepherd exited with status %s; restarting in %ss\n' \
      "$(date --iso-8601=seconds)" "${status}" "${RESTART_DELAY_SECONDS}" \
      >>"${LOG_FILE}"
    sleep "${RESTART_DELAY_SECONDS}"
  done
}

case "${ACTION}" in
  run)
    run_shepherd
    ;;
  start)
    for command_name in tmux bun codex gh; do
      if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "missing required command: ${command_name}" >&2
        exit 1
      fi
    done

    if [[ ! -f "${PROJECT_DIR}/envs/common.env" ]]; then
      echo "missing ${PROJECT_DIR}/envs/common.env" >&2
      exit 1
    fi
    if [[ ! -f "${PROJECT_DIR}/envs/discord.env" ]]; then
      echo "missing ${PROJECT_DIR}/envs/discord.env" >&2
      exit 1
    fi
    if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
      echo "dependencies are missing; run 'bun install' in ${PROJECT_DIR}" >&2
      exit 1
    fi

    if session_exists; then
      echo "Shepherd is already running in tmux session: ${SESSION_NAME}"
      exit 0
    fi

    mkdir -p "${LOG_DIR}"
    printf -v run_command \
      'exec env SHEPHERD_PROJECT_DIR=%q SHEPHERD_TMUX_SESSION=%q SHEPHERD_RESTART_DELAY_SECONDS=%q SHEPHERD_LOG_DIR=%q %q run' \
      "${PROJECT_DIR}" "${SESSION_NAME}" "${RESTART_DELAY_SECONDS}" "${LOG_DIR}" \
      "${SCRIPT_PATH}"
    tmux new-session -d -s "${SESSION_NAME}" -c "${PROJECT_DIR}" "${run_command}"

    echo "started Shepherd in tmux session: ${SESSION_NAME}"
    echo "log: ${LOG_FILE}"
    ;;
  stop)
    if session_exists; then
      tmux kill-session -t "=${SESSION_NAME}"
      echo "stopped Shepherd tmux session: ${SESSION_NAME}"
    else
      echo "Shepherd is not running"
    fi
    ;;
  status)
    if session_exists; then
      echo "Shepherd is running in tmux session: ${SESSION_NAME}"
    else
      echo "Shepherd is not running"
      exit 1
    fi
    ;;
  logs)
    tail -n "${SHEPHERD_LOG_LINES:-100}" "${LOG_FILE}"
    ;;
  *)
    echo "usage: $0 {start|stop|status|logs}" >&2
    exit 2
    ;;
esac
