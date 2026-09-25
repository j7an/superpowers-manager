# Claude Code reference

Use `--harness claude-code` to prepare, inspect, install, update, or remove the
Claude Code integration. Selection is shared with Codex, Pi, and OpenCode.
Installation is user scope only; the manager never writes project or local
settings.

The manager uses the installed `claude` CLI and never installs or upgrades it.
Set `SUPERPOWERS_CLAUDE_CODE` to select another executable. State lives under
`CLAUDE_CONFIG_DIR`, or `$HOME/.claude` by default:

```text
superpowers-manager/
  prepared/                        validated candidate
  marketplace/                     registered as marketplace `superpowers-manager`
    .claude-plugin/marketplace.json
    plugins/superpowers/           plugin `superpowers@superpowers-manager`
```

Claude Code loads plugin components from the published marketplace source at
the next session start or `/reload-plugins`. Its listed `installPath` is a
separate cache directory. The snapshot preserves upstream content except for
the manager's artifact receipt and the `.claude-plugin/plugin.json` `version`,
which becomes a ref-aware version such as `6.4.1+manager.abc1234`. On update,
the manager also runs `claude plugin update` when needed so `claude plugin list`
reports the new version. Restart Claude Code, or run `/reload-plugins`, after
an install, an activating update, or a removal.

## Switching from another Superpowers copy

Install and update refuse while another Superpowers marketplace plugin is
enabled, for example `superpowers@claude-plugins-official`. Disable that copy
before retrying:

```sh
claude plugin disable superpowers@claude-plugins-official
```

The manager never disables or removes another provider. A copy synced from
claude.ai does not block installation because Claude Code reports it as not
loaded when another copy provides the same name.

## Hooks

Upstream's `hooks/hooks.json` ships unchanged. The manager creates no hooks
and changes no trust state; review upstream hook definitions before running
them.

## Recovery

There is no journal. If an install is interrupted, a `.superpowers.bak.*` or
`.superpowers.stage.*` directory can remain in `marketplace/plugins/`. `probe`
reports recovery required, and install, update, and uninstall refuse until you
inspect and remove the leftover directory. Uninstall removes the marketplace
through Claude Code, verifies that it is gone, then deletes `marketplace/`.
The prepared candidate and saved selection are kept.

## Qualification

Native qualification ran `@anthropic-ai/claude-code` 2.1.281 as UID 10001 in
a read-only, network-disabled Linux container. It covered conflict refusal
before mutation, registration of snapshot A, a byte-stable `probe`, continued
activation of A after preparing B, update to B at the same published source
path, and exact, idempotent removal. A live Claude Code session needs API
credentials, so SessionStart hook execution was not observed; evidence stops
at registration and component inventory. The pinned version is qualification
evidence, not a runtime allowlist.

## Compare routes

| Action | Superpowers Manager | Direct upstream repository |
| --- | --- | --- |
| First install | `npx superpowers-manager install --harness claude-code` | `claude plugin marketplace add obra/superpowers`, then `claude plugin install superpowers@superpowers-dev` |
| Pin a version | `npx superpowers-manager pin TAG` then `npx superpowers-manager update --harness claude-code` | `claude plugin marketplace add obra/superpowers#TAG` (branch or tag only) |
| Inspect | `npx superpowers-manager probe --harness claude-code` | `claude plugin list` |
