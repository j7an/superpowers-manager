# Superpowers Manager

Install and update the latest stable
[`obra/superpowers`](https://github.com/obra/superpowers) release directly from
upstream, without waiting for agent marketplaces to catch up.
Codex and the Pi coding agent are supported today.

> Unofficial community integration. Not affiliated with the
> `obra/superpowers` maintainers.

## Quick start

```sh
npx superpowers-manager install
npx superpowers-manager probe
npx superpowers-manager update
```

Use Superpowers Manager to follow the latest stable Superpowers release directly
from upstream and apply updates with one command. By default, `install` and
`update` resolve the highest stable `vX.Y.Z` tag when invoked; saved pins and
invocation overrides take precedence. `probe` reports whether your installation
matches that selection without changing the selected harness state. Updates are
user-triggered. Commands target Codex by default; use `--harness pi` for Pi.

| Choose | Version source | Best fit |
|---|---|---|
| `superpowers-manager` | Latest stable upstream tag by default, or your saved/overridden selection | Follow upstream stable with drift reporting and verified updates |
| Direct upstream repository | The configured Git ref, or the repository's default branch | Use Codex's native Git marketplace support |
| `superpowers@openai-curated` | The copy distributed in the curated marketplace | Use the curated integration and its refresh policy |

See [Comparing Codex installation routes](#comparing-codex-installation-routes)
for commands and update behavior. Use one provider at a time; see
[Provider ownership](#provider-ownership) before switching.

### Moving from `superpowers-wrapper`

```sh
npx superpowers-wrapper@0.1.1 uninstall
npx superpowers-manager install
```

The manager detects legacy wrapper-owned Codex state and stops before mutation.
It never removes the legacy provider automatically.

## Requirements and platforms

The installed Superpowers Manager package requires Node >=24. Native source,
tests, and packaging tooling require Node >=24.12.0. Commands target Codex by
default; Pi must be selected explicitly with `--harness pi`. Every other
requirement is per command, enforced by preflight before any dispatch. This table
is checked against production by
`tests/bin/readme-requirements.test.ts`; edit it when a command's requirements
change, in the same pull request.

<!-- requirements:begin -->
| Command | git | Python 3 | Codex CLI (default) | Pi CLI (`--harness pi`) |
|---|---|---|---|---|
| `pin` | yes | no | no | no |
| `track-latest` | no | no | no | no |
| `unpin` | no | no | no | no |
| `prepare` | yes | only with SUPERPOWERS_VALIDATOR | no | no |
| `probe` | yes | no | yes | no |
| `install` | yes | no | yes | yes |
| `update` | yes | no | yes | yes |
| `uninstall` | no | no | yes | yes |
<!-- requirements:end -->

See `docs/baseline/behavioral-inventory.md`'s `CLI-PREFLIGHT-01` for the
behaviour this table describes.

Pi support is qualified against exactly `pi-coding-agent` 0.85.1. Every other Pi
version is unsupported until separately qualified, including newer versions;
`--allow-experimental` does not bypass this runtime boundary. Set
`SUPERPOWERS_PI` to select a non-default Pi executable. Activation preflight
checks bounded `pi --version` output; product code does not import or execute the
Pi extension to classify a candidate.

Integration generations describe runtime mechanisms, not each upstream release.
Pi receipts record the compatibility generation alongside the selected source
and exact commit. A generation retired by the current adapter cannot be
activated. `--allow-experimental` permits only a verifiable candidate
within implemented experimental mechanics; it cannot admit unsupported or
unverified mechanics, and it never updates or removes an existing snapshot on
its own.

macOS and Linux are tested. WSL2 is supported for the established Codex path.
Pi integration is tested on macOS and in an isolated Linux container. Running Pi
inside WSL2 has not been separately tested. Native Windows is untested.
The launcher no longer looks for Git Bash at all —
every command runs in-process, so no POSIX shell is discovered or required — but
path handling between MSYS and Codex remains a known risk area.

Network needs depend on the saved policy. `pin` verifies its target;
`track-latest` and invocation overrides resolve from upstream when applied; and
`prepare`, `install`, and `update` fetch or verify the effective source. A probe
of a saved exact pin can reuse its recorded identity without upstream access.
Updates remain user-triggered; the manager does not run automatic or background
updates.

## Comparing Codex installation routes

### Getting the latest stable release

The manager selects the highest stable upstream `vX.Y.Z` tag when its effective
policy is `latest-release`. It does not require the curated marketplace to
publish that release first. Saved pins and environment overrides can select a
different version or source; see [Choosing the upstream version](#choosing-the-upstream-version).

The direct repository route uses the Git ref you configure. Adding the repository
without `--ref` uses its default branch, which is not a latest-stable release
policy. The curated route uses the
[copy in `openai/plugins`](https://github.com/openai/plugins/tree/main/plugins/superpowers).
Refreshing that snapshot does not independently resolve the latest stable tag
from `obra/superpowers`; curated may match upstream or lag behind it.

The native CLI examples below were checked against Codex `0.153.3`. Upstream's
[marketplace manifest](https://github.com/obra/superpowers/blob/main/.agents/plugins/marketplace.json)
names its marketplace `superpowers-dev`.

### First install

These are alternative routes; do not run both to install duplicate providers.

| Step | Superpowers Manager | Direct upstream repository |
|---|---|---|
| 1 | `npx superpowers-manager install` | `codex plugin marketplace add https://github.com/obra/superpowers` |
| 2 | — | `codex plugin add superpowers@superpowers-dev` |

The manager follows upstream stable by default. For a specific release on the
direct route, choose its tag and add `--ref TAG` to the marketplace-add command.

### Staying current

| Action | Superpowers Manager | Direct upstream repository |
|---|---|---|
| Explicit update | `npx superpowers-manager update` | `codex plugin marketplace upgrade superpowers-dev` |
| Optional inspection | `npx superpowers-manager probe` | `codex plugin list` |

The manager probes first, skips prepare/install when current and update control
is valid, and verifies the resulting installed state after a refresh. `probe`
reports requested and resolved refs, desired/generated/installed commits, and
status. With a saved pin, "current" means matching that pin, not necessarily
matching the latest upstream release. See [Lifecycle commands](#lifecycle-commands).

Native marketplace upgrade follows its configured ref. In the checked Codex
version, it can skip unchanged snapshots and refreshes installed plugins when
the marketplace changes; a second `plugin add` is not required for that refresh.
Codex also has an automatic refresh path for configured Git marketplaces.
See the [native upgrade implementation](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core-plugins/src/manager.rs).
`plugin list` shows installed versions; comparing them with upstream stable is
separate inspection work, not a prerequisite for running an update.

### Changing the selected version

Replace `TAG` below with the exact release tag you want. For an already registered
direct marketplace, remove/add is a CLI route to changing its ref:

| Step | Superpowers Manager | Direct upstream repository |
|---|---|---|
| 1 | `npx superpowers-manager pin TAG` | `codex plugin marketplace remove superpowers-dev` |
| 2 | `npx superpowers-manager update` | `codex plugin marketplace add https://github.com/obra/superpowers --ref TAG` |
| 3 | — | `codex plugin add superpowers@superpowers-dev` |

The manager's `pin` saves verified intent without changing Codex state; `update`
applies it. To resume following stable releases, run
`npx superpowers-manager track-latest`, then `npx superpowers-manager update`.
The native sequence changes marketplace configuration immediately. In the checked
CLI, `marketplace upgrade` has no `--ref` option, and adding the same marketplace
name with a different ref is rejected. This sequence does not imply that editing
native configuration is impossible.

## What it does

- Resolves an upstream ref, defaulting to the latest stable `vX.Y.Z` release
  tag.
- Clones/fetches upstream at that commit and assembles a Codex plugin tree under
  `plugins/superpowers/` (skills, assets, license/readme, manifest, and any
  hook files that the upstream manifest allows).
- Stamps the generated manifest with a ref-aware manager version ending in
  `+manager.<short-sha>` and writes the upstream provenance to
  `.superpowers-upstream.json`.
- Validates the generated tree with the manager's shipped contract validator
  before swapping it into place (a failed run never destroys a previously
  generated tree).
- For Pi, prepares a separately validated package snapshot under the Pi agent
  directory, then publishes and verifies an owned frozen installation.
- Registers the `superpowers-manager` marketplace and installs or refreshes
  `superpowers@superpowers-manager` in Codex, or registers the owned package
  snapshot in Pi when that harness is selected.

The generated plugin carries upstream skills, assets, documentation, and the
upstream-owned hook policy. When upstream provides a Codex manifest, its
`hooks` declaration is preserved: exact `{}` suppresses the `hooks/` subtree;
active declarations conditionally materialize the upstream hook files; and a
missing `hooks` key or explicit empty array (`[]`) declaration uses Codex's
default discovery only when upstream ships `hooks/hooks.json`. Manifest-less
fallback refs use the committed minimal template and generate neither a manifest
`hooks` key nor a `hooks/` directory.
The manager never creates its own hooks or mutates Codex trust state.

Review upstream hook command definitions with Codex's `/hooks` flow. Codex
trust applies to a command definition, not to the contents of scripts that the
definition references. An explicit update of an older pin can therefore change
the contents of a trusted referenced script, or reveal a newly untrusted
upstream definition; review it before trusting or running it. This policy
eliminates latent hook-policy drift.

## Runtime architecture

- The in-process TypeScript runtime under `src/` owns lifecycle dispatch,
  status, and adapter-result handling;
  see the [in-process adapter result contract](https://github.com/j7an/superpowers-manager/blob/main/docs/adapter-result-contract.md).
- Developers extending that runtime should start with the
  [internal harness interface](https://github.com/j7an/superpowers-manager/blob/main/docs/harness-interface.md).
- `src/codex-harness.ts` binds Codex preparation, inspection, reconciliation,
  and mutation; `src/pi-harness.ts` binds the corresponding Pi operations.
- Codex remains the default. `prepare`, `probe`, `install`, `update`, and
  `uninstall` accept `--harness pi` (or `--harness=pi`) for an invocation;
  selection commands remain shared and do not accept a harness target.

Validation checks the manager-owned manifest overlay, generated-tree structure,
skill frontmatter envelope, known local paths, and provenance. It deliberately
does not implement a general YAML parser or mirror every Codex ingestion rule;
upstream owns skill semantics and Codex owns its evolving schema.

`SUPERPOWERS_VALIDATOR=/path/to/validator.py` adds an optional Python validator
after the built-in check. It receives the candidate plugin root as its only
argument. It cannot replace or bypass built-in validation, and either check
failing prevents the prepared-tree swap and selected-harness mutation.

`SUPERPOWERS_VALIDATOR_EXECUTABLE=/path/to/validator` adds an optional external
validator after the built-in check. It names an executable, receiving the
candidate plugin root as its only argument. The manager constructs no shell
command string and supplies argv directly. On Linux, `execvp` may hand that
same argv to `/bin/sh` after `ENOEXEC`, and the values are preserved rather
than re-parsed, so a candidate path containing spaces or shell metacharacters
is passed through intact and cannot inject a command — on either platform. A
file with the exec bit set but no valid executable format is handled by the
platform's own `execvp` fallback, not by the manager: on Linux, `/bin/sh` runs
it as shell source; on darwin, it is
rejected outright as not runnable. Give the validator a shebang line or make
it a real binary, or its behavior will differ by platform. Exit 0 accepts;
any nonzero exit rejects and prevents the tree swap. The manager stops
waiting after 30 seconds and keeps at most 64 KiB of each of its output
streams. It cannot replace or bypass built-in validation, and it is not a
security boundary: it runs with the manager's own privileges, by design.

`SUPERPOWERS_VALIDATOR` is deprecated in favor of `SUPERPOWERS_VALIDATOR_EXECUTABLE`
and continues to work unchanged. The legacy variable requires `python3`; the
executable hook does not. Setting both is rejected at preflight, before any
network or harness access, rather than silently resolved. Removal of the legacy
variable is deferred to a future major release.

The CLI selects one concrete harness adapter per invocation. Install prepares
the exact candidate first, then that adapter performs its ownership,
compatibility, and update-control checks before any selected-harness mutation.

## Provider ownership

If another `superpowers` provider is installed in the selected harness, remove
or disable it yourself before installing this one. The manager never adopts or
removes another provider. In Codex it mutates only
`superpowers@superpowers-manager` and the `superpowers-manager` marketplace. In
Pi it mutates only its owned registration and snapshot under the Manager state
directory. Targeting one harness never updates or removes the other harness's
installation.

For example, if you intentionally want the manager to take over from the
official provider:

```sh
codex plugin remove superpowers@openai-curated
npx superpowers-manager install
```

Manager install, update, and uninstall commands inspect current and conflicting
identities and fail closed when required state cannot be read or parsed. If
legacy `superpowers-wrapper` Codex state remains, use the migration commands
above. If Pi already registers another Superpowers package or exposes unmanaged
native Superpowers resources, remove or migrate it manually. The manager will
not remove either kind of conflicting state for you.

## Lifecycle commands

| Command | Selected-harness side effects | Purpose |
|---|---|---|
| `npx superpowers-manager pin REF` | None | Resolve and save an exact upstream release tag or full commit |
| `npx superpowers-manager track-latest` | None | Save a policy that resolves the latest stable release when applied |
| `npx superpowers-manager unpin` | None | Remove saved selection and return to the packaged fallback policy |
| `npx superpowers-manager prepare [--harness pi]` | None | Resolve upstream, build a staged target artifact, validate it, and replace only that target's prepared artifact on success |
| `npx superpowers-manager probe [--harness pi]` | None | Report selection, prepared/installed identities, ownership, compatibility, resource state, and status |
| `npx superpowers-manager install [--harness pi]` | Owned target state | Prepare and validate, activate the selected target, and verify installed state |
| `npx superpowers-manager update [--harness pi]` | Owned target state when stale | Probe, prepare and/or install as needed, then verify the refresh |
| `npx superpowers-manager uninstall [--harness pi]` | Owned target state | Remove only manager-owned state for the selected harness and verify removal |

Calling `npx superpowers-manager` without a subcommand is equivalent to the
default Codex `update`. `probe` is read-only. Install and update stop before
mutation when conflicting state is present. Uninstall removes only manager-owned
state and reports unmanaged residue without modifying it. These commands fail
closed when required state cannot be inspected and refuse to report success
when resulting manager state cannot be verified.

### Using Pi

The upstream selection is shared across harnesses; `pin`, `track-latest`, and
`unpin` never select or activate a harness. The `v6.3.0` tag below is an
illustrative exact pin. Only the commands carrying `--harness pi` prepare,
inspect, activate, update, or remove Pi state:

```sh
npx superpowers-manager pin v6.3.0
npx superpowers-manager prepare --harness pi
npx superpowers-manager install --harness pi
npx superpowers-manager probe --harness pi
npx superpowers-manager update --harness pi --allow-experimental
npx superpowers-manager uninstall --harness pi
```

At the qualified Pi runtime, the exact package profile from the official
`obra/superpowers` source is `supported`. The same known-complete profile from a
custom source is `experimental` and requires `--allow-experimental` immediately
before install or update activation. A missing, changed, or unknown
bootstrap/profile is `unsupported`; the flag cannot admit it or an unqualified
Pi runtime.

Pi activation copies a validated frozen snapshot to
`$PI_CODING_AGENT_DIR/superpowers-manager/installed` (defaulting under
`$HOME/.pi/agent`) and registers a canonical path relative to the Pi agent
directory. The snapshot persists independently of the generated Codex plugin
tree. A successful install, activating update, or removal tells you to restart
Pi; an already-current or read-only probe does not.

Mutating commands refuse an overlapping Manager operation immediately. An
unresolved recovery journal blocks later mutation and names the material to
preserve for manual recovery. If native deregistration succeeds but later
snapshot cleanup cannot be verified, uninstall reports partial cleanup and
leaves the snapshot or recovery material in place instead of claiming success.
`probe --harness pi` does not acquire a mutation lock, change settings, repair a
journal, or remove files: it reports busy, uninspectable, and recovery-required
state and verifies that the observed identities stayed stable. It may still need
the network to resolve a non-exact selection.

## Choosing the upstream version

Save a tag pin, commit pin, or explicit latest-stable policy for future
invocations:

```sh
npx superpowers-manager pin v6.1.1
npx superpowers-manager pin 0123456789abcdef0123456789abcdef01234567  # replace with a real upstream commit
npx superpowers-manager track-latest
npx superpowers-manager unpin
```

The selection commands save intent only; they do not prepare generated content
or change either harness's state. Run `npx superpowers-manager install` for a
first default Codex installation, use the Pi forms above for Pi, or run the
matching `update` to apply the saved policy to an existing installation. There
is no background updater: selection changes take effect only through a
user-triggered `prepare`, `install`, or `update`.

`pin` accepts only an exact `vMAJOR.MINOR.PATCH` tag (optionally with a SemVer
prerelease suffix) or a full 40-character commit. It resolves and verifies the
target before saving both the exact commit identity and its source. The saved
identity is the contract, not the contents of a clone cache: clearing or moving
`SUPERPOWERS_CACHE_DIR` does not change the selection. `track-latest` saves the
source and resolves the highest stable `vX.Y.Z` tag each time the policy is
applied. `unpin` removes only the saved selection and restores the packaged
`config/upstream-ref` fallback, currently `latest-release`.

The user-wide selection file is `selection.json` under the first configured
location:

1. `$SUPERPOWERS_CONFIG_DIR`
2. `$XDG_CONFIG_HOME/superpowers-manager`
3. `$HOME/.config/superpowers-manager`

Each location must be absolute. The ref and source precedence chains are
independent:

- Ref: `SUPERPOWERS_REF`, then saved selection, then `config/upstream-ref`.
- Source: `SUPERPOWERS_UPSTREAM_URL`, then saved source, then the official
  `https://github.com/obra/superpowers` source.

`SUPERPOWERS_REF` is an invocation-only override and is not persisted. Unlike
an exact saved pin, it accepts stable tags, full commit SHAs, branches, and
other resolvable upstream refs for that invocation:

```sh
SUPERPOWERS_REF=feature/foo npx superpowers-manager probe
```

`pin` and `track-latest` bind the current `SUPERPOWERS_UPSTREAM_URL`, or the
official source when that variable is unset, to the saved intent. An invocation
may override only the ref or only the source; `probe` exposes
`selection_origin`, `selection_mode`, `upstream_source_origin`,
`effective_source`, the saved-selection fields, and a mixed-origin warning in
human output so that combination remains visible.

A saved exact pin lets `probe` determine the desired upstream identity without
contacting Git, even when the saved source is temporarily unavailable. This is
not a general offline installation promise: `pin` verifies the requested
target, `track-latest` must resolve when applied, and `prepare`/`install`/`update`
must fetch or verify content from the effective source. Selected-harness
inspection is still required for lifecycle status.

HTTP(S) upstream URLs containing userinfo are now rejected, including
token-only userinfo. This is an intentional compatibility break: use a Git
credential helper for HTTP(S) authentication or an SSH source instead of
embedding credentials in the URL.

Saved selection does not claim or transfer provider ownership. The manager
continues to mutate only its owned Codex or Pi state and never removes or
updates an official or third-party provider automatically.

## How Codex plugin versioning works

- **Upstream manifest first:** when upstream provides
  `.codex-plugin/plugin.json`, `prepare` uses it as the generated manifest base
  so future upstream metadata fields, including its hook declaration, are
  preserved by default.
- **Fallback template:** `plugins/superpowers/.codex-plugin/plugin.template.json`
  is committed as a minimal fallback for older upstream refs that do not ship a
  Codex manifest. It carries the placeholder version
  `0.0.0+manager.template`, declares no hooks, and produces no `hooks/`
  directory.
- **Manager overlay:** `prepare` replaces the version with a ref-aware manager
  version and forces `skills` to `./skills/`. Unknown upstream manifest fields,
  including `hooks`, remain preserved; the adapter materializes hook files only
  according to the upstream declaration.
- Stable tags generate release-looking versions such as
  `6.0.3+manager.896224c`; explicit prerelease tags generate versions such as
  `6.1.0-beta.1+manager.abc1234`.
- Branch builds deliberately stay below real releases:
  `main` generates `0.0.0-main+manager.<short-sha>` and other named refs
  generate `0.0.0-ref-<sanitized-ref>+manager.<short-sha>`.
- Raw 40-character commit SHAs generate `0.0.0+manager.<short-sha>`.
- **`.superpowers-upstream.json`** records the authoritative provenance:
  `source`, `requested_ref`, `resolved_ref`, `commit`, and the upstream manifest
  version. The generated manifest version is for human readability and Codex
  package identity; the upstream `commit` is what `probe`/`update` compare
  against.

## Codex refresh modes

Codex `install` and `update` accept `SUPERPOWERS_INSTALL_REFRESH_MODE`:

- `add-only` (default) — `plugin add` re-reads the local source, which refreshes
  a mutated tree. Verified sufficient for local marketplaces.
- `remove-add` — removes the manager's own plugin first, then re-adds it. Use
  only if a refresh ever fails to take:

  ```sh
  SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add npx superpowers-manager update
  ```

## pnpm updates

A weekly Monday workflow (06:00 UTC), also available through manual dispatch,
opens or refreshes a dedicated pull request updating only `package.json`'s
`packageManager` pin. It selects a newer, non-deprecated stable pnpm release
within the pinned major after five days. If the current pin is deprecated,
the shared updater bypasses that waiting period and discloses it in the PR.
Major upgrades remain a manual decision; the lockfile is not updated by this
workflow.

The caller forwards only `RELEASE_BOT_PRIVATE_KEY` and uses
`vars.RELEASE_BOT_APP_ID` for App-authored PRs that can trigger CI. Keep both
configured. After adopting the caller, verify a manual run's App authentication
and inspect any resulting PR before treating live integration as validated.

## Tests

Install once, run the static gate before submission, and choose the package
script that matches the scope you are iterating on:

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

The package scripts above are alternative iteration selectors; do not run every
row sequentially as a substitute for acceptance. `pnpm test` runs all shared
suites once, while the unit and integration scripts select one shared group.
`test:harness:codex` and `test:harness:pi` run only their named isolated Docker
harness integration. Complete acceptance is `pnpm run check:static` followed by
`pnpm run test:acceptance` with explicit evidence for the package's minimum Node
runtime. The acceptance script runs shared checks once, then Codex, then Pi; a
failure stops the sequence and each phase emits a distinct progress/completion
label.

To compare shared-suite scheduling while iterating, use:

```sh
sh tests/run.sh --concurrency 1
sh tests/run.sh --concurrency 2
```

Every normally completed shared run emits both `run-node-suites: complete
status=<status>` and `tests/run.sh: complete failed=<count>`. Either sentinel
may report failure; if either is absent, the run was interrupted and is
incomplete.

Use a Homebrew-managed local pnpm by command name; do not use Corepack.
`check:static` checks formatting, lints, and typechecks production and tests without
emitting JavaScript. Run the maintained CLI directly with `node src/cli.ts`.
Tests and their subprocesses execute TypeScript against `src/` with no checkout
build. Future production coverage covers `src/`, including `src/cli.ts`; emitted
distribution files, tests, and packaging tools are outside that source scope.
No coverage collection is enabled by this migration.

On macOS, reuse an existing exact package-minimum Node executable when one is
already available:

```sh
export SPW_PACKAGE_NODE=/absolute/path/to/node-v24.0.0
export SPW_PACKAGE_NODE_VERSION=24.0.0
test "$("$SPW_PACKAGE_NODE" -p 'process.versions.node')" = "$SPW_PACKAGE_NODE_VERSION"
```

Otherwise, run this prerequisite setup from the worktree while a supported
native Node remains on `PATH`. It downloads an official Node archive into a
new temporary directory and verifies the selected checksum before extraction:

```sh
spw_runtime_dir=$(mktemp -d)
SPW_PACKAGE_NODE_VERSION=$(node -p 'const e=require("./package.json").engines.node; const m=/^>=(\d+)$/.exec(e); if(!m) throw Error("unsupported engines.node"); `${m[1]}.0.0`')
case "$(uname -m)" in
  arm64) spw_node_arch=arm64 ;;
  x86_64) spw_node_arch=x64 ;;
  *) echo "unsupported macOS architecture" >&2; exit 1 ;;
esac
spw_node_archive="node-v${SPW_PACKAGE_NODE_VERSION}-darwin-${spw_node_arch}.tar.gz"
(
  set -eu
  cd "$spw_runtime_dir"
  curl --fail --location --remote-name "https://nodejs.org/dist/v${SPW_PACKAGE_NODE_VERSION}/${spw_node_archive}"
  curl --fail --location --remote-name "https://nodejs.org/dist/v${SPW_PACKAGE_NODE_VERSION}/SHASUMS256.txt"
  rg -F "  ${spw_node_archive}" SHASUMS256.txt > selected-sha256.txt
  test "$(wc -l < selected-sha256.txt)" -eq 1
  read -r spw_node_sha spw_selected_archive < selected-sha256.txt
  test "$spw_selected_archive" = "$spw_node_archive"
  shasum -a 256 -c selected-sha256.txt
  tar -xzf "$spw_node_archive"
) || exit 1
SPW_PACKAGE_NODE="$spw_runtime_dir/node-v${SPW_PACKAGE_NODE_VERSION}-darwin-${spw_node_arch}/bin/node"
export SPW_PACKAGE_NODE SPW_PACKAGE_NODE_VERSION
```

The native runtime on `PATH` remains unchanged. With the package runtime
variables exported, complete acceptance is:

```sh
pnpm install --frozen-lockfile
pnpm run check:static
pnpm run test:acceptance
```

After the checks, remove only the temporary directory created by this
invocation and clear its variables:

```sh
rm -rf -- "$spw_runtime_dir"
unset SPW_PACKAGE_NODE SPW_PACKAGE_NODE_VERSION spw_node_arch spw_node_archive spw_runtime_dir
```

Linux CI provisions the exact package runtime with `actions/setup-node`.
Downloads happen only during prerequisite setup, never inside the hermetic test
cases.

Packaging compiles only production source into fresh external temporary staging:

```sh
node tests/tools/pack.ts --out-dir /absolute/existing/temporary/output
```

Allocate the existing output directory outside the checkout before running this
command. It returns npm-compatible JSON for one validated tarball and removes its
own staging. Bare checkout `npm pack` always fails with this command's guidance,
even if stale `dist/` exists. Maintained or manager-generated JavaScript must not
remain in the checkout; dependencies and generated upstream plugin content have
separate ownership. This developer command does not authorize publication; follow
`RELEASING.md` for the protected release procedure.

Layers 1-3 stay offline and hermetic: they use a fake local upstream repo plus
host-side fixtures, and they perform no mutation of the developer's or runner's
real Codex or Pi state.

Layer 4 is the Docker acceptance path. `pnpm run test:harness:codex` runs the
real Codex offline probe and `pnpm run test:harness:pi` runs the real Pi snapshot
lifecycle/resource observer, each inside an isolated container home with
networking disabled. `pnpm run test:acceptance` composes one host-side shared run
with both harness integrations in order. A container may mutate its throwaway
container-local harness state, but it performs no mutation of the developer's or
runner's real Codex or Pi state.

Release validation deliberately retains the combined shared-plus-both-harness
path at both native endpoints:

```sh
SPW_NATIVE_NODE_VERSION=24.12.0 sh tests/container.sh
SPW_NATIVE_NODE_VERSION=24 sh tests/container.sh
```

The container probe uses Codex's `hooks/list` only as compatibility evidence
for the tested Codex build. It is not a stable Superpowers Manager API.

`sh tests/manual/codex-behavior-probe.sh` remains opt-in and covers native-only compatibility residue such as
path/cache and version-precedence behavior against an intentionally real local
Codex install. It is not part of acceptance. GitHub Actions runs two focused
`toolchain` entries plus independent blocking `Codex harness integration` and
`Pi harness integration` jobs on pull requests and pushes to `main`. The Node
24.12.0 toolchain entry checks native source
loading, the suite runner/assertion preload, and package-producer success and
failure. The latest-24 toolchain entry alone runs `pnpm run check:static` and
the full shared suite with package-minimum evidence. Each harness job runs only
its named integration on latest Node 24.x and never repeats the shared suite.
Release acceptance runs shared checks, Codex, and Pi at both native endpoints,
and the installed npm executable is tested with Node 24.0.0. These runtime
selectors are separate from the Homebrew-managed local commands above.

## Repository layout

```
.agents/plugins/marketplace.json          # local marketplace definition (tracked)
.github/                                  # CI, security, dependency, and release workflows (tracked)
config/upstream-ref                       # packaged upstream fallback policy (tracked)
docs/                                     # adapter result contract and baseline evidence (tracked)
package.json pnpm-lock.yaml tsconfig.json # package contract and locked toolchain (tracked)
plugins/superpowers/
  .codex-plugin/plugin.template.json      # fallback manifest template (tracked)
  generated plugin tree                   # prepared from upstream (gitignored)
src/                                      # in-process TypeScript runtime (tracked)
  cli.ts                                  # sole maintained CLI entry, parsing, preflight, dispatch
  commands/                               # lifecycle and selection command handlers
  codex-harness.ts pi-harness.ts          # harness-specific integration boundaries
tests/                                    # hermetic suite and isolated native harness probes (tracked)
  migration-inventory/                     # frozen historical evidence
  tools/pack.ts                           # external staging and validated package emission
```

Everything under `plugins/superpowers/` except the fallback manifest template is
generated by `npx superpowers-manager prepare` and ignored by Git; re-run that
command to regenerate it.
