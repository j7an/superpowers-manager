# Hermes Agent reference

Use `--harness hermes` to prepare, inspect, install, update, or remove the
Hermes Agent integration. The manager runs the installed `hermes` executable
for plugin mutations only; set `SUPERPOWERS_HERMES` to select another
executable. State lives under `HERMES_HOME`, or `$HOME/.hermes` by default.

The manager prepares a validated flat plugin at
`$HERMES_HOME/plugins/superpowers`, with the manifest and `skills/` directory
at its root. Hermes also discovers plugins one level below this directory, so
publishing the upstream nested tree would expose its `.muse-plugin` copy as a
second plugin with the same key. Prepared content is kept separately under
`$HERMES_HOME/superpowers-manager/prepared`; invocation-owned publish stages
and backups use `$HERMES_HOME/superpowers-manager/publish.<id>/` so Hermes
cannot discover them as plugins.

Restart Hermes sessions after install, an activating update, or removal.
Superpowers' Hermes integration has no post-compaction hook, so its workflow
cannot automatically re-establish context after compaction.

## Switching from another Superpowers route

The manager refuses installation when another plugin directory declares the
`superpowers` key or when its managed directory is foreign. Remove the
conflicting plugin directory yourself before retrying; disabling it does not
clear the refusal, and the manager never removes another provider. If
installation or update refuses because `HERMES_ENABLE_PROJECT_PLUGINS` is set,
unset that variable and retry. A project-local copy can override the managed
copy.

| Action | Superpowers Manager | Direct upstream repository |
| --- | --- | --- |
| First install | `npx superpowers-manager install --harness hermes` | `hermes plugins install obra/superpowers --enable` |
| Pin a version | `npx superpowers-manager pin TAG` then `npx superpowers-manager update --harness hermes` | `hermes plugins install obra/superpowers --enable --ref <sha>` |
| Inspect | `npx superpowers-manager probe --harness hermes` | `hermes plugins list` |

## Recovery

The root contains an empty regular file named `__pycache__`. Python normally
writes import bytecode beside the plugin, which would change the owned
snapshot. This sentinel prevents that write while Hermes imports the plugin.
If upstream adds an imported subpackage, its own `__pycache__` may make the
snapshot fail ownership checks; support would need a sentinel for that package.

If an install or update is interrupted, a
`$HERMES_HOME/superpowers-manager/publish.*` directory can remain. `probe`
reports recovery required, and install, update, and uninstall refuse until you
inspect and remove the leftover directory. The prepared candidate and saved
selection are kept.

## Qualification

Native qualification ran Hermes Agent v0.21.5 (2026.9.24), built from
`NousResearch/hermes-agent` commit
`f97608f178d1ffeca59860195ab7da295f7c8e5f`, as UID 10001 in a read-only,
network-disabled Linux container. The native plugin lifecycle passed. Real
upstream `hermes plugins doctor <published-root> --ci` passed for Superpowers
v6.3.0 and v6.4.2, including plugin discovery, manifest parsing, import, and
registration. Superpowers v6.1.1 and v6.2.0 were refused cleanly because those
releases do not provide a native Hermes plugin. These versions are
qualification evidence, not runtime allowlists.
