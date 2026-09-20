The inert files in this directory are unmodified MIT-licensed source from
obra/superpowers.

- `bootstrap.js.txt`: original path `.opencode/plugins/superpowers.js`,
  v6.4.1, commit 5bf4e78011075bcfc0dc295f0724994cd123ee71.
  Source: https://github.com/obra/superpowers/tree/5bf4e78011075bcfc0dc295f0724994cd123ee71
- `entrypoint.js.txt`: original path `index.js`, v6.4.1,
  commit 5bf4e78011075bcfc0dc295f0724994cd123ee71.
  Source: https://github.com/obra/superpowers/tree/5bf4e78011075bcfc0dc295f0724994cd123ee71
- `bootstrap-6.3.0.js.txt`: original path `.opencode/plugins/superpowers.js`,
  v6.3.0, commit b36e0829c6d0140e93cfef2ca599b1b07d4a7797
  (byte-identical in v6.0.0 through v6.3.0).
  Source: https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797

The shared `package.json`, `skills/using-superpowers/SKILL.md`, and `LICENSE`
bytes live in `tests/fixtures/pi-native`.

Tests copy these inert files into disposable fixtures. They execute only inside
the isolated, network-disabled native OpenCode qualification container and
never on the host.
