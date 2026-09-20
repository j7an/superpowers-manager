# OpenCode reference

Use `--harness opencode` to prepare, inspect, install, update, or remove the
OpenCode integration. Selection remains shared with Codex and Pi, and selection
commands do not accept a harness target. OpenCode is global-only: the manager
uses `$XDG_CONFIG_HOME/opencode`, or `$HOME/.config/opencode`, and never installs
into a project.

The manager uses installed OpenCode and never installs, upgrades, or downgrades
it; set `SUPERPOWERS_OPENCODE` to select a non-default executable.

OpenCode support covers the 1.x and 2.x lines, qualified in isolated containers
against OpenCode 1.18.30 and `@opencode/cli` 2.0.10 respectively. Install and
update check the host major version and refuse other lines before mutation.

Prepared output, the installed snapshot, and recovery material are separate
Manager-owned state. On V1, the manager registers the installed snapshot through
OpenCode's native global installer. On V2, it writes a `plugins` entry into the
global configuration, because V2's `plugin add` accepts only npm and Git
specifiers, not a local directory. Both paths verify configuration and snapshot
identity afterward. `probe` is read-only: it neither invokes OpenCode nor writes
configuration or repairs state.

Admission requires the exact qualified upstream-native package profile: the
expected package metadata, OpenCode bootstrap bytes, required skills, and no
upstream runtime dependencies. The qualified profile matches the bootstrap and
V2 `index.js` entrypoint as a pair. Upstream v6.0.0 through v6.3.0 ship no
entrypoint and are V1-only; v6.4.1 ships the qualified V2 pair. The profile
from the official `obra/superpowers` source is supported. Matching mechanics
from a custom source remain experimental and require `--allow-experimental`;
the opt-in does not admit an unknown or changed bootstrap profile.

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

Discovery uses the original process context. On V1, the native writer runs in a
contained disposable context with its global XDG configuration root pinned to
the intended target; its internal managed-configuration redirect is
qualification-sensitive and is not a runtime version allowlist. Original config,
project, account, and managed origins are not forwarded to that writer.
`OPENCODE_PURE` and the managed-configuration redirect do not exist in V2; the
only native V2 invocation during install or update is `--version`.

Account activation inspection streams SQLite state and WAL into disposable
storage before querying it, so it never opens OpenCode's files with SQLite and
database size does not affect eligibility. Copy time and temporary space grow
with the database. Moving or malformed account state remains unresolved; retry
only after it is stable or resolve it manually.

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
