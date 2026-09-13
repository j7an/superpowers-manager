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

Conflicting unmanaged Superpowers registrations, project sources, remote
configuration, or managed sources require manual resolution. The manager removes
only a verified Manager-owned registration and snapshot. Preserve reported
recovery material whenever a transaction cannot be completed safely.

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
removal. Native qualification covers macOS and isolated Linux, not Windows.
