@../AGENTS.md

This bridge imports the harness-agnostic project instructions above. It does
not expand the shipped manager's Codex-only runtime scope.

- Treat `superpowers@superpowers-manager` and the `superpowers-manager`
  marketplace as the only manager-owned Codex identities.
- Keep the existing `spw_*` internal names and the Codex-specific hook-free
  invariant.
- Treat `sh tests/container.sh` as a blocking completion check.
