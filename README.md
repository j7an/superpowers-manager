# Superpowers Wrapper

A local [Codex](https://github.com/openai/codex) marketplace that repackages
upstream [Superpowers](https://github.com/obra/superpowers) so you can install
it as `superpowers@superpowers-wrapper`.

By default the wrapper tracks the **latest stable upstream release tag** and
records the exact upstream commit it was built from, separately from a generated
wrapper manifest version that includes `+wrapper.<short-sha>`. Nothing upstream
is vendored into Git — you generate the runtime tree locally from a pinned ref.

## What it does

- Resolves an upstream ref (default: latest `vX.Y.Z` release tag).
- Clones/fetches upstream at that commit and assembles a Codex plugin tree under
  `plugins/superpowers/` (skills, assets, license/readme, manifest — upstream's
  `hooks/` directory is deliberately excluded).
- Stamps the generated manifest with a ref-aware wrapper version ending in
  `+wrapper.<short-sha>` and writes the upstream provenance to
  `.superpowers-upstream.json`.
- Validates the generated tree with Codex's plugin validator before swapping it
  into place (a failed run never destroys a previously-generated tree).
- Registers the local marketplace and installs/refreshes the plugin in Codex.

## Requirements

- `git`, `python3`, and a POSIX `sh`.
- The `codex` CLI (only for `install`/`update`/`uninstall`; `prepare`/`probe` don't need it).

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
> it yourself first — the wrapper never removes a plugin other than its own
> `superpowers@superpowers-wrapper`:
>
> ```sh
> codex plugin remove superpowers@openai-curated   # only if you want the wrapper to take over
> ```

After installation, the wrapper delivers upstream **skills**. Upstream's
`hooks/` directory is not copied into the generated plugin: Codex's plugin
validator rejects a `hooks` field in the manifest, and shipping no
`hooks/hooks.json` means Codex's hook auto-discovery has nothing to register —
so upstream's session-start auto-registration concern doesn't apply here.

## Scripts

| Script | Side effects | Purpose |
|--------|--------------|---------|
| `scripts/prepare` | Clones upstream into `.cache/`, writes `plugins/superpowers/` | Build the runtime tree from the resolved upstream ref and validate it |
| `scripts/probe` | None (read-only) | Report `requested_ref`, `resolved_ref`, desired/generated/installed commit, and `status` |
| `scripts/install` | Codex marketplace + plugin state | Register the marketplace and add/refresh the plugin |
| `scripts/update` | Runs prepare/install as needed | Probe, then prepare and/or install to reach `current`, and verify the refresh actually took |
| `scripts/uninstall` | Codex marketplace + plugin state | Remove the wrapper's plugin and marketplace from Codex (idempotent; verifies removal) |

### `scripts/probe`

```sh
scripts/probe              # human-readable
scripts/probe --porcelain  # key=value lines for scripting
```

`status` is one of:

- `needs prepare` — the generated tree is missing or doesn't match the desired commit.
- `needs install` — generated tree is current, but the installed wrapper isn't (or can't be detected).
- `current` — installed wrapper matches the desired upstream commit.

### `scripts/update`

Runs the whole loop and refuses to report success while the installed wrapper is
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
is still present. It only ever removes `superpowers@superpowers-wrapper` and the
`superpowers-wrapper` marketplace — `openai-curated` and any other
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

- **`plugins/superpowers/.codex-plugin/plugin.template.json`** is committed and
  carries the placeholder version `0.0.0+wrapper.template`.
- **`prepare`** generates `plugin.json` from that template, replacing the version
  with a ref-aware wrapper version and dropping manifest fields Codex's plugin
  validator rejects (e.g. `hooks` — safe because no hook files are shipped, so
  Codex has nothing to auto-register).
- Stable tags generate release-looking versions such as
  `6.0.3+wrapper.896224c`; explicit prerelease tags generate versions such as
  `6.1.0-beta.1+wrapper.abc1234`.
- Branch builds deliberately stay below real releases:
  `main` generates `0.0.0-main+wrapper.<short-sha>` and other named refs
  generate `0.0.0-ref-<sanitized-ref>+wrapper.<short-sha>`.
- Raw 40-character commit SHAs generate `0.0.0+wrapper.<short-sha>`.
- **`.superpowers-upstream.json`** records the authoritative provenance:
  `source`, `requested_ref`, `resolved_ref`, `commit`, and the upstream manifest
  version. The generated manifest version is for human readability and Codex
  package identity; the upstream `commit` is what `probe`/`update` compare
  against.

## Refresh modes

`scripts/install` and `scripts/update` accept `SUPERPOWERS_INSTALL_REFRESH_MODE`:

- `add-only` (default) — `plugin add` re-reads the local source, which refreshes
  a mutated tree. Verified sufficient for local marketplaces.
- `remove-add` — removes the wrapper's own plugin first, then re-adds it. Use
  only if a refresh ever fails to take:

  ```sh
  SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add scripts/update
  ```

## Tests

```sh
sh tests/run.sh                          # full hermetic suite (no network, no Codex)
sh tests/manual/codex-behavior-probe.sh  # live probe of Codex marketplace behavior
```

The automated suite is fully hermetic: it uses a fake local upstream repo and a
fake `codex`. The manual probe is opt-in and exercises real Codex CLI behavior
(it only ever touches a throwaway `wrapper-probe@superpowers-wrapper-probe`).

## Repository layout

```
.agents/plugins/marketplace.json          # local marketplace definition (tracked)
config/upstream-ref                        # which upstream ref to track (tracked)
plugins/superpowers/
  .codex-plugin/plugin.template.json       # committed manifest template (tracked)
  .codex-plugin/plugin.json                # generated manifest          (gitignored)
  skills/ assets/ LICENSE ...              # generated from upstream      (gitignored)
  .superpowers-upstream.json               # generated provenance         (gitignored)
scripts/                                   # prepare / probe / install / update + lib.sh
tests/                                     # hermetic suite + manual Codex probe
.cache/upstream/                           # upstream clone cache         (gitignored)
```

Everything under `plugins/superpowers/` except the manifest template is
generated by `prepare` and ignored by Git — re-run `prepare` to regenerate it.
