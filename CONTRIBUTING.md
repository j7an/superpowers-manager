# Contributing

Read [AGENTS.md](AGENTS.md) for repository rules and [RELEASING.md](RELEASING.md) for the protected release procedure. Architecture references are the [harness interface](docs/harness-interface.md) and [adapter result contract](docs/adapter-result-contract.md).

## Development and tests

Install once, run the static gate before submission, and choose the package script that matches the scope you are iterating on:

```sh
pnpm install --frozen-lockfile
pnpm run check:static
pnpm test
pnpm run test:unit
pnpm run test:integration
pnpm run test:harness:codex
pnpm run test:harness:pi
pnpm run test:acceptance
```

The package scripts above are alternative iteration selectors; do not run every row sequentially as a substitute for acceptance. `pnpm test` runs shared suites once. The harness scripts run only their named isolated Docker integration. Complete acceptance is `pnpm run check:static` followed by `pnpm run test:acceptance` with package-minimum Node evidence. A completed shared run emits both `run-node-suites: complete status=<status>` and `tests/run.sh: complete failed=<count>`; absence of either means incomplete.

Use a Homebrew-managed local pnpm; do not use Corepack. `check:static` checks formatting, lint, and no-emit typechecking. Run the maintained CLI with `node src/cli.ts`; tests import `src/` directly.

On macOS, reuse an exact package-minimum Node executable by setting and verifying `SPW_PACKAGE_NODE` and `SPW_PACKAGE_NODE_VERSION=24.0.0`:

```sh
export SPW_PACKAGE_NODE=/absolute/path/to/node-v24.0.0
export SPW_PACKAGE_NODE_VERSION=24.0.0
test "$("$SPW_PACKAGE_NODE" -p 'process.versions.node')" = "$SPW_PACKAGE_NODE_VERSION"
```

Otherwise follow the [verified package-runtime archive procedure in AGENTS.md](AGENTS.md#testing), which selects and checksum-verifies the official archive in invocation-owned temporary storage. Keep native Node on `PATH`; the package-minimum binary runs installed-package checks only. Linux CI provisions that exact runtime with `actions/setup-node`.

Layers 1-3 stay offline and hermetic: they use a fake local upstream repo and perform no mutation of the developer's or runner's real Codex or Pi state. Layer 4 is the Docker acceptance path. `pnpm run test:harness:codex` and `pnpm run test:harness:pi` each run in an isolated container home with networking disabled. `pnpm run test:acceptance` runs shared checks, Codex, then Pi.

Release validation deliberately uses both endpoints:

```sh
SPW_NATIVE_NODE_VERSION=24.12.0 sh tests/container.sh
SPW_NATIVE_NODE_VERSION=24 sh tests/container.sh
```

The `toolchain` CI jobs cover native loading, package producer behavior, static validation, shared suites, and package-minimum runtime evidence. Independent Codex and Pi harness jobs run their isolated integrations without duplicating the shared suite.

Use `sh tests/run.sh --concurrency 1` or `sh tests/run.sh --concurrency 2` for controlled shared-suite scheduling comparisons. `sh tests/manual/codex/behavior-probe.sh` is opt-in native-only compatibility residue, never acceptance. The Node 24.12.0 toolchain job covers native loading, the suite-runner assertion preload, and package-producer success/failure; latest Node 24.x alone runs static validation and the full shared suite. Release acceptance runs shared checks and both harnesses at both endpoints, while installed npm behavior uses Node 24.0.0.

## Directory convention

Responsibility determines ownership. Keep contracts and shared utilities at the root; put each concrete production integration under `src/harnesses/<name>`. Keep the test category outermost, preserve its suite groups, and place integration-specific tests below it. Shared tests may use concrete fixtures, but production harnesses must not import one another or expose barrels; existing mixed fixture corpora remain shared.

## pnpm maintenance

The weekly Monday 06:00 UTC updater, also available by manual dispatch, opens or refreshes a dedicated pull request changing only the `packageManager` pin. It selects a non-deprecated stable pnpm release within the pinned major after five days; a deprecated current pin bypasses that wait. Major upgrades remain manual, and the workflow does not update the lockfile.

The reusable caller forwards only `RELEASE_BOT_PRIVATE_KEY` and uses `vars.RELEASE_BOT_APP_ID` for App-authored pull requests that can trigger CI. Keep both configured, manually verify App authentication after adopting the caller, and inspect its pull request before treating live integration as validated.

## Packaging and layout

Package through external staging only:

```sh
node tests/tools/pack.ts --out-dir /absolute/existing/temporary/output
```

Do not use bare checkout `npm pack`. `dist/` belongs only to staging, and all of `plugins/superpowers/` except its fallback manifest template is generated.

Follow [RELEASING.md](RELEASING.md) for protected publication; package staging does not authorize a release.

```text
.agents/plugins/marketplace.json  local marketplace definition
config/upstream-ref               packaged upstream fallback
docs/                             architecture, contracts, and reference docs
src/                              in-process TypeScript runtime
tests/                            hermetic suites and harness integrations
```
