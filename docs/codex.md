# Codex reference

## Registration and generated manifest

Native container qualification uses `@openai/codex` 0.144.6. That dated test evidence is not a runtime allowlist: operations still require inspectable state, required integration behavior, and validated postconditions.

Codex installation registers `superpowers-manager` and installs or refreshes `superpowers@superpowers-manager`. The manager prepares a plugin tree, validates it, writes `.superpowers-upstream.json`, then verifies installed state after mutation.

When upstream supplies `.codex-plugin/plugin.json`, it is the manifest base and unknown fields are preserved. The fallback template is used only for refs with no upstream manifest. The manager enforces its plugin name, `skills: ./skills/`, and a ref-aware version ending in `+manager.<short-sha>`; provenance's upstream commit remains the identity used by `probe` and `update`.

An upstream `hooks` declaration owns hook materialization. Exact `{}` suppresses `hooks/`. Active declarations conditionally materialize upstream files. A missing declaration or `[]` uses Codex default discovery only when upstream provides `hooks/hooks.json`. Manifest-less fallback output declares no hooks and generates no hook directory. The manager creates no hooks and never changes Codex trust state.

Review definitions through Codex `/hooks`. Trusting a definition does not freeze a referenced script's contents, so review an explicit update before running it or trusting a newly surfaced definition.

## Refresh and versioning

`SUPERPOWERS_INSTALL_REFRESH_MODE=add-only` is the default: `plugin add` re-reads local source. `remove-add` removes only the Manager-owned plugin before re-adding it if a refresh fails to take:

```sh
SUPERPOWERS_INSTALL_REFRESH_MODE=remove-add npx superpowers-manager update --harness codex
```

Stable tags form versions such as `6.0.3+manager.896224c`; prerelease tags retain their prerelease segment. `main` forms `0.0.0-main+manager.<short-sha>`, another named ref forms `0.0.0-ref-<sanitized-ref>+manager.<short-sha>`, and a raw 40-character commit forms `0.0.0+manager.<short-sha>`.

`.superpowers-upstream.json` records `source`, `requested_ref`, `resolved_ref`, `commit`, and upstream manifest version. The generated version is for display and Codex package identity; the upstream commit is the authoritative identity that `probe` and `update` compare.

## Durable storage, migration, and recovery

The Manager keeps Codex preparation, publication, and unsettled-operation
material under the selected Codex home (`CODEX_HOME`, or `$HOME/.codex` by
default):

```text
superpowers-manager/
  prepared/                 validated plugin candidate
  marketplace/              registered Manager-owned marketplace and plugin
  recovery/                 material retained for an unsettled operation
```

`prepare` writes only the prepared candidate. `SUPERPOWERS_PLUGIN_ROOT` changes
that preparation location only; it does not change the durable marketplace.
`probe` is read-only. It can report that a previous Manager registration needs
migration or that recovery is required, but it does not migrate or repair it.

`install` and `update` publish the validated candidate to the durable
marketplace and verify Codex registration and the installed plugin. They
automatically migrate an earlier Manager marketplace source from an npm cache
or checkout, including when its selected upstream commit is unchanged. The old
source directory is left in place. Restart Codex if it has not loaded a
successful change yet.

`uninstall` removes the Manager-owned plugin and marketplace through Codex,
then removes the durable marketplace only after native deregistration is
verified. It retains the prepared candidate and saved upstream selection. If
the operation cannot establish the relevant state safely, it preserves recovery
material and blocks conflicting mutations until the state is inspected. There
is no general repair or purge command.

## Compare Codex routes

The following are alternative providers. Native CLI behavior below was checked against Codex `0.153.3`; retain that dated evidence until it is rechecked.

| Action | Superpowers Manager | Direct upstream repository |
|---|---|---|
| First install | `npx superpowers-manager install --harness codex` | `codex plugin marketplace add https://github.com/obra/superpowers`, then `codex plugin add superpowers@superpowers-dev` |
| Explicit update | `npx superpowers-manager update --harness codex` | `codex plugin marketplace upgrade superpowers-dev` |
| Inspect | `npx superpowers-manager probe --harness codex` | `codex plugin list` |

The manager defaults to upstream's highest stable tag. Direct registration without `--ref` follows its configured default branch; the curated [`superpowers@openai-curated` copy](https://github.com/openai/plugins/tree/main/plugins/superpowers) follows its own refresh policy. The upstream [marketplace manifest](https://github.com/obra/superpowers/blob/main/.agents/plugins/marketplace.json) names `superpowers-dev`.

To change the selected ref, choose one of these alternative routes and replace
`TAG` with the intended ref.

### Manager

```sh
npx superpowers-manager pin TAG
npx superpowers-manager update --harness codex
```

### Direct upstream repository

```sh
codex plugin marketplace remove superpowers-dev
codex plugin marketplace add https://github.com/obra/superpowers --ref TAG
codex plugin add superpowers@superpowers-dev
```

In the checked CLI, `marketplace upgrade` follows its configured ref, can refresh installed plugins when the marketplace changes, and has no `--ref`. Codex also has an automatic refresh path for Git marketplaces; see the [native implementation](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core-plugins/src/manager.rs).

## Migration

```sh
npx superpowers-wrapper@0.1.1 uninstall
npx superpowers-manager install --harness codex
```

State owned by the older `superpowers-wrapper` provider blocks Manager mutation
until removed with that provider's own command; it is never removed
automatically. This is separate from automatic migration of an earlier
`superpowers-manager` source described above.
