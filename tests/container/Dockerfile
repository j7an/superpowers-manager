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
# Both OpenCode packages declare a bin named `opencode`; the V2 package wins the
# shim and `opencode-ai` gets none, with no warning. Address each line by its
# absolute path so a lane can never silently run the other line's binary.
RUN --network=none node /opt/spw-test-tools/node_modules/opencode-ai/postinstall.mjs \
    && node /opt/spw-test-tools/node_modules/@opencode/cli/postinstall.mjs \
    && node /opt/spw-test-tools/node_modules/@anthropic-ai/claude-code/install.cjs \
    && /opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe --version \
    && /opt/spw-test-tools/node_modules/@opencode/cli/bin/opencode.exe --version \
    && ./node_modules/.bin/codex --version >/dev/null \
    && PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ./node_modules/.bin/pi --version \
    && CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ./node_modules/.bin/claude --version >/dev/null
RUN opencode_version=$(/opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe --version) \
    && mkdir -p /opt/spw-opencode-config-seed \
    && npm install --prefix /opt/spw-opencode-config-seed \
       --package-lock-only --ignore-scripts --save-exact \
       "@opencode-ai/plugin@$opencode_version" \
    && npm ci --prefix /opt/spw-opencode-config-seed --ignore-scripts \
    && node -e 'const expected=process.argv[1]; const actual=require("/opt/spw-opencode-config-seed/node_modules/@opencode-ai/plugin/package.json").version; if(actual!==expected) process.exit(1)' "$opencode_version"
# OpenCode downloads its own ripgrep release from github.com on first use and
# reports any request failure only as "ripgrep execution failed", so a
# transient fetch error is retried here rather than failing the image build.
RUN spw_rg_root=$(mktemp -d) \
    && spw_rg_attempt=1 \
    && until HOME="$spw_rg_root/home" \
       XDG_CONFIG_HOME="$spw_rg_root/config" \
       XDG_DATA_HOME="$spw_rg_root/data" \
       XDG_CACHE_HOME=/opt/spw-opencode-cache-seed \
       XDG_STATE_HOME="$spw_rg_root/state" \
       OPENCODE_DISABLE_AUTOUPDATE=1 \
       OPENCODE_DISABLE_MODELS_FETCH=1 \
       /opt/spw-test-tools/node_modules/opencode-ai/bin/opencode.exe debug rg files --limit 1; do \
         if [ "$spw_rg_attempt" -ge 3 ]; then \
           echo "OpenCode ripgrep seed failed after $spw_rg_attempt attempts" >&2; \
           exit 1; \
         fi; \
         echo "OpenCode ripgrep seed attempt $spw_rg_attempt failed; retrying" >&2; \
         sleep $((spw_rg_attempt * 5)); \
         spw_rg_attempt=$((spw_rg_attempt + 1)); \
       done \
    && rm -rf "$spw_rg_root" \
    && test -x /opt/spw-opencode-cache-seed/opencode/bin/rg \
    && /opt/spw-opencode-cache-seed/opencode/bin/rg --version >/dev/null

RUN useradd --create-home --uid 10001 spw
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile \
    && chown -R root:root /workspace /opt/spw-test-tools /opt/node-min \
    && chmod a+r node_modules/.pnpm-workspace-state-v1.json \
    && chmod +x src/cli.ts tests/container.sh tests/container/codex/offline-probe.sh tests/container/opencode/offline-probe.sh tests/container/claude-code/offline-probe.sh
RUN mkdir -p /opt/spw-package \
    && node tests/tools/pack.ts --out-dir /opt/spw-package \
    && chmod -R a+rX /opt/spw-package

ENV HOME=/home/spw
ENV PATH=/opt/spw-test-tools/node_modules/.bin:$PATH
ENV SPW_CONTAINER=1
USER spw
ENTRYPOINT ["sh", "tests/container.sh", "--inside"]
