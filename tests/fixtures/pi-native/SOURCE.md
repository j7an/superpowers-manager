The inert files in this directory are unmodified MIT-licensed source from
obra/superpowers v6.3.0, commit b36e0829c6d0140e93cfef2ca599b1b07d4a7797.
Their original paths are `.pi/extensions/superpowers.ts`, `package.json`,
`skills/using-superpowers/SKILL.md`, and `LICENSE`.
Source: https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797
The bootstrap was qualified with Pi 0.85.1 in Task 0. Tests copy these inert
bytes into disposable fixtures; no upstream extension executes on the host.

Historical Codex excerpts use the same upstream MIT license:

- `codex-legacy-cli.txt`: `.codex/superpowers-codex` at the explicit v3.3.0
  release commit `da9f4f1eddc741cce4c5b4864342e9068caec211` (there is no v3.3.0 tag).
- `codex-native-skill.txt`: `skills/using-superpowers/SKILL.md` at v4.2.0,
  `a98c5dfc9de0df5318f4980d91d24780a566ee60` (manifest-less native discovery).
- `codex-default-manifest.json.txt`: `.codex-plugin/plugin.json` at v5.1.0,
  `f2cbfbefebbfef77321e4c9abc9e949826bea9d7`.
- `codex-active-manifest.json.txt`: the same path at v6.0.0,
  `284be5905ed540d34ce5bcde24728b9b7f413ea0`.
- `codex-empty-manifest.json.txt`: the same path at v6.1.1,
  `d884ae04edebef577e82ff7c4e143debd0bbec99`.

Historical manifests establish packaging modes. Tests supply inert compatible
hook configuration fixtures; they do not claim qualification of arbitrary
historical hook execution.
