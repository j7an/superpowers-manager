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
npx superpowers-manager@0.1.2 install
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
- Clones or fetches that exact upstream commit and assembles a Codex plugin tree
  under `plugins/superpowers/`.
- Preserves the upstream manifest when available, while applying the
  manager-owned plugin contract.
- Records `source`, `requested_ref`, `resolved_ref`, `commit`, and the upstream
  manifest version in `.superpowers-upstream.json`.
- Validates the candidate tree before replacing a previous generated tree or
  mutating Codex state.
- Registers the `superpowers-manager` marketplace and installs or refreshes
  `superpowers@superpowers-manager` in Codex.

The generated plugin carries upstream skills, assets, and documentation. The
manager excludes upstream `hooks/`, removes the manifest `hooks` field, and
validates that both stay absent. This is a Codex-specific adapter policy, not a
claim about how Superpowers should be packaged for future or other harnesses.
Changing the hook-free policy requires a separate design and current
compatibility evidence.

## Choosing the upstream version

`SUPERPOWERS_REF` selects a stable release tag, full commit SHA, branch, or
other resolvable upstream ref for that invocation. The stateless npx package
records the requested ref, resolved ref, and exact commit, but does not persist
the selection for a later invocation that omits `SUPERPOWERS_REF`.

Without `SUPERPOWERS_REF`, the manager reads `config/upstream-ref`, which ships
as `latest-release`. Accepted values include:

- `latest-release` — the highest stable `vX.Y.Z` tag; prereleases are excluded.
- A specific tag, such as `v6.0.3`.
- A full 40-character commit SHA.
- Any other ref upstream resolves, such as `main` or a branch name.

```sh
SUPERPOWERS_REF=v6.0.3 npx superpowers-manager prepare
SUPERPOWERS_REF=main npx superpowers-manager probe
SUPERPOWERS_REF=feature/foo npx superpowers-manager install
SUPERPOWERS_REF=latest-release npx superpowers-manager update
```

`SUPERPOWERS_CACHE_DIR` may point to a persistent upstream clone cache to avoid
re-cloning between package materializations. It caches Git objects; it does not
persist ref selection or trigger updates.

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
| `npx superpowers-manager prepare` | None | Resolve upstream, build a staged plugin tree, validate it, and replace the generated tree only on success |
| `npx superpowers-manager probe` | None | Report requested and resolved refs, desired/generated/installed commits, identity state, and status |
| `npx superpowers-manager install` | Marketplace and plugin state | Prepare and validate, register the marketplace, install the plugin, and verify installed state |
| `npx superpowers-manager update` | Marketplace and plugin state when stale | Probe, prepare and/or install as needed, then verify the refresh |
| `npx superpowers-manager uninstall` | Marketplace and plugin state | Remove only manager-owned Codex state and verify removal |

Calling `npx superpowers-manager` without a subcommand is equivalent to
`update`. `probe` is read-only. Install and update prepare and validate before changing Codex state.
Uninstall inspects and removes only manager-owned Codex state. Those mutating
commands fail closed when required state cannot be inspected and refuse to
report success when the resulting state cannot be verified.

### Refresh modes

`install` and `update` accept `SUPERPOWERS_INSTALL_REFRESH_MODE`:

- `add-only` (default) asks Codex to add the plugin from the current local
  marketplace source.
- `remove-add` removes only the manager-owned plugin before adding it again.

Use `remove-add` only when an add-only refresh fails to take:

```sh
SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add npx superpowers-manager update
```

## How generated versions work

- If upstream provides `.codex-plugin/plugin.json`, the manager uses it as the
  manifest base and preserves unknown upstream fields.
- The committed fallback template supports older refs without an upstream
  manifest and uses the placeholder version `0.0.0+manager.template`.
- Stable tags produce versions such as `6.0.3+manager.896224c`; explicit
  prereleases produce versions such as `6.1.0-beta.1+manager.abc1234`.
- `main` produces `0.0.0-main+manager.<short-sha>`; other named refs produce
  `0.0.0-ref-<sanitized-ref>+manager.<short-sha>`.
- Full commit SHAs produce `0.0.0+manager.<short-sha>`.

The generated version is for readable Codex package identity. The exact commit
in `.superpowers-upstream.json` is the authoritative value compared by `probe`
and `update`.

`SUPERPOWERS_VALIDATOR=/path/to/validator.py` adds an optional Python validator
after the built-in generated-tree validation. It receives the candidate plugin
root as its only argument. It cannot bypass the built-in validator, and either
check failing prevents replacement and Codex mutation.

## Tests

```sh
sh tests/run.sh        # Layers 1-3: hermetic, no network or real Codex state
sh tests/container.sh  # Layer 4: blocking isolated real-Codex CLI check
```

The container suite runs with networking disabled and a throwaway home, so it
may mutate only isolated container state. The optional
`tests/manual/codex-behavior-probe.sh` is reserved for intentional native-only
compatibility residue and is not part of acceptance.

## Repository layout

```text
.agents/plugins/marketplace.json           # local manager marketplace definition
bin/superpowers-manager.js                 # npm CLI launcher
config/upstream-ref                        # default upstream ref
plugins/superpowers/
  .codex-plugin/plugin.template.json       # tracked fallback manifest
  .codex-plugin/plugin.json                # generated manifest (ignored)
  skills/ assets/ LICENSE ...              # generated from upstream (ignored)
  .superpowers-upstream.json               # generated provenance (ignored)
scripts/                                   # prepare/probe/install/update/uninstall
tests/                                     # hermetic and isolated-container suites
.cache/upstream/                           # optional upstream clone cache (ignored)
```

Everything under `plugins/superpowers/` except the fallback manifest template
is generated by `prepare` and ignored by Git. Do not edit generated plugin
content; regenerate it instead.
