FROM node:24.0.0-bookworm-slim AS minimum-node
FROM node:24-bookworm-slim
COPY --from=minimum-node /usr/local/bin/node /opt/node-min/bin/node
RUN /opt/node-min/bin/node --version
ENV SPW_PACKAGE_NODE=/opt/node-min/bin/node
ENV SPW_PACKAGE_NODE_VERSION=24.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git procps \
    && rm -rf /var/lib/apt/lists/*

# Root package.json pins pnpm via packageManager; corepack resolves it from
# the working directory, so install the tools from /workspace to reuse that pin
# without a second one. The tools package must not carry its own
# packageManager: pnpm then writes a multi-document lockfile, which the
# dependency-safety gate refuses to parse. The hoisted linker keeps the flat
# npm-style layout the probes expect (real directories, no symlink store);
# it is a flag because pnpm reads .npmrc from the cwd, not from --dir.
COPY package.json /workspace/package.json
COPY tests/container/package.json tests/container/pnpm-lock.yaml /opt/spw-test-tools/
WORKDIR /workspace
RUN corepack enable \
    && pnpm --dir /opt/spw-test-tools --config.node-linker=hoisted install --frozen-lockfile --ignore-scripts
WORKDIR /opt/spw-test-tools
RUN --network=none node node_modules/opencode-ai/postinstall.mjs \
    && ./node_modules/.bin/opencode --version \
    && ./node_modules/.bin/codex --version >/dev/null \
    && PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ./node_modules/.bin/pi --version
RUN opencode_version=$(./node_modules/.bin/opencode --version) \
    && mkdir -p /opt/spw-opencode-config-seed \
    && npm install --prefix /opt/spw-opencode-config-seed \
       --package-lock-only --ignore-scripts --save-exact \
       "@opencode-ai/plugin@$opencode_version" \
    && npm ci --prefix /opt/spw-opencode-config-seed --ignore-scripts \
    && node -e 'const expected=process.argv[1]; const actual=require("/opt/spw-opencode-config-seed/node_modules/@opencode-ai/plugin/package.json").version; if(actual!==expected) process.exit(1)' "$opencode_version"
RUN spw_rg_root=$(mktemp -d) \
    && HOME="$spw_rg_root/home" \
       XDG_CONFIG_HOME="$spw_rg_root/config" \
       XDG_DATA_HOME="$spw_rg_root/data" \
       XDG_CACHE_HOME=/opt/spw-opencode-cache-seed \
       XDG_STATE_HOME="$spw_rg_root/state" \
       OPENCODE_DISABLE_AUTOUPDATE=1 \
       OPENCODE_DISABLE_MODELS_FETCH=1 \
       ./node_modules/.bin/opencode debug rg files --limit 1 \
    && rm -rf "$spw_rg_root" \
    && test -x /opt/spw-opencode-cache-seed/opencode/bin/rg \
    && /opt/spw-opencode-cache-seed/opencode/bin/rg --version >/dev/null

RUN useradd --create-home --uid 10001 spw
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile \
    && chown -R root:root /workspace /opt/spw-test-tools /opt/node-min \
    && chmod a+r node_modules/.pnpm-workspace-state-v1.json \
    && chmod +x src/cli.ts tests/container.sh tests/container/codex/offline-probe.sh tests/container/opencode/offline-probe.sh
RUN mkdir -p /opt/spw-package \
    && node tests/tools/pack.ts --out-dir /opt/spw-package \
    && chmod -R a+rX /opt/spw-package

ENV HOME=/home/spw
ENV PATH=/opt/spw-test-tools/node_modules/.bin:$PATH
ENV SPW_CONTAINER=1
USER spw
ENTRYPOINT ["sh", "tests/container.sh", "--inside"]
