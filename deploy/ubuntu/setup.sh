#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SHEPHERD_PROJECT_DIR:-$(cd -- "${SCRIPT_DIR}/../.." && pwd)}"
CODEX_VERSION="${CODEX_VERSION:-latest}"

if [[ "${EUID}" -eq 0 ]]; then
  echo "run this setup as the Ubuntu user nio, not root" >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required to install Ubuntu packages" >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl git gh tmux unzip

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun installation completed but bun is not available at ${BUN_INSTALL}/bin" >&2
  exit 1
fi

bun add --global "@openai/codex@${CODEX_VERSION}"

cd "${PROJECT_DIR}"
bun install --frozen-lockfile

if [[ ! -f envs/common.env ]]; then
  cp envs/common.env.example envs/common.env
fi
if [[ ! -f envs/discord.env ]]; then
  cp envs/discord.env.example envs/discord.env
fi
chmod 600 envs/common.env envs/discord.env

echo
echo "Ubuntu provisioning complete."
echo "Next: configure envs/*.env, then run 'codex login' and 'gh auth login'."
