# Usage reference

## Shared selection

| Command | Harness side effects | Purpose |
|---|---|---|
| `npx superpowers-manager pin REF` | None | Resolve and save an exact tag or full commit |
| `npx superpowers-manager track-latest` | None | Save latest-stable policy |
| `npx superpowers-manager unpin` | None | Restore the packaged fallback policy |

Selection commands are shared and accept no harness target. They save intent for
both adapters without preparing or activating either one.

## Targeted lifecycle

Set `HARNESS` to `codex` or `pi`. Omitting `--harness` selects Codex.

| Command | Selected-harness side effects | Purpose |
|---|---|---|
| `npx superpowers-manager prepare --harness HARNESS` | None | Resolve, stage, validate, and replace prepared output |
| `npx superpowers-manager probe --harness HARNESS` | None | Report selected state and status |
| `npx superpowers-manager install --harness HARNESS` | Owned target state | Prepare, activate, and verify |
| `npx superpowers-manager update --harness HARNESS` | Owned target state when stale | Probe, refresh when needed, and verify |
| `npx superpowers-manager uninstall --harness HARNESS` | Owned target state | Remove only Manager-owned state and verify removal |

`npx superpowers-manager` alone means default Codex `update`.

`prepare` builds in invocation-specific staging, validates before replacement, cleans its own staging, and preserves prior generated output on failure. `probe` never mutates. Install and update fail closed if conflicting or required state cannot be inspected; uninstall reports unmanaged residue without changing it.

## Choosing a source

```sh
npx superpowers-manager pin v6.1.1
npx superpowers-manager pin 0123456789abcdef0123456789abcdef01234567
npx superpowers-manager track-latest
npx superpowers-manager unpin
```

The selection commands save intent only; they do not prepare content or change either harness. `pin` verifies an exact `vMAJOR.MINOR.PATCH` stable tag (optionally prerelease) or full 40-character commit before saving identity and source. `track-latest` resolves the highest stable `vX.Y.Z` tag when applied. `unpin` restores `config/upstream-ref`, currently `latest-release`. The saved identity is the contract, not a clone cache: clearing or moving `SUPERPOWERS_CACHE_DIR` does not change the selection.

Selection is stored in `selection.json` in the first absolute configured location: `$SUPERPOWERS_CONFIG_DIR`, then `$XDG_CONFIG_HOME/superpowers-manager`, then `$HOME/.config/superpowers-manager`.

Ref precedence is `SUPERPOWERS_REF`, saved selection, then `config/upstream-ref`; source precedence is `SUPERPOWERS_UPSTREAM_URL`, saved source, then `https://github.com/obra/superpowers`. `SUPERPOWERS_REF` is an invocation-only override and is not persisted. Unlike a saved exact pin, it accepts stable tags, full commit SHAs, branches, and other resolvable upstream refs:

```sh
SUPERPOWERS_REF=feature/foo npx superpowers-manager probe
```

`pin` and `track-latest` bind the current source. `probe` exposes `selection_origin`, `selection_mode`, `upstream_source_origin`, `effective_source`, saved-selection fields, and a mixed-origin warning so a ref and source chosen at different levels remains visible.

## Network and validation

A saved exact pin lets `probe` reuse recorded identity while its source is offline. This is not an offline install promise: `pin` verifies its target, `track-latest` resolves when applied, and `prepare`, `install`, and `update` fetch or verify the effective source.

The built-in generated-tree validator always runs. `SUPERPOWERS_VALIDATOR=/path/to/validator.py` adds a deprecated Python validator after it; `SUPERPOWERS_VALIDATOR_EXECUTABLE=/path/to/validator` adds an external executable after it. Each receives the candidate plugin root as its sole argument. Neither replaces or bypasses built-in validation: either failure prevents prepared-tree replacement and harness mutation, and setting both is rejected at preflight before network or harness access.

The executable validator receives argv directly; the manager constructs no shell command string. On Linux, `execvp` may pass that same argv to `/bin/sh` after `ENOEXEC`, preserving spaces and shell metacharacters rather than re-parsing them. A file with the exec bit but no valid executable format therefore runs as shell source on Linux and is rejected as not runnable on macOS; give it a shebang or use a real binary. Exit 0 accepts and any nonzero exit rejects. The manager waits at most 30 seconds, captures at most 64 KiB from each output stream, and treats the validator as a privileged extension rather than a security boundary.

HTTP(S) upstream URLs with userinfo are rejected. Use a credential helper or SSH source instead.

## Provider ownership

Use one Superpowers provider in a harness at a time. The manager mutates only `superpowers@superpowers-manager` and the `superpowers-manager` marketplace in Codex, and only its registration and snapshot in Pi. It never adopts, updates, or removes another provider automatically.

```sh
codex plugin remove superpowers@openai-curated
npx superpowers-manager install --harness codex
```
