# Pi reference

## Frozen Manager-owned snapshots

Pi installation prepares and validates a package snapshot, copies it to `$PI_CODING_AGENT_DIR/superpowers-manager/installed` (defaulting under `$HOME/.pi/agent`), then registers a canonical path relative to the Pi agent directory. This owned frozen snapshot persists independently of the generated Codex plugin tree, so upstream and preparation changes cannot silently alter it. Restart Pi after a successful install, activating update, or removal.

The official `obra/superpowers` profile is supported. A known-complete profile from a custom source is experimental and requires `--allow-experimental` immediately before install or update activation. The flag permits only a verifiable candidate within implemented experimental mechanics; it never bypasses ownership, update control, validation, or postconditions. Missing, changed, or unknown profiles are unsupported.

## Runtime compatibility

Native container qualification uses `pi-coding-agent` 0.85.1. For both Codex and Pi, native test versions are qualification evidence, not runtime allowlists. Manager does not reject a runtime solely because its version differs from the native test pin. Operations still require inspectable state, required integration behavior, and validated postconditions. Untested runtime versions are not automatically certified as compatible.

Pi inspection requires a successful, bounded `pi --version` response in the expected format. The manager uses installed Pi and never installs, upgrades, or downgrades it; set `SUPERPOWERS_PI` for a non-default executable. Product code does not import or execute the Pi extension to classify a candidate.

The current qualified compatibility generation is `pi-native-bootstrap-v1`. Receipts record it with the selected source and exact commit, but Pi reassesses package metadata and bootstrap bytes rather than trusting that label. A no-longer-supported generation remains inspectable and removable subject to normal ownership, integrity, runtime, and recovery checks.

Pi integration is tested on macOS and in an isolated Linux container. Pi on WSL2 and native Windows are untested.

## Recovery and partial cleanup

Mutating operations immediately refuse an overlapping Manager operation. An unresolved recovery journal blocks later mutation and identifies material to preserve for manual recovery. If Pi deregistration succeeds but snapshot cleanup cannot be verified, uninstall reports partial cleanup and leaves snapshot or recovery material in place.

`probe --harness pi` acquires no mutation lock, changes no settings, repairs no journal, and removes no files. It reports busy, uninspectable, and recovery-required state while checking observed identities remain stable. It may still need network access for a non-exact selection.
