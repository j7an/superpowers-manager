ARG NATIVE_NODE_VERSION=24
FROM node:24.0.0-bookworm-slim AS minimum-node
FROM node:${NATIVE_NODE_VERSION}-bookworm-slim
COPY --from=minimum-node /usr/local/bin/node /opt/node-min/bin/node
RUN /opt/node-min/bin/node --version
ENV SPW_PACKAGE_NODE=/opt/node-min/bin/node
ENV SPW_PACKAGE_NODE_VERSION=24.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git python3 procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spw-test-tools
COPY tests/container/package.json tests/container/package-lock.json ./
RUN npm ci --ignore-scripts \
    && ./node_modules/.bin/codex --version >/dev/null

RUN useradd --create-home --uid 10001 spw
WORKDIR /workspace
COPY . .
RUN corepack enable \
    && pnpm install --frozen-lockfile \
    && chown -R root:root /workspace /opt/spw-test-tools /opt/node-min \
    && chmod +x src/cli.ts tests/container.sh tests/container/codex-offline-probe.sh

ENV HOME=/home/spw
ENV PATH=/opt/spw-test-tools/node_modules/.bin:$PATH
ENV SPW_CONTAINER=1
USER spw
ENTRYPOINT ["sh", "tests/container.sh", "--inside"]
