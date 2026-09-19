ARG BUN_VERSION=1.3.9

FROM oven/bun:${BUN_VERSION}-slim AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY server ./server
COPY shared ./shared
COPY ui ./ui
COPY tsconfig.server.json ./
COPY tests/adapter_ports.typecheck.ts tests/tsconfig.contracts.json ./tests/
RUN bun run check

FROM oven/bun:${BUN_VERSION}-slim AS runtime

ARG CODEX_VERSION=0.154.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates gh git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /home/bun/.agent-workspaces /home/bun/.agents /home/bun/.bun/bin \
      /home/bun/.bun/install/global /home/bun/.config/gh \
    && chown -R bun:bun /app /home/bun

ENV HOME=/home/bun
ENV CODEX_HOME=/home/bun/.agents
ENV PATH=/home/bun/.bun/bin:${PATH}
ENV BUN_INSTALL_BIN=/home/bun/.bun/bin
ENV BUN_INSTALL_GLOBAL_DIR=/home/bun/.bun/install/global

USER bun
WORKDIR /app

RUN bun add --global @openai/codex@${CODEX_VERSION}

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun server ./server
COPY --chown=bun:bun shared ./shared
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/ui/dist ./ui/dist

CMD ["bun", "run", "start"]
