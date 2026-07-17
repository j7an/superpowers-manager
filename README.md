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
`prepare` does not require it.

macOS and Linux are tested. WSL2 is supported. The native Windows path is
untested; the launcher looks for Git Bash, `git`, and `python3`, but path
handling between MSYS and Codex remains a known risk area.

Prepare, install, probe, and update resolve the requested upstream ref over the
network. Updates are user-triggered and need upstream network access; the
manager does not run automatic or background updates.

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

## Requirements

- `git`, `python3`, and a POSIX `sh`.
- The `codex` CLI (only for `install`/`update`/`uninstall`; `prepare`/`probe` don't need it).

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

## Quick start

```sh
# 1. Generate the runtime plugin tree from upstream (clones on first run).
scripts/prepare

# 2. See what state you're in (read-only).
scripts/probe

# 3. Install into Codex (registers the marketplace, then adds the plugin).
scripts/install
```

> **Provider collision is your responsibility.** If another `superpowers`
> provider is installed (e.g. `superpowers@openai-curated`), remove or disable
> it yourself first — the manager never removes a plugin other than its own
> `superpowers@superpowers-manager`:
>
> ```sh
> codex plugin remove superpowers@openai-curated   # only if you want the manager to take over
> ```

After installation, the manager delivers upstream **skills**. Upstream's
`hooks/` directory is not copied into the generated plugin, and the manager's
generated-tree contract requires both no manifest `hooks` key and no physical
`hooks/` directory. This preserves the manager's current hook-free policy; a
future hook-policy change requires its own design and compatibility evidence.

## Scripts

| Script | Side effects | Purpose |
|--------|--------------|---------|
| `scripts/prepare` | Clones upstream into `.cache/`, writes `plugins/superpowers/` | Build the runtime tree from the resolved upstream ref and validate it |
| `scripts/probe` | None (read-only) | Report `requested_ref`, `resolved_ref`, desired/generated/installed commit, and `status` |
| `scripts/install` | Codex marketplace + plugin state | Register the marketplace and add/refresh the plugin |
| `scripts/update` | Runs prepare/install as needed | Probe, then prepare and/or install to reach `current`, and verify the refresh actually took |
| `scripts/uninstall` | Codex marketplace + plugin state | Remove the manager's plugin and marketplace from Codex (idempotent; verifies removal) |

### `scripts/probe`

```sh
scripts/probe              # human-readable
scripts/probe --porcelain  # key=value lines for scripting
```

`status` is one of:

- `needs prepare` — the generated tree is missing or doesn't match the desired commit.
- `needs install` — generated tree is current, but the installed manager isn't (or can't be detected).
- `current` — installed manager matches the desired upstream commit.

### `scripts/update`

Runs the whole loop and refuses to report success while the installed manager is
still detectably stale:

```sh
scripts/update
```

If a refresh ever fails to take, it exits non-zero and suggests the `remove-add`
refresh mode (see below).

### `scripts/uninstall`

Removes exactly the Codex-side state `install` created — the plugin and the
local marketplace — and nothing else:

```sh
scripts/uninstall
```

It is idempotent: removing something already absent prints a `skipping` note and
still succeeds. It reads Codex's plugin and marketplace listings first and fails
closed if either cannot be read or parsed, so a listing error never triggers a
partial removal. Removal order is plugin-first, then marketplace. After removing,
it re-queries Codex and refuses to report success while the plugin or marketplace
is still present. It only ever removes `superpowers@superpowers-manager` and the
`superpowers-manager` marketplace — `openai-curated` and any other
plugin/marketplace are never touched.

Local generated artifacts under `plugins/superpowers/` and `.cache/upstream/`
are left in place; delete them manually or regenerate with `scripts/prepare`.

## Choosing the upstream version

The tracked ref lives in `config/upstream-ref` (default `latest-release`).
Override it per-invocation with `SUPERPOWERS_REF`, or edit the file. Accepted
values:

- `latest-release` — highest stable `vX.Y.Z` tag (prereleases are excluded).
- A specific tag, e.g. `v6.0.3`.
- A full 40-character commit SHA.
- Any other ref upstream resolves (e.g. a branch name).

```sh
SUPERPOWERS_REF=v6.0.3 scripts/prepare      # pin to a specific release
SUPERPOWERS_REF=main scripts/prepare        # track upstream main
SUPERPOWERS_REF=feature/foo scripts/prepare # build another upstream ref
SUPERPOWERS_REF=latest-release scripts/probe
```

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

`scripts/install` and `scripts/update` accept `SUPERPOWERS_INSTALL_REFRESH_MODE`:

- `add-only` (default) — `plugin add` re-reads the local source, which refreshes
  a mutated tree. Verified sufficient for local marketplaces.
- `remove-add` — removes the manager's own plugin first, then re-adds it. Use
  only if a refresh ever fails to take:

  ```sh
  SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add scripts/update
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
  core/                                    # shared lifecycle/provenance/status modules
  prepare probe install update uninstall   # user-facing shell entrypoints
tests/                                     # hermetic suite + manual Codex probe
.cache/upstream/                           # upstream clone cache         (gitignored)
```

Everything under `plugins/superpowers/` except the fallback manifest template is
generated by `prepare` and ignored by Git; re-run `prepare` to regenerate it.
