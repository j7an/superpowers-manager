# Superpowers Manager

Install and update the latest stable
[`obra/superpowers`](https://github.com/obra/superpowers) release directly from
upstream, without waiting for agent marketplaces to catch up.
Codex supported today.

> Unofficial community integration. Not affiliated with the
> `obra/superpowers` maintainers.

## Quick start

```sh
npx superpowers-manager install
npx superpowers-manager probe
npx superpowers-manager update
```

Use the official marketplace for the simplest native Codex installation. Use
Superpowers Manager when you want immediate stable-upstream freshness after a
user-triggered install/update, per-invocation release or commit selection,
recorded upstream provenance, diagnostics, Codex-specific hook-free packaging,
and explicit install/update/probe/uninstall lifecycle control.

| Choose | Best fit |
|---|---|
| Official marketplace | Simplest Codex-native installation and marketplace-managed cadence |
| `superpowers-manager` | Direct stable-upstream freshness when invoked, exact ref selection, provenance, diagnostics, and lifecycle control |

### Moving from `superpowers-wrapper`

```sh
npx superpowers-wrapper@0.1.1 uninstall
npx superpowers-manager install
```

The manager detects legacy wrapper-owned Codex state and stops before mutation.
It never removes the legacy provider automatically.

## Requirements and platforms

Superpowers Manager requires Node 24+, `git`, Python 3, and a POSIX `sh`.
Codex CLI is required for `probe`, `install`, `update`, and `uninstall`;
`prepare`, `pin`, `track-latest`, and `unpin` do not require it. Codex is the
only supported integration today.

macOS and Linux are tested. WSL2 is supported. The native Windows path is
untested; the launcher looks for Git Bash, `git`, and `python3`, but path
handling between MSYS and Codex remains a known risk area.

Network needs depend on the saved policy. `pin` verifies its target;
`track-latest` and invocation overrides resolve from upstream when applied; and
`prepare`, `install`, and `update` fetch or verify the effective source. A probe
of a saved exact pin can reuse its recorded identity without upstream access.
Updates remain user-triggered; the manager does not run automatic or background
updates.

## What it does

- Resolves an upstream ref, defaulting to the latest stable `vX.Y.Z` release
  tag.
- Clones/fetches upstream at that commit and assembles a Codex plugin tree under
  `plugins/superpowers/` (skills, assets, license/readme, and manifest;
  upstream's `hooks/` directory is deliberately excluded).
- Stamps the generated manifest with a ref-aware manager version ending in
  `+manager.<short-sha>` and writes the upstream provenance to
  `.superpowers-upstream.json`.
- Validates the generated tree with the manager's shipped, Python-standard-library
  contract validator before swapping it into place (a failed run never destroys
  a previously generated tree).
- Registers the `superpowers-manager` marketplace and installs or refreshes
  `superpowers@superpowers-manager` in Codex.

The generated plugin carries upstream skills, assets, and documentation. The
manager excludes upstream `hooks/`, removes the manifest `hooks` field, and
validates that both stay absent. This is a Codex-specific adapter policy, not a
claim about how Superpowers should be packaged for future or other harnesses.
Changing the hook-free policy requires a separate design and current
compatibility evidence.

## Runtime architecture

- `scripts/core/` owns the shared lifecycle, status, and protocol validation.
- `scripts/adapters/codex/` owns build, inspection, reconciliation, and Codex
  mutation.
- Codex is the only supported adapter today; no public harness selector ships
  yet.

Validation checks the manager-owned manifest overlay, generated-tree structure,
skill frontmatter envelope, known local paths, and provenance. It deliberately
does not implement a general YAML parser or mirror every Codex ingestion rule;
upstream owns skill semantics and Codex owns its evolving schema.

`SUPERPOWERS_VALIDATOR=/path/to/validator.py` adds an optional Python validator
after the built-in check. It receives the candidate plugin root as its only
argument. It cannot replace or bypass built-in validation, and either check
failing prevents the tree swap and all Codex mutation.

Direct `scripts/install` keeps harness-specific validation in the Codex adapter:
phase 1 prepares the exact candidate first, then the adapter performs its Codex
and refresh-mode preflight before any Codex mutation. The Node dispatcher keeps
its existing Codex preflight before dispatching to the shell lifecycle.

## Provider ownership

If another `superpowers` provider is installed, remove or disable it yourself
before installing this one. The manager never removes another provider and
mutates only `superpowers@superpowers-manager` and the `superpowers-manager`
marketplace.

For example, if you intentionally want the manager to take over from the
official provider:

```sh
codex plugin remove superpowers@openai-curated
npx superpowers-manager install
```

Manager install, update, and uninstall commands inspect both current and legacy
identities and fail closed when Codex state cannot be read or parsed. If legacy
`superpowers-wrapper` state remains, use the migration commands above; the
manager will not remove it for you.

## Lifecycle commands

| Command | Codex side effects | Purpose |
|---|---|---|
| `npx superpowers-manager pin REF` | None | Resolve and save an exact upstream release tag or full commit |
| `npx superpowers-manager track-latest` | None | Save a policy that resolves the latest stable release when applied |
| `npx superpowers-manager unpin` | None | Remove saved selection and return to the packaged fallback policy |
| `npx superpowers-manager prepare` | None | Resolve upstream, build a staged plugin tree, validate it, and replace the generated tree only on success |
| `npx superpowers-manager probe` | None | Report requested and resolved refs, desired/generated/installed commits, identity state, and status |
| `npx superpowers-manager install` | Marketplace and plugin state | Prepare and validate, register the marketplace, install the plugin, and verify installed state |
| `npx superpowers-manager update` | Marketplace and plugin state when stale | Probe, prepare and/or install as needed, then verify the refresh |
| `npx superpowers-manager uninstall` | Marketplace and plugin state | Remove only manager-owned Codex state and verify removal |

Calling `npx superpowers-manager` without a subcommand is equivalent to
`update`. `probe` is read-only. Install and update stop before prepare or Codex
mutation when legacy state is present. Uninstall removes only manager-owned
state and reports any legacy residue without modifying it. These commands fail
closed when required state cannot be inspected and refuse to report success
when resulting manager state cannot be verified.

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
or change Codex state. Run `npx superpowers-manager install` for a first
installation or `npx superpowers-manager update` to apply the saved policy to
an existing installation. There is no background updater: selection changes
take effect only through a user-triggered `prepare`, `install`, or `update`.

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
must fetch or verify content from the effective source. Codex inspection is
still required for lifecycle status.

HTTP(S) upstream URLs containing userinfo are now rejected, including
token-only userinfo. This is an intentional compatibility break: use a Git
credential helper for HTTP(S) authentication or an SSH source instead of
embedding credentials in the URL.

Saved selection does not claim or transfer provider ownership. The manager
continues to mutate only `superpowers@superpowers-manager` and never removes or
updates the official provider or any other provider automatically.

## How versioning works

- **Upstream manifest first:** when upstream provides
  `.codex-plugin/plugin.json`, `prepare` uses it as the generated manifest base
  so future upstream metadata fields are preserved by default.
- **Fallback template:** `plugins/superpowers/.codex-plugin/plugin.template.json`
  is committed as a minimal fallback for older upstream refs that do not ship a
  Codex manifest. It carries the placeholder version
  `0.0.0+manager.template`.
- **Manager overlay:** `prepare` replaces the version with a ref-aware manager
  version, forces `skills` to `./skills/`, and enforces the manager's current
  hook-free policy: no manifest `hooks` key and no copied `hooks/` directory.
  Unknown upstream manifest fields remain preserved.
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

## Refresh modes

`install` and `update` accept `SUPERPOWERS_INSTALL_REFRESH_MODE`:

- `add-only` (default) — `plugin add` re-reads the local source, which refreshes
  a mutated tree. Verified sufficient for local marketplaces.
- `remove-add` — removes the manager's own plugin first, then re-adds it. Use
  only if a refresh ever fails to take:

  ```sh
  SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add npx superpowers-manager update
  ```

## Tests

```sh
sh tests/run.sh                          # Layers 1-3: host-side hermetic checks while iterating
sh tests/container.sh                    # Layers 1-4: blocking Docker acceptance command
sh tests/manual/codex-behavior-probe.sh  # optional native-only compatibility residue
```

Layers 1-3 stay offline and hermetic: they use a fake local upstream repo plus
host-side fixtures, and they perform no mutation of the developer's or runner's
real Codex state.

Layer 4 is the Docker acceptance path. It is the required completion command
because the isolated-container Codex probe graduated from a temporary
nonblocking spike to a blocking acceptance gate. `sh tests/container.sh` runs
the inner `sh tests/run.sh` suite and then the real Codex offline probe inside
an isolated container home with networking disabled. That container run may
mutate the throwaway container-local Codex state, but it still performs no
mutation of the developer's or runner's real Codex state.

The manual probe is opt-in and covers native-only compatibility residue such as
path/cache behavior against an intentionally real local Codex install. It is
not part of acceptance. GitHub Actions runs the blocking container acceptance
command on pull requests and pushes to `main`.

## Repository layout

```
.agents/plugins/marketplace.json          # local marketplace definition (tracked)
config/upstream-ref                        # which upstream ref to track (tracked)
plugins/superpowers/
  .codex-plugin/plugin.template.json       # fallback manifest template (tracked)
  .codex-plugin/plugin.json                # generated manifest          (gitignored)
  skills/ assets/ LICENSE ...              # generated from upstream      (gitignored)
  .superpowers-upstream.json               # generated provenance         (gitignored)
scripts/
  adapters/codex/                          # Codex adapter entrypoint + validator helpers
  core/                                    # shared lifecycle, selection, provenance, and status modules
  pin track-latest unpin                   # persistent-selection entrypoints
  prepare probe install update uninstall   # lifecycle entrypoints
tests/                                     # hermetic suite + manual Codex probe
.cache/upstream/                           # upstream clone cache         (gitignored)
```

Everything under `plugins/superpowers/` except the fallback manifest template is
generated by `prepare` and ignored by Git; re-run `prepare` to regenerate it.
