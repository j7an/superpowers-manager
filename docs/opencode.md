# OpenCode reference

Use `--harness opencode` to prepare, inspect, install, update, or remove the
OpenCode integration. Selection remains shared with Codex and Pi, and selection
commands do not accept a harness target. OpenCode is global-only: the manager
uses `$XDG_CONFIG_HOME/opencode`, or `$HOME/.config/opencode`, and never installs
into a project.

Prepared output, the installed snapshot, and recovery material are separate
Manager-owned state. The manager registers the installed snapshot through
OpenCode's native global installer and verifies configuration and snapshot
identity afterward. `probe` is read-only: it neither invokes OpenCode nor writes
configuration or repairs state.

Admission requires the exact qualified upstream-native package profile: the
expected package metadata, OpenCode bootstrap bytes, required skills, and no
upstream runtime dependencies. The qualified profile from the official
`obra/superpowers` source is supported. Matching mechanics from a custom source
remain experimental and require `--allow-experimental`; the opt-in does not
admit an unknown or changed bootstrap profile.

Conflicting unmanaged Superpowers registrations, project sources, remote
configuration, or managed sources require manual resolution. The manager removes
only a verified Manager-owned registration and snapshot. Preserve reported
recovery material whenever a transaction cannot be completed safely. During
removal, that material can include both a journal and a verified sibling backup
of the prior snapshot; do not alter either while the manager reports recovery is
required. If the manager instead reports that removal was verified but cleanup
is pending, the registration and installed snapshot are already absent and the
remaining backup or journal is cleanup evidence, not a promise that the removed
state can be rolled back. Recovery is never applied automatically.

Discovery uses the original process context. The native writer runs in a
contained disposable context with its global XDG configuration root pinned to
the intended target; its internal managed-configuration redirect is
qualification-sensitive and is not a runtime version allowlist. Original config,
project, account, and managed origins are not forwarded to the writer.

Account activation inspection copies SQLite state and WAL into disposable
storage before querying it, with a fixed 16 MiB combined capture ceiling.
Moving, oversized, or malformed account state remains unresolved; retry only
after it is stable or resolve it manually. Reassess the ceiling when measured
usage requires it.

Restart OpenCode after a successful install, an activating update, or a verified
removal. End-to-end native lifecycle qualification runs offline in an isolated
Linux container and covers registration, bootstrap and skill loading, snapshot
refresh, and removal. macOS evidence covers the released command surface and
focused unit behavior; it does not establish the same end-to-end lifecycle.

The shipping qualification uses OpenCode 1.18.30 as UID 10001 in a read-only,
network-disabled Linux container. The real manager and native OpenCode command
proved experimental-source refusal before mutation, install of snapshot A,
continued activation of A after preparing B, update to B in a fresh native
process, a byte-stable probe with no native invocation, exact registration and
snapshot removal, and an idempotent second removal. Each active observation
loaded the upstream bootstrap and returned the installed snapshot marker through
OpenCode's native skill tool. The packaged OpenCode JSONC read/removal path and
its bundled parser also execute under the declared minimum Node 24.0.0 runtime.
