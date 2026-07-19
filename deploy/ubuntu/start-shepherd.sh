#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SHEPHERD_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/../.." && pwd)}"
DOCKER_WAIT_SECONDS="${DOCKER_WAIT_SECONDS:-60}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed in the Ubuntu chroot" >&2
  exit 1
fi

run_as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "root access is required to start dockerd" >&2
    return 1
  fi
}

DOCKER=(docker)
if ! docker info >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
  DOCKER=(sudo docker)
fi

docker_ready() {
  "${DOCKER[@]}" info >/dev/null 2>&1
}

if ! docker_ready; then
  echo "docker daemon is not ready; starting it"

  if command -v service >/dev/null 2>&1; then
    run_as_root service docker start >/dev/null 2>&1 || true
    for ((attempt = 1; attempt <= 5; attempt++)); do
      docker_ready && break
      sleep 1
    done
  fi

  if ! docker_ready; then
    run_as_root sh -c \
      'nohup dockerd >>/var/log/shepherd-dockerd.log 2>&1 </dev/null &'
  fi

  for ((attempt = 1; attempt <= DOCKER_WAIT_SECONDS; attempt++)); do
    if docker_ready; then
      break
    fi
    sleep 1
  done
fi

if ! docker_ready; then
  echo "docker did not become ready within ${DOCKER_WAIT_SECONDS} seconds" >&2
  echo "inspect /var/log/shepherd-dockerd.log inside the Ubuntu chroot" >&2
  exit 1
fi

if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  echo "the Docker Compose plugin is not installed" >&2
  exit 1
fi

cd "${PROJECT_DIR}"
"${DOCKER[@]}" compose up -d --remove-orphans
"${DOCKER[@]}" compose ps
