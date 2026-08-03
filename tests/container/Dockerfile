FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git python3 \
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
    && pnpm run build \
    && chown -R root:root /workspace /opt/spw-test-tools \
    && chmod +x tests/container.sh tests/container/codex-offline-probe.sh

ENV HOME=/home/spw
ENV PATH=/opt/spw-test-tools/node_modules/.bin:$PATH
ENV SPW_CONTAINER=1
# tests/container.sh mounts /tmp as a dedicated, size-limited tmpfs that is
# discarded with the container. Naming it here makes the scratch location an
# explicit part of the image contract: suites resolve ${TMPDIR:?} rather than
# hardcoding /tmp, and tests/bin/dispatch-fixture.js refuses to run without it.
# Removing this line turns the container suite red, which is the intended guard.
ENV TMPDIR=/tmp
USER spw
ENTRYPOINT ["sh", "tests/container.sh", "--inside"]
