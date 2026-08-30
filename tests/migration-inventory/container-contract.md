# Migration inventory: tests/test_container_contract.sh
<!-- FROZEN: historical migration record. Declared historical against ad56569a4c161e7b122967442e2b026eeb6395f6. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 0b6d50e1e9c688397285c6fa274dc8c9437d8ba3:tests/test_container_contract.sh -->

Source read in full (677 lines). Ported to
`tests/bin/container-contract.test.js`.

`grep -n 'test_container_contract' docs/baseline/traceability.md` on
2026-07-31 returns zero matches: no behavior ID in
`docs/baseline/traceability.md` references this driver, so the 121-ID count
cannot detect a dropped assertion here. This inventory, not that count, is
the evidence that no assertion was dropped.

Lines 1-13 (shebang, harness sourcing, `spw_test_root`, and path variable
assignment) are setup, not assertions, and are not numbered. Line 677
(`echo "test_container_contract: OK"`) is driver-completion output.

The driver's second half (`:95-675`) is a single `ruby - "$runner" <<'RUBY'`
/ `ruby - "$probe" "$hooks_rpc" <<'RUBY'` invocation whose Ruby body defines
helper functions, calls them once against the real repository files, then
defines two `mutations`/`rpc_mutations` hashes and asserts every mutated
variant is rejected by the same validator. Because `set -eu` is in effect,
any unhandled Ruby exception aborts the whole driver — the abort-on-raise
behavior itself is the assertion mechanism for every item below drawn from
that block.

## File-existence and executable-bit preconditions (`:14-19`)

<!-- inventory:mapped:start -->

1. `tests/container/Dockerfile` exists.
2. `tests/container.sh` is executable.
3. `tests/container/package.json` exists.
4. `tests/container/codex-offline-probe.sh` is executable.
5. `tests/tsconfig.json` exists.
6. `.dockerignore` exists (repo root).

## Dockerfile literal-text assertions (`:21-27`)

7. Dockerfile contains the exact line `FROM node:24-bookworm-slim`.
8. Dockerfile contains the exact line
   `RUN useradd --create-home --uid 10001 spw`.
9. Dockerfile contains the exact line `USER spw`.
10. Dockerfile contains the substring
    `./node_modules/.bin/codex --version >/dev/null`.
11. Dockerfile contains the substring `corepack enable`.
12. Dockerfile contains the substring `pnpm install --frozen-lockfile`.
13. Dockerfile contains the substring `pnpm run build`.

## Container tool package/lockfile assertions (`:31-61`, embedded Node script)

14. `tests/container/package.json` declares a `dependencies` object.
15. That `dependencies` object's key set is exactly `["@openai/codex"]`
    (nothing else).
16. The declared `@openai/codex` version is an exact semver (no range
    operators), matched against
    `/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/`.
17. `package-lock.json`'s root package's `dependencies["@openai/codex"]`
    equals the declared version.
18. `package-lock.json`'s `packages["node_modules/@openai/codex"].version`
    equals the declared version.

## `tests/tsconfig.json` assertions (`:62-67`)

19. Resolves `"module"` to `NodeNext`, compared against the effective
    configuration reported by `tsc --showConfig` rather than the file's text.
20. Resolves `"moduleResolution"` to `NodeNext`, same method.
21. **RETIRED 2026-08-01 — number deliberately not reused.** Originally: "Does
    **not** contain the substring `"Node16"`." Retired when items 19-20 moved
    from raw-text substring matching to the effective configuration. A
    `tsconfig.json` whose effective `module` resolves to Node16 by any route —
    including the duplicate-key last-wins case this negative check existed to
    catch — now fails item 19, so the check has nothing left to catch. The old
    check was also case-sensitive where `tsc` is not (verified on TypeScript
    7.0.2: `Node16`, `node16`, `NODE16`, and `nOdE16` all compile), so it
    could be bypassed by spelling alone. Numbering 22-172 is unchanged: this
    inventory is referenced by 16 range comments in
    `tests/bin/container-contract.test.js`, and renumbering 151 items to
    delete one would produce a large diff of pure arithmetic across the very
    artifact whose purpose is detecting undeclared count changes. This is a
    deliberate 1:1 divergence from the deleted shell driver.

## `tests/container.sh` literal-text assertions (`:68-74`)

22. Contains the substring `--network none`.
23. Contains the substring `--read-only`.
24. Contains the substring `docker build --pull `.
25. Contains the substring
    `--tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001`.
26. Contains the substring `codex-spike)`.
27. Contains the substring `actual_uid=$(id -u)`.
28. Contains the substring `container acceptance suite must run as UID 10001`.

## `.gitignore` / `.dockerignore` exact-line assertions (`:75-79`)

29. `.gitignore` contains the exact line `plugins/.superpowers.bak.*/`.
30. `.dockerignore` contains the exact line `.superpowers/`.
31. `.dockerignore` contains the exact line `.worktrees/`.
32. `.dockerignore` contains the exact line
    `plugins/.superpowers.prepare.*/`.
33. `.dockerignore` contains the exact line `plugins/.superpowers.bak.*/`.

## `hooks-list-rpc.py` file assertions (`:81-93`)

34. `tests/container/hooks-list-rpc.py` exists.
35. `tests/container/hooks-list-rpc.py` is **not** executable.
36. Contains the exact line `from __future__ import annotations`.
37. `python3 -S -c ast.parse(...)` on the file's contents succeeds (the file
    is syntactically valid Python).

## `tests/container.sh` `--inside` structural assertion (`:95-115`, Ruby block 1)

38. The runner text matches
    `/^if \[ "\$\{1:-\}" = "--inside" \]; then\n(?<body>.*?)^fi\n\nmode="\$\{1:-suite\}"/m`
    — i.e. the `--inside` branch exists, is closed by a bare `fi`, and is
    immediately followed by the host-side `mode="${1:-suite}"` line.
39. Within that `--inside` body, the exact 5-line UID guard block
    (`actual_uid=$(id -u)` / `if [ "$actual_uid" != 10001 ]; then` / the
    `echo "error: container acceptance suite must run as UID 10001 ..."`
    line / `exit 1` / `fi`) is present, and precedes both the
    `mode="${2:-suite}"` line and the `case "$mode" in` line, which
    themselves appear in that order.
40. The runner text matches
    `/suite\)\s+sh tests\/run\.sh\s+exec sh tests\/container\/codex-offline-probe\.sh\s+;;/`
    — the `suite)` case runs the inner suite then execs the offline probe.

## `codex-offline-probe.sh` structural assertions (`:117-524`, Ruby block 2, `validate_probe!`)

41. No unwrapped `codex plugin ...` invocation exists (every Codex call must
    route through the timeout wrapper) — checked via
    `/^\s*codex\s+plugin\s+/`.
42. The `run_codex` function body is exactly the one active line
    `"$timeout_bin" 30 codex "$@"`.
43. The `run_manager` function body is exactly the 6 expected
    `SUPERPOWERS_*`-prefixed lines ending in
    `"$package/bin/superpowers-manager.js" "$@"`.
44. The `assert_active_installed_commit` function body contains a
    `python3 -S - "$listing" ... <<'PY' ... PY` heredoc block matched by a
    specific regex (i.e. the fingerprint helper passes exactly those five
    positional arguments to Python).
45. The shell prefix before that heredoc (inside
    `assert_active_installed_commit`) is exactly the 5 expected lines
    (`listing="$1"` through
    `expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"`).
46. Exactly one line inside that Python block matches
    `/\Aactive_root\s*=/`, and it equals
    `active_root = Path(root_arg).resolve(strict=True)`.
47. Inside that Python block, the 9-statement binding sequence (`data =
    json.loads(listing)` ... `matches[0].get("version") != expected_version`
    ... `active_root = ...` ... the provenance-file open line ... the
    manifest-file open line) appears in that exact order.
48. The provenance-file open line
    (`with (active_root / ".superpowers-upstream.json").open(...)`) appears
    exactly once, and only in that form (no other match of
    `.superpowers-upstream.json`).
49. The manifest-file open line
    (`with (active_root / ".codex-plugin" / "plugin.json").open(...)`)
    appears exactly once, and only in that form (no other match of
    `plugin.json`).
50. None of the Python block's lines is a bare `pass` or an
    `if False:`/`if 0:` no-op guard.
51-65. The probe source contains each of the following 15 literal
    statements (regardless of order): `commit_a=$(git -C "$upstream"
    rev-parse HEAD)`; `version_a="1.0.0+manager.$short_a"`;
    `commit_b=$(git -C "$upstream" rev-parse HEAD)`;
    `version_b="1.1.0+manager.$short_b"`; `run_manager track-latest`;
    `run_manager install`; `initial_listing=$(run_codex plugin list
    --json)`; `assert_active_installed_commit "$initial_listing"
    "$version_a" "$commit_a" ""`; `reload_listing=$(run_codex plugin list
    --json)`; `assert_active_installed_commit "$reload_listing"
    "$version_a" "$commit_a" "$commit_b"`; `run_manager update`;
    `updated_listing=$(run_codex plugin list --json)`;
    `assert_active_installed_commit "$updated_listing" "$version_b"
    "$commit_b" "$commit_a"`; `run_manager uninstall`;
    `assert_marketplace_root "$package"`.
66. The reload-opportunity line `reload_listing=$(run_codex plugin list
    --json)` is present (duplicate presence check on the same text as item
    59, expressed as its own guard in the source).
67. The probe does **not** sweep retained cache paths — no match of
    `/find\s+.*(?:superpowers-manager|\.superpowers-upstream\.json)/` and no
    occurrence of the literal `search_root.rglob`.
68. The literal `install_plugin_and_assert_active` does not appear (old
    generic install helper must be replaced).
69. The literal `assert_marketplace_root "$moved"` does not appear (old
    moved-marketplace assertion must be replaced).
70. The probe matches
    `/final_plugins=\$\(run_codex plugin list --json\).*final_marketplaces=\$\(run_codex plugin marketplace list --json\)/m`
    (dot matches newline) — both final listings are captured, in that
    order, before the absence assertions.
71. The probe contains the substring
    `run_codex app-server generate-json-schema --out "$schema_root"`.
72. The probe contains both `"$timeout_bin" 30 python3 -S \` and
    `"$package/tests/container/hooks-list-rpc.py"` (the bounded hooks/list
    helper invocation).
73-90. The probe source contains each of the following 18 literal
    strings, checked independently: `schema_root="$root/app-server-schema"`;
    `Codex hooks/list protocol changed`; `ClientRequest.json`;
    `v2/HooksListResponse.json`; `"hooks/list"`; `"source"`; `"enabled"`;
    `"isManaged"`; `"trustStatus"`; `"pluginId"`; `"plugin"`; `"untrusted"`;
    `"hooks": {}`; `"hooks": "./hooks/hooks-codex.json"`; item 87
    (below); `/tmp/superpowers-manager-hook-sentinel`;
    `$HOME/.codex/hooks.state`; `$HOME/.codex/requirements.toml`.

    **Item 87, corrected 2026-07-31 (review Finding 1):** the Ruby
    literal at `:385` is `'sh \"${PLUGIN_ROOT}/hooks/session-start-codex\"'`
    — a Ruby **single-quoted** string, where `\"` is not an escape
    sequence. The required text therefore carries two literal backslash
    characters: `sh \"${PLUGIN_ROOT}/hooks/session-start-codex\"`. This
    guards the escaped-quote spelling written into the upstream
    `hooks-codex.json` JSON fixture at `codex-offline-probe.sh:588`. An
    earlier revision of this inventory (and the port) recorded the
    *unescaped* spelling (`sh "${PLUGIN_ROOT}/hooks/session-start-codex"`,
    which happens to also appear at `:229` inside
    `assert_active_hooks_fixture`'s expected-config Python literal) as if
    it were item 87 — both spellings exist in the probe, so the port was
    green, but the wrong line was being guarded and `:588` was unguarded.
    The port now requires the correct backslash-bearing string as item 87,
    **plus** the unescaped spelling as a 173rd, strictly-additive,
    port-only assertion (it has no shell counterpart — the shell never
    guarded `:229` — and is outside the 172 1:1 count), so both fixtures
    stay covered. That port-only check is now numbered entry 1 under
    "Port-only assertions (outside the 1:1 mapping)" below.
91. The probe contains the substring `probe_cwd=$(pwd -P)` (resolves its
    real working directory).
92. The probe does **not** invoke the synthetic hook script directly — no
    match of `/(?:^|\s)session-start-codex(?:\s|$)/`.
93. The probe does **not** contain `--dangerously-bypass-hook-trust`.
94. The probe does **not** make model calls — no match of
    `/\brun_codex\s+(?:e|exec)\b/`.
95. `assert_manager_hooks_absent`'s body gates its terminal check
    (`if manager_hooks:`) behind the ordered 9-statement response-validation
    sequence shared by both hook-response assertions (id==1 check, error
    check, result-is-dict check, data-is-list check, `manager_hooks = [`
    line, then the terminal).
96. `assert_manager_hook_active`'s body gates its terminal check (`if
    len(manager_hooks) != 1:`) behind that same ordered 9-statement
    sequence.
97-101. `assert_manager_hook_active`'s body contains each of the following
    5 literal strings: `"source": "plugin",`;
    `"pluginId": "superpowers@superpowers-manager",`; `"trustStatus":
    "untrusted",`; `if actual.get("enabled") is not True:`; `if
    actual.get("isManaged") is not False:`.
102. `assert_hooks_schema_compatible`'s body contains, in order, the
    5-statement sequence: `if "pluginId" not in properties:`; `if
    "pluginId" in required:`; `fail("HookMetadata pluginId unexpectedly
    became required")`; `plugin_id_types = allowed_types(hooks_response,
    properties["pluginId"])`; `if plugin_id_types != {"string", "null"}:`.
103. `capture_hooks_response`'s active (non-blank, non-comment) lines are
    exactly the 7 expected lines (`probe_cwd=$(pwd -P)` through the `fi`
    closing the RPC-failure branch), verbatim and in that order.
104. `run_manager track-latest` occurs exactly once at the probe's top
    level (outside any function body, outside any heredoc).
105. That occurrence is immediately preceded by
    `hook_state_before=$(snapshot_hook_state)` and immediately followed by
    `hook_state_after=$(snapshot_hook_state)`.
106. `run_manager install` occurs exactly once at the top level.
107. That occurrence is immediately bracketed by the same before/after
    snapshot lines.
108. `run_manager update` occurs exactly once at the top level.
109. That occurrence is immediately bracketed by the same before/after
    snapshot lines.
110. `run_manager uninstall` occurs exactly once at the top level.
111. That occurrence is immediately bracketed by the same before/after
    snapshot lines.
112. `assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"`
    occurs at the top level exactly 4 times (once per manager mutation).
113. `assert_requirements_unchanged` occurs at the top level at least 4
    times.
114. `assert_sentinel_absent` occurs at the top level at least 5 times.
115. The probe's full top-level acceptance lifecycle (`chmod +x
    "$package/bin/superpowers-manager.js"` through
    `final_marketplaces=$(run_codex plugin marketplace list --json)`, ~50
    statements) appears in the exact expected order, and every statement in
    that expected sequence occurs at the top level exactly the number of
    times the expected sequence itself repeats it (e.g. `assert_sentinel_absent`
    appears in the expected sequence 5 times and must occur exactly 5 times
    in the actual top-level lines — this is the same predicate as items
    112-114 but re-derived from the ordered lifecycle list rather than a
    freestanding count, and is listed separately because it can fail
    independently of them: a statement can have the right *count* while
    being out of *order*).

## `hooks-list-rpc.py` protocol-gate assertions (`:195-224`, Ruby block 2, `validate_hooks_rpc!`)

116-141. The RPC helper's source contains each of the following 26 literal
    strings, checked independently (order not required for this list):
    `raise SystemExit(f"Codex hooks/list protocol failed: {message}")`; `if
    process.poll() is not None or process.stdin is None:`; `fail(f"could
    not send request: {exc}")`; `def reject_constant(constant: str) ->
    None:`; `raise ValueError(f"non-standard numeric constant:
    {constant}")`; `parse_constant=reject_constant`; `fail(f"malformed
    JSONL response: {exc}")`; `deadline = time.monotonic() + 25`;
    `remaining = deadline - time.monotonic()`; `if remaining <= 0 or not
    selector.select(remaining):`; `fail("timed out waiting for app-server
    output")`; `fail("app-server stdout is unavailable")`; `chunk =
    os.read(process.stdout.fileno(), 65536)`; `if not chunk:`; `fail("EOF
    before the required response")`; `if not isinstance(message, dict):`;
    `id_value = message.get("id")`; `if type(id_value) is not int or
    id_value != expected_id:`; `if "error" in message:`; `if "result" not
    in message:`; `fail(f"response id {expected_id} has no result")`;
    `["codex", "app-server"]`; `stdin=subprocess.PIPE`;
    `stdout=subprocess.PIPE`; `fail("app-server stdout pipe was not
    created")`; `selector.register(process.stdout, selectors.EVENT_READ)`.

    (Note: this is 26 distinct strings in the source list at `:196-223`,
    numbered 116-141.)

142. The RPC helper's source contains, in order, the 7-statement initialize
    handshake sequence: `"id": 0,`; `"method": "initialize",`;
    `receive(process, selector, 0)`; `send(process, {"method":
    "initialized"})`; `send(process, {"id": 1, "method": "hooks/list",
    "params": {"cwds": [cwd]}})`; `response = receive(process, selector,
    1)`; `Path(response_name).write_text(`.

## Semantic-mutation fixtures against the probe validator (`:531-581`)

Each mutation below rewrites one substring of the real probe text and
asserts that the resulting text is rejected by the combined `validate_probe!`
check above (i.e. at least one of items 41-115 must fail against it). A
mutation that produces byte-identical text to the original (a no-op
substitution) is itself a driver bug and aborts the driver.

143. `no-op run_manager` (body replaced with `:`) is rejected.
144. `unbracketed install lifecycle` (removes the before/after snapshot
    lines around `run_manager install`) is rejected.
145. `unbound fingerprint root` (hardcodes `expected_root` to
    `/tmp/unbound-manager-cache`) is rejected.
146. `unbound Codex listing version` (weakens the version-match guard to a
    tautology `expected_version != expected_version`) is rejected.
147. `required pluginId accepted` (weakens `if "pluginId" in required:` to
    `if False:`) is rejected.
148. `additional pluginId types accepted` (weakens the exact-set check to a
    subset check) is rejected.
149. `non-boolean enabled accepted` (changes `is not True` to `!= True`) is
    rejected.
150. `non-boolean isManaged accepted` (changes `is not False` to `!=
    False`) is rejected.
151. `captured hooks stderr removed` (replaces `cat "$hooks_stderr" >&2`
    with `:`) is rejected.
152. `captured hooks stderr leaked to stdout` (drops the `>&2` redirect) is
    rejected.

## Semantic-mutation fixtures against the RPC-helper validator (`:584-665`)

Each mutation below rewrites one substring of the real
`hooks-list-rpc.py` text and asserts the result is rejected by
`validate_hooks_rpc!` (i.e. at least one of items 116-142 must fail against
it).

153. `missing pre-send process check` is rejected.
154. `missing send failure gate` is rejected.
155. `missing malformed JSON gate` is rejected.
156. `missing non-standard constant parser` is rejected.
157. `weakened non-standard constant rejection` is rejected.
158. `removed deadline` is rejected.
159. `unbounded selector wait` is rejected.
160. `missing EOF failure` is rejected.
161. `missing stream availability gate` is rejected.
162. `missing JSON object check` is rejected.
163. `missing response id gate` is rejected.
164. `weakened exact response id type` is rejected.
165. `missing RPC error gate` is rejected.
166. `skipped initialize request` is rejected.
167. `missing app-server pipe gate` is rejected.
168. `skipped initialize response` is rejected.
169. `skipped initialized notification` is rejected.
170. `skipped hooks request` is rejected.
171. `missing hooks response presence gate` is rejected.
172. `missing result gate` is rejected.

<!-- inventory:mapped:end -->

## Port-only assertions (outside the 1:1 mapping)

<!-- inventory:port-only:start -->

1. The probe contains the unescaped spelling
   `sh "${PLUGIN_ROOT}/hooks/session-start-codex"` (no backslashes) — the
   expected-config Python literal spelling used inside
   `assert_active_hooks_fixture` at `:229`. Distinct from item 87, which
   guards the escaped-quote spelling written at `:588`. Port-only — the
   shell never guarded `:229`; added 2026-07-31 when review Finding 1
   corrected item 87 to require the correct backslash-bearing string (see
   the note under item 87 above), so both fixtures stay covered.
2. **The Dockerfile installs exactly `ca-certificates git procps python3`.** Added by
   PR 11.1 (2026-08-02) as the gate for the Ruby retirement. The Dockerfile's
   `apt-get install` line was previously unasserted — items 7-13 cover the base
   image, user, corepack, install, and build lines but not the package set — so
   removing `ruby` would have broken no test, and re-adding it would have broken
   none either. Asserted as an exact sorted set rather than as "does not contain
   ruby", because the latter is an enumeration of one known-bad value.
   Port-only; outside the 1:1 mapping.

<!-- inventory:port-only:end -->

## Cardinality

```json inventory
{
  "shellOriginal": 172,
  "portOnly": 2,
  "ports": { "tests/bin/container-contract.test.js": 1 }
}
```

- Shell original: **172** assertions (6 preconditions, 7 Dockerfile
  literal-text, 5 package/lockfile, 2 tsconfig (item 21 retired — see above),
  7 container.sh literal-text, 5 gitignore/dockerignore, 4 hooks-list-rpc.py
  file, 3 `--inside` structural, 75 `validate_probe!` structural (items
  41-115), 27 `validate_hooks_rpc!` protocol-gate (items 116-142), 10 probe
  semantic-mutation fixtures, 20 RPC semantic-mutation fixtures).
- Port (`tests/bin/container-contract.test.js`): 173 assertions (**171 live
  of 172 numbered** — item 21 retired, its number not reused — 1:1-mapped
  to the shell, plus 2 strictly-additive port-only checks — see
  the note under item 87 and port-only entries 1-2 below), grouped into `node:test` subtests by
  section for readability. Items expressed as loops over a literal-string
  array in the shell (e.g. 51-65, 73-90, 116-141) are ported as loops over
  the same array inside `validateProbe`/`validateHooksRpc`, one `throw` per
  missing element (the loop bodies' `throw new ContractViolation(...)`
  statements are at `:404`, `:484`, and `:718` in the shipped file). Each
  such loop is exercised through a single
  `assert.doesNotThrow(() => validateProbe(...))` /
  `assert.doesNotThrow(() => validateHooksRpc(...))` subtest — the loop
  itself short-circuits on the first missing element, exactly as the
  Ruby `.each { |text| raise ... unless ... }` loops did. This preserves
  the shell's failure-attribution granularity (the thrown message names
  the specific missing element) without claiming a separate `t.test` per
  array entry.
- Reconciliation: 1:1 for 171 of 172 shell items, no merges and no drops;
  item 21 is a **deliberate retirement**, not a drop — items 19-20 subsume
  it (see the note at item 21) — plus 2 additional port-only assertions (see
  item 87's note and port-only entries 1-2 below) that are strictly additive
  and outside the 1:1 mapping.
