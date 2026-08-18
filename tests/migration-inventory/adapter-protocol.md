# Migration inventory: tests/test_adapter_protocol.sh
<!-- FROZEN: historical migration record. Declared historical against 16aad89795876eb94d22e2350ba71cdf86613859. -->
<!-- Port pointers are NOT maintained. An item's identity is its quoted assertion text, not its number. -->
<!-- Resolve shell-original citations with: git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.sh -->

Source read in full: the shell driver (864 lines) and the Python driver it
invoked, `tests/test_adapter_protocol.py` (937 lines). One inventory covers
both because they were a single registered unit — `tests/test_adapter_protocol.sh:19`
invoked the Python suite, and the Python suite had no entry of its own in
`tests/suites.json` or `tests/run.sh`, so deleting the shell driver left
nothing for the runner to reach. (An earlier draft of this sentence said the
Python suite "was never independently runnable", which is false — it ends in
`if __name__ == "__main__": unittest.main()` and runs standalone under
`python3 -S`. The one-inventory decision does not depend on runnability, only
on the pair sharing one entry point into the runner, one deletion commit, and
fixture context that splitting would duplicate or orphan.)

Both drivers exercised the retired serialized protocol-v1 wire format between
the manager and its Codex adapter, replaced by the in-process adapter
boundary. Almost every behavior either dies with the wire format itself or
already has an in-process witness ported ahead of this deletion (PR-1, PR-2,
PR-3.1, PR-3.2); `docs/baseline/protocol-disposition.md` records the
authoritative per-behavior-ID disposition (`remap` or `retire`) this inventory
follows. **Five** shell-owned behavior IDs retained no prior in-process
witness and are ported here for the first time — `CLI-ENV-REFRESH-MODE-01`,
`CLI-ENV-CODEX-MUTATION-01`, `CLI-ENV-CODEX-LISTING-01`,
`CLI-ENV-INSTALLED-DEFAULTS-01`, and `CLI-ENV-INSTALLED-ROOT-01`, all to
`tests/baseline/cli-parity.test.js`. A sixth shell-owned ID,
`PROV-READER-CODEX-SOURCE-01`, ports to `tests/unit/provenance.test.js` but is
**not** a first-time port: PR-1 already witnessed that matrix row, and only
its **Bytes** cell was unwitnessed, which PR-3.2 ported ahead of this deletion
(see items 154-173 below). `tests/unit/adapter.test.js` already carries
most of the remaining remapped IDs but is excluded from this inventory's
`ports` map: `node-cli-helper.md` already claims it, and no port file is
claimed by two inventories. Where this inventory's items duplicate coverage
`tests/unit/adapter.test.js` or another already-frozen inventory already
carries, they are marked **Retired at the gap** citing that existing coverage
rather than claimed as a port of this record.

The shell-original anchor is the last commit in which both drivers existed:
`41c99390f51a0cbeb552ab0a0bff26fc1c5c07df`. `shellOriginal` covers both
drivers here, and its name does not: no other inventory in this directory
spans two source files in two languages. Every citation inside the mapped
region below therefore carries its full path — `tests/test_adapter_protocol.sh:NN`
or `tests/test_adapter_protocol.py:NN` — rather than the usual bare `` `:NN` ``
abbreviation, because a bare `:848` would name two different lines in two
different languages sharing one record.

## Counting rules applied

- **Shell half.** The mechanical count is `probe.md`'s regex, unchanged
  (`tests/migration-inventory/probe.md:61-62`):
  `grep -nE '^[[:space:]]*(test |\[ |assert_[a-z_]+ |grep -[A-Za-z]*q)|\| *grep -[A-Za-z]*q' tests/test_adapter_protocol.sh`,
  returning **156** lines at `41c9939`. It inherits every extension
  `bin-dispatch.md`, `probe.md`, and their siblings have already made: bare
  predicates under `set -eu`, `if <command>; then …; exit 1; fi` negative
  guards, and a helper definition's own body credited to its call sites
  rather than counted in addition to them.
- **The regex cannot see an `if`-led or `!`-led guard**, so a supplementary
  sweep (`grep -nE '^[[:space:]]*(if |! )' tests/test_adapter_protocol.sh`)
  enumerates those shapes separately: **29** lines, disjoint from the 156.
  Each of the 29 was adjudicated individually against the driver. **22 are
  negative guards asserting a property of the product** — `if <command>; then
  echo …; exit 1; fi`, where succeeding is itself the failure, or a bare
  `! grep -Fq …` predicate under `set -eu` — so each is one assertion and one
  item, recovered as a count-raising `+22` divergence below. That is
  `bin-dispatch.md`'s negative-guard rule as `probe.md:70-76` applies it (`+3`
  and `+1` for this exact shape) and as `ref-resolution.md:14-16`,
  `prepare.md`, `install-commands.md`, `uninstall-commands.md`,
  `codex-state-units.md`, `selection-commands.md`, and `node-cli-helper.md`
  apply it. The remaining **7** are harness control flow — the fake `codex`
  stub's own argument dispatch and the system-Python compatibility probe in
  setup — and are declared `unswept` in the Divergences section below with a
  written reason, the disposition `probe.md` gave its `:631` and
  `selection-commands.md` its `:271`. Recovery is by divergence, never by
  widening the census regex: sixteen frozen records derive their baseline from
  that expression, and a record whose baseline came from a different one is
  not comparable with any of them.
- **`assert_identity_state` (`:147-167`)** is a named helper whose own body
  (`:162-166`) contains five bracket-test lines the mechanical regex matches,
  called from four call sites (`:169`, `:173`, `:177`, `:181`) the regex also
  matches. Per `selection-commands.md`'s and `probe.md`'s rule, each call site
  is one item bundling its five checks; the five body lines are not
  additional items and are declared `unmapped` below, credited to their call
  sites.
- **Python half.** The driver is a `unittest.TestCase`
  (`AdapterProtocolValidatorTests`, `:129`), and its assertions are
  `self.assert*` calls: `grep -nE 'self\.assert' tests/test_adapter_protocol.py`
  returns **77** raw lines. Five helper methods —
  `assert_rejected_result` (`:133`), `assert_valid` (`:146`),
  `assert_raw_valid` (`:165`), `assert_invalid` (`:187`), and
  `assert_raw_invalid` (`:205`) — bundle several `self.assertX` calls each.
  Their **20** body lines are not items, exactly as a shell helper
  definition's body is not; each of their **28** call sites is one item, one
  per call, however many checks the body bundles. One of those 28 sits inside
  another helper's body (`assert_raw_invalid` calls `assert_rejected_result`
  at `:222`) and is excluded on the same ground. So 77 − 20 − 1 = **56**: 29
  direct `self.assertX` assertions plus 27 helper call sites. The excluded 21
  lines are `:139-142`, `:144` (`assert_rejected_result` body); `:160-163`
  (`assert_valid` body); `:182-185` (`assert_raw_valid` body); `:199-203`
  (`assert_invalid` body); and `:222-223`, `:225` (`assert_raw_invalid`
  body, including its own nested call to `assert_rejected_result` at `:222`).
  None of the 21 is cited by any item below.
- Python-driver citations (`tests/test_adapter_protocol.py:NN`) resolve at the
  same commit: `git show 41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.py`. The
  canonical header carries one resolution anchor and it names the shell
  driver; both retired in the same commit, so one SHA serves both.
- **Derived baseline: 156 + 56 = 212 items, before this file's own
  divergences.** Two divergences apply, in opposite directions: **−5** for
  the five `assert_identity_state` body lines the mechanical shell census
  counts and no item maps, and **+22** for the supplementary sweep's negative
  guards, which the census structurally cannot see and which items above do
  map. The machine-readable block below records the first as its five
  `unmapped` entries and the second as its twenty-two `added` entries — an
  `added` entry is by definition a cited line the census never counted, which
  is exactly what a recovered guard is. No line is claimed by two items. So
  212 − 5 + 22 = **229**, which is `shellOriginal`.
- Every citation inside the mapped region carries its full path (see above);
  a bare `` `:NN` `` is rejected there. The bijection reads the mapped region
  only — prose in these counting rules, or in the Divergences section below,
  is not scanned for citations, and an unnumbered sentence between two items
  inside the mapped region is a hard failure rather than a mapping. The item
  grammar is the migration gate's own, `^(\d+)(?:-(\d+))?\.\s`
  (`tests/bin/migration-inventory.test.js:59`): a range heading such as
  `27-30.` claims four sequential item numbers for one written entry,
  matching `probe.md`'s and `container-contract.md`'s convention for a
  bundled group.
- Disposition vocabulary: **Port** names a citation this record counts toward
  its own `ports` declaration (`tests/baseline/cli-parity.test.js` or
  `tests/unit/provenance.test.js`). **Duplicate witness** marks an item whose
  behavior ID is owned, per `docs/baseline/protocol-disposition.md`, by the
  *other* retired driver (most commonly the Python suite) and already
  remapped or retired there; the shell line is a second, now-deleted witness
  of the same contract, not an independent port. **Retired at the gap** marks
  an item whose contract survives in-process but is already witnessed by
  pre-existing coverage another inventory claims; the citation names that
  coverage, and this record adds no port for it. **Retire** marks an item with
  no surviving in-process successor — most often because its contract is pure
  protocol-v1 wire format, and in one case (items 125-132's launch-failure
  clause) because a later change deliberately reversed the asserted behavior.
  A `Retire` never asserts that the retired clause itself survives elsewhere.
  It may still name a `Duplicate witness` for the same behavior ID, or a
  sibling path that does survive; what it never does is point at coverage for
  the clause it is retiring. Where a retired clause leaves a real gap, the
  item says so.

## Assertion inventory

<!-- inventory:mapped:start -->

### Fixture-validator wiring (`tests/test_adapter_protocol.sh:17-18`)

1-2. The fake adapter's response validator resolves to the expected fixture
   path and its module declares `from __future__ import annotations`
   (`tests/test_adapter_protocol.sh:17`, `tests/test_adapter_protocol.sh:18`).
   **Retire**: both check a property of the response validator itself
   (`tests/fixtures/protocol/core/validate-adapter-response.py`), which PR-3.3
   of this sequence deletes; no in-process subject remains.

### `ADAPTER-ENVELOPE-KEYS-01` missing envelope keys reject before replay (`tests/test_adapter_protocol.sh:21-42`)

3-7. A response missing a required protocol-v1 envelope key is rejected
   before result creation, and the malformed response's controlled failure
   never replays its `messages` array (`tests/test_adapter_protocol.sh:35`,
   `tests/test_adapter_protocol.sh:36`, `tests/test_adapter_protocol.sh:37`,
   `tests/test_adapter_protocol.sh:38`, and the
   `if grep -Fq 'must-not-replay' …; then echo …; exit 1; fi` negative guard
   that asserts the no-replay half directly
   (`tests/test_adapter_protocol.sh:39`)). **Retire**
   (shell-owned): pure wire format, per
   `docs/baseline/protocol-disposition.md`'s `ADAPTER-ENVELOPE-KEYS-01` row.
   Dies with PR 11.5's deletion of the serialized envelope.

### Adapter dispatch smoke cases: build, fingerprint, ownership, update-control (`tests/test_adapter_protocol.sh:81-112`)

8-25. A successful build reports no result, stdout, or stderr; a fingerprint
   inspection reports its view and 40-hex fingerprint; an ownership
   inspection reports its resource booleans and derived `manager` identity
   state; an update-control inspection reports `managed` (and, under the
   `update-control-unsupported` fixture scenario, `unsupported`); and the
   real Codex-shaped fixture adapter's update-control inspection reports the
   same shape via `spw_inspect_update_control` directly
   (`tests/test_adapter_protocol.sh:81`, `tests/test_adapter_protocol.sh:82`, `tests/test_adapter_protocol.sh:83`, `tests/test_adapter_protocol.sh:84`, `tests/test_adapter_protocol.sh:87`, `tests/test_adapter_protocol.sh:88`,
   `tests/test_adapter_protocol.sh:89`, `tests/test_adapter_protocol.sh:92`, `tests/test_adapter_protocol.sh:93`, `tests/test_adapter_protocol.sh:94`, `tests/test_adapter_protocol.sh:95`, `tests/test_adapter_protocol.sh:98`, `tests/test_adapter_protocol.sh:99`, `tests/test_adapter_protocol.sh:100`, `tests/test_adapter_protocol.sh:103`, `tests/test_adapter_protocol.sh:104`,
   `tests/test_adapter_protocol.sh:111`, `tests/test_adapter_protocol.sh:112`). **Duplicate witness** of `ADAPTER-FINGERPRINT-01`,
   `ADAPTER-OWNERSHIP-01`, and `ADAPTER-UPDATE-CONTROL-01`'s recognition
   half — all owned by the Python suite per
   `docs/baseline/protocol-disposition.md` and already remapped to
   `tests/unit/adapter.test.js`.

### A non-Codex-shaped adapter fails update-control inspection (`tests/test_adapter_protocol.sh:125-126`)

26-27. An adapter whose output does not match the expected Codex shape
   returns a non-zero status and produces no result file
   (`tests/test_adapter_protocol.sh:125`, `tests/test_adapter_protocol.sh:126`).
   **Duplicate witness** of `ADAPTER-UPDATE-CONTROL-01`'s recognition rule
   (the third-value/malformed rejection half), which remaps to
   `requireManagedUpdateControl` (`src/lifecycle.ts`), witnessed in
   `tests/unit/lifecycle.test.js` — already claimed by `codex-state-units.md`.

### `assert_identity_state` call sites (`tests/test_adapter_protocol.sh:169-181`)

28-31. Four ownership-identity fixtures — no installed resources, the manager
   plugin and marketplace only, the legacy plugin and marketplace only, and
   both — each assert the manager and legacy resource booleans and the
   derived identity state in one bundled call
   (`tests/test_adapter_protocol.sh:169`, `tests/test_adapter_protocol.sh:173`,
   `tests/test_adapter_protocol.sh:177`, `tests/test_adapter_protocol.sh:181`).
   **Duplicate witness** of `ADAPTER-OWNERSHIP-01`, remapped to
   `tests/unit/adapter.test.js`'s `identity_state` derivation coverage. The
   helper's own body (lines 162 through 166) is not counted separately; see Divergences.

### Install verification hints, controlled failure, and malformed/noisy/crashed adapter responses (`tests/test_adapter_protocol.sh:187-220`)

32-34. A successful install with both verification hints reports the exact
   `mismatch` and `missing` strings (`tests/test_adapter_protocol.sh:187`,
   `tests/test_adapter_protocol.sh:188`, `tests/test_adapter_protocol.sh:189`). **Duplicate witness** of `ADAPTER-INSTALL-RESULT-01`,
   remapped to `tests/unit/adapter.test.js`.

35-42. A controlled install failure replays its pre-failure messages and
   stderr warning, then its error and both hints, and yields no result
   (`tests/test_adapter_protocol.sh:192`, `tests/test_adapter_protocol.sh:193`, `tests/test_adapter_protocol.sh:194`, `tests/test_adapter_protocol.sh:195`, `tests/test_adapter_protocol.sh:196`,
   `tests/test_adapter_protocol.sh:197`, `tests/test_adapter_protocol.sh:198`, `tests/test_adapter_protocol.sh:199`). **Duplicate witness** of
   `ADAPTER-CONTROLLED-FAILURE-01` and `DIAG-ADAPTER-01`'s stream/order
   contract, both remapped to `tests/unit/adapter.test.js`.

43-45. A response whose `operation` does not match the invocation fails
   without a result file (`tests/test_adapter_protocol.sh:202`, `tests/test_adapter_protocol.sh:203`,
   `tests/test_adapter_protocol.sh:204`). **Duplicate witness** of `ADAPTER-ENVELOPE-TYPES-01`'s
   operation-mismatch clause. **Retire**: pure envelope type-schema, dies
   with the transport.

46-48. A malformed adapter response fails without a result file
   (`tests/test_adapter_protocol.sh:207`, `tests/test_adapter_protocol.sh:208`, `tests/test_adapter_protocol.sh:209`). **Retire**:
   `ADAPTER-ENVELOPE-01`'s non-object/malformed-input clause, pure wire
   format.

49-51. Unvalidated noise on the adapter's stdout does not leak into a failed
   response's result (`tests/test_adapter_protocol.sh:212`, `tests/test_adapter_protocol.sh:213`, `tests/test_adapter_protocol.sh:214`).
   **Retire**: the validate-before-replay gate is `ADAPTER-REPLAY-01`, pure
   wire format.

52-55. A crashed adapter's stderr is surfaced verbatim alongside the
   controlled "invalid adapter response" failure
   (`tests/test_adapter_protocol.sh:217`, `tests/test_adapter_protocol.sh:218`, `tests/test_adapter_protocol.sh:219`, `tests/test_adapter_protocol.sh:220`). **Retire**:
   `ADAPTER-ENVELOPE-01`/`ADAPTER-REPLAY-01`, pure wire format.

### `CLI-ENV-REFRESH-MODE-01` / `CLI-ENV-CODEX-MUTATION-01` install refresh defaults and validation (`tests/test_adapter_protocol.sh:281-335`, `tests/test_adapter_protocol.sh:414-415`)

56-83. Against the real Codex-shaped fixture adapter: a default install
   succeeds and escapes the fixture's literal-backslash and non-UTF-8 Codex
   output onto stderr
   (`tests/test_adapter_protocol.sh:281`, `tests/test_adapter_protocol.sh:282`, `tests/test_adapter_protocol.sh:283`, `tests/test_adapter_protocol.sh:284`, `tests/test_adapter_protocol.sh:285`,
   `tests/test_adapter_protocol.sh:286`, `tests/test_adapter_protocol.sh:287`, `tests/test_adapter_protocol.sh:288`, `tests/test_adapter_protocol.sh:289`, `tests/test_adapter_protocol.sh:290`) without poisoning the
   result envelope (the `if grep -Fq 'error: invalid adapter response:' …;
   then echo …; exit 1; fi` negative guard at
   `tests/test_adapter_protocol.sh:291`), and performs no `plugin remove` —
   add-only refresh is the default, and the negative guard over the fake
   Codex stub's own command log at `tests/test_adapter_protocol.sh:295` is
   this driver's only witness of it; no ordinary-regex line in this block
   reads that log. An explicit
   `remove-add` refresh mode removes then re-adds the manager plugin
   (`tests/test_adapter_protocol.sh:310`, `tests/test_adapter_protocol.sh:311`, `tests/test_adapter_protocol.sh:312`, `tests/test_adapter_protocol.sh:313`). An unsupported refresh mode value fails
   before any Codex mutation with the exact `unsupported
   SUPERPOWERS_INSTALL_REFRESH_MODE: invalid` message (`tests/test_adapter_protocol.sh:324`, `tests/test_adapter_protocol.sh:325`,
   `tests/test_adapter_protocol.sh:326`). A Codex `plugin add` failure after the marketplace mutation
   already ran surfaces the escaped fixture output and the wrapped `error:
   codex plugin add failed for superpowers@superpowers-manager` message
   without a poisoned envelope (`tests/test_adapter_protocol.sh:330`, `tests/test_adapter_protocol.sh:331`, `tests/test_adapter_protocol.sh:332`, `tests/test_adapter_protocol.sh:333`, `tests/test_adapter_protocol.sh:334`,
   `tests/test_adapter_protocol.sh:335`, `tests/test_adapter_protocol.sh:414`), with no traceback from the non-UTF-8
   Codex output (the `if grep -Fq 'Traceback' …; then echo …; exit 1; fi`
   negative guard at `tests/test_adapter_protocol.sh:336`, this driver's only
   traceback assertion for the failure-after-mutation case) and no `invalid
   adapter response` poisoning of the controlled-failure envelope
   (`tests/test_adapter_protocol.sh:415`). **Port**:
   `tests/baseline/cli-parity.test.js`'s `CLI-ENV-REFRESH-MODE-01 install
   refuses a refresh mode outside add-only and remove-add, before any Codex
   mutation` and `CLI-ENV-CODEX-MUTATION-01 the install mutation uses the
   SUPERPOWERS_CODEX override` (the driver's own comment at lines 278-279
   names both IDs against this block directly).

### Terminal-control, non-ASCII, and surrogate operation-name rejection (`tests/test_adapter_protocol.sh:346-382`)

84-92. A raw C0 control byte, a non-ASCII operation name, and a lone UTF-8
   surrogate byte in an adapter operation argument are each rejected with the
   frozen "protocol strings must not contain terminal control characters"
   message before any output is emitted
   (`tests/test_adapter_protocol.sh:351`, `tests/test_adapter_protocol.sh:352`, `tests/test_adapter_protocol.sh:363`, `tests/test_adapter_protocol.sh:364`, `tests/test_adapter_protocol.sh:382`). Each
   rejection is asserted by an `if <adapter invocation>; then echo …; exit 1;
   fi` negative guard — succeeding is itself the failure — one per case
   (`tests/test_adapter_protocol.sh:346`, `tests/test_adapter_protocol.sh:358`,
   `tests/test_adapter_protocol.sh:373`), and the surrogate case's
   no-emitted-bytes assertion is a fourth such guard rather than the bracket
   test the other two cases use (`tests/test_adapter_protocol.sh:378`).
   **Duplicate witness** of
   `ADAPTER-TERMINAL-01` and `ADAPTER-SURROGATE-01`, both remapped to
   `tests/unit/adapter-protocol.test.js` and `tests/unit/lifecycle.test.js`.

### Zero-argument, empty-operation, and unknown-operation CLI boundary failures (`tests/test_adapter_protocol.sh:387-412`)

93-101. A zero-argument, an explicit-empty, and an unrecognized adapter-CLI
   operation each fail and identify the `adapter` (or the unrecognized
   operation name) as the failing boundary rather than falsely reporting a
   `build` that never ran (`tests/test_adapter_protocol.sh:391`, `tests/test_adapter_protocol.sh:392`,
   `tests/test_adapter_protocol.sh:402`, `tests/test_adapter_protocol.sh:403`, `tests/test_adapter_protocol.sh:411`, `tests/test_adapter_protocol.sh:412`). That each of the three
   invocations fails at all is asserted by its own `if <adapter invocation>;
   then echo …; exit 1; fi` negative guard
   (`tests/test_adapter_protocol.sh:387`, `tests/test_adapter_protocol.sh:397`,
   `tests/test_adapter_protocol.sh:406`); the bracket tests above only read
   the envelope the guard already required to exist. **Retire**:
   the POSIX CLI shim's own argument-boundary controlled failure. The
   in-process `adapter-cli` dispatches on a TypeScript-enumerated operation
   set rather than an untyped POSIX argv, so no equivalent unrecognized-string
   boundary exists to port; the surviving argument-parsing failure paths are
   covered by `tests/unit/adapter.test.js`'s split-dash-leading-ref cases.

### An invalid inspect view is a controlled inspect failure (`tests/test_adapter_protocol.sh:430-436`)

102-108. `--view nope` fails with `invalid-arguments` and the frozen
   "unsupported inspect view: nope" message, not an operation-mismatch
   failure (`tests/test_adapter_protocol.sh:430`, `tests/test_adapter_protocol.sh:431`, `tests/test_adapter_protocol.sh:432`, `tests/test_adapter_protocol.sh:433`,
   `tests/test_adapter_protocol.sh:434`, `tests/test_adapter_protocol.sh:435`). The
   "not an operation-mismatch failure" clause has exactly one witness, the
   `if grep -Fq 'response operation does not match invocation' …; then echo
   …; exit 1; fi` negative guard at `tests/test_adapter_protocol.sh:436`.
   **Duplicate witness** of
   `ADAPTER-ENVELOPE-TYPES-01`'s invocation-view-mismatch clause. **Retire**:
   pure envelope type-schema.

### `CLI-ENV-CODEX-LISTING-01` fingerprint listing uses override and default command (`tests/test_adapter_protocol.sh:445-474`)

109-111. The fixture Codex stub is invoked with exactly `plugin list --json`;
   an explicit `SUPERPOWERS_CODEX` override with a populated search root
   reports the active version's 40-hex commit; the same override with no
   installed plugin reports an empty fingerprint
   (`tests/test_adapter_protocol.sh:445`, `tests/test_adapter_protocol.sh:465`, `tests/test_adapter_protocol.sh:474`). **Port**:
   `tests/baseline/cli-parity.test.js`'s `CLI-ENV-CODEX-LISTING-01 the
   fingerprint listing uses the SUPERPOWERS_CODEX override, and resolves
   codex from PATH when it is unset` (the driver's own comment at line 458
   names the ID against this block directly).

### Default and edge-case `HOME`/`PATH` fingerprint resolution (`tests/test_adapter_protocol.sh:494-576`)

112-124. With no `SUPERPOWERS_CODEX` or search-root override, the fingerprint
   listing resolves `codex` from `PATH` and the installed fingerprint under
   `$HOME/.codex`, for a populated `HOME` (`tests/test_adapter_protocol.sh:494`), an explicitly empty
   `SUPERPOWERS_INSTALLED_SEARCH_ROOT` falling back to the same default
   (`tests/test_adapter_protocol.sh:510`), an explicitly empty `HOME` resolving under `/.codex` rather than
   the current directory with the shell-oracle root named in the failure
   message (`tests/test_adapter_protocol.sh:536`, `tests/test_adapter_protocol.sh:537`, `tests/test_adapter_protocol.sh:538`, `tests/test_adapter_protocol.sh:539`, `tests/test_adapter_protocol.sh:543`), and an unset `HOME`
   producing the same controlled failure rather than a cwd-relative lookup
   (`tests/test_adapter_protocol.sh:572`, `tests/test_adapter_protocol.sh:573`, `tests/test_adapter_protocol.sh:574`, `tests/test_adapter_protocol.sh:575`). Each of the two `HOME`
   edge cases asserts that its failure is the controlled one rather than an
   `invalid adapter response`, through an `if grep -Fq 'error: invalid
   adapter response:' …; then echo …; exit 1; fi` negative guard
   (`tests/test_adapter_protocol.sh:545`, `tests/test_adapter_protocol.sh:576`).
   **Port**: `tests/baseline/cli-parity.test.js`'s
   `CLI-ENV-INSTALLED-DEFAULTS-01` environment-default coverage (contract:
   "Without explicit overrides, Codex adapter fingerprint listing uses `codex`
   from `PATH` and installed fingerprint lookup uses `$HOME/.codex`," per
   `docs/baseline/protocol-disposition.md`). One line in this block carries a
   second ID: `tests/test_adapter_protocol.sh:543` requires the failure
   message to name
   `/.codex/plugins/cache/superpowers-manager/superpowers/$empty_home_version`
   — the exact cache path the active version selects below the resolved root,
   not merely the root — and is this driver's only witness of
   `CLI-ENV-INSTALLED-ROOT-01` (contract: "the active version selects the
   exact plugin cache path below this root,"
   `docs/baseline/protocol-disposition.md`). **Port**: the same file's
   `CLI-ENV-INSTALLED-ROOT-01 the active version selects its exact plugin
   cache path below SUPERPOWERS_INSTALLED_SEARCH_ROOT`. Neither ID carries a
   `# BASELINE CASE:` comment in the driver, so both attributions rest on
   contract-content matching against `docs/baseline/protocol-disposition.md`
   rather than on a driver-side marker.

### `PATH`-component resolution and launch-failure envelope retention (`tests/test_adapter_protocol.sh:598-639`)

125-132. An explicitly present empty `PATH` component resolves a bare Codex
   command from the current directory (`tests/test_adapter_protocol.sh:598`); an absent `PATH` does not
   synthesize a current-directory search component and instead fails
   `command-not-found` (`tests/test_adapter_protocol.sh:622`, `tests/test_adapter_protocol.sh:623`, with the
   `if "$real_node" … adapter-cli.js inspect …; then echo …; exit 1; fi`
   negative guard at `tests/test_adapter_protocol.sh:616` asserting the
   invocation fails at all); and a launch failure
   after the executable precheck retains the `inspect` envelope
   (`tests/test_adapter_protocol.sh:636`, `tests/test_adapter_protocol.sh:637`, `tests/test_adapter_protocol.sh:638`) with an empty stderr rather
   than leaking a Node `ErrnoException` — the `if [ -s "$busy_launch_err" ];
   then echo …; exit 1; fi` negative guard at
   `tests/test_adapter_protocol.sh:639` being the only witness of that empty-stderr
   clause. **Port** (the two `PATH`-resolution cases,
   `tests/test_adapter_protocol.sh:598`, `tests/test_adapter_protocol.sh:616`,
   `tests/test_adapter_protocol.sh:622`, `tests/test_adapter_protocol.sh:623`):
   `tests/baseline/cli-parity.test.js`'s `CLI-ENV-CODEX-LISTING-01 the
   fingerprint listing uses the SUPERPOWERS_CODEX override, and resolves codex
   from PATH when it is unset` — Codex executable resolution for the
   fingerprint listing, the same ID items 109-111 port. The port test carries
   four halves, and the two `PATH`-component edges these shell lines cover are
   the last two of them. Its first two — an absolute-path `SUPERPOWERS_CODEX`
   override (`tests/baseline/cli-parity.test.js:2624-2639`) and `codex`
   resolving from `PATH` when the override is unset
   (`tests/baseline/cli-parity.test.js:2644-2654`) — exercise neither edge.
   The third asserts that an explicitly empty `PATH` component resolves a bare
   command planted only in the working directory, through a recording `codex`
   that exists nowhere on `PATH` whose listing log is the proof of resolution
   (`tests/baseline/cli-parity.test.js:2681-2714`). The fourth asserts that an
   absent `PATH` declines to synthesize one, failing `command-not-found` with
   the working-directory copy never run
   (`tests/baseline/cli-parity.test.js:2746-2782`); its override names `true`
   for the reason the driver's did, that a launch `ENOENT` maps to the same
   `command-not-found` code the precheck raises, so only a name resolvable
   from execvp's default path separates a precheck that failed closed from one
   that wrongly passed. Both halves drive `runAdapter` rather than the CLI,
   and that is forced: `src/cli.ts`'s preflight resolves the same command name
   with its own `findTool`, which drops empty components (`src/cli.ts:207`)
   and rejects an absent `PATH`, so a CLI-level run fails at preflight before
   `src/adapter.ts:263-264` is reached. `runAdapter` is the function the CLI
   dispatches into (`src/commands/probe.ts:231`), so the two edges are pinned
   at the layer where the rule lives. What that does **not** establish is that
   any invoked product path exercises them: on the only invoked path the
   preflight makes both branch outcomes unobservable, and `dist/adapter-cli.js`
   — which does call `runAdapter` with a bare `process.env` and no preflight —
   has, per `src/adapter-protocol.ts:211-215`, a sole caller "no product path
   invokes". These are **defense-in-depth witnesses** of a fail-closed
   invariant in production code, and a later reader auditing whether
   `src/adapter.ts:263-264` is dead code should read them as exactly that.
   (An earlier revision of this record said
   these two edges "retire with the driver" and that the port carried the ID
   without them. That was true of the port test as it stood at
   `16aad89795876eb94d22e2350ba71cdf86613859`; merge review found the gap, and
   the two halves cited above close it.)
   **Retire** (the launch-failure case,
   `tests/test_adapter_protocol.sh:636`-`tests/test_adapter_protocol.sh:639`):
   no row of `docs/baseline/protocol-disposition.md` claims adapter-cli's
   launch-failure envelope retention, and the empty-stderr clause at
   `tests/test_adapter_protocol.sh:639` was not dropped but **deliberately
   reversed**. PR 11.4 changed the synthesized launch failure from an empty
   stderr buffer to `cannot launch Codex command <bin>: <errno>`, because an
   empty buffer made `ENOEXEC`/`EMFILE`/`ENOMEM` indistinguishable from Codex
   exiting non-zero; `tests/unit/adapter.test.js:487-498` records that
   rationale and `tests/unit/adapter.test.js:499-526` is the surviving
   witness, asserting
   `mapCodexLaunchFailure`'s stderr text directly. So this driver's assertion
   is superseded rather than ported: an in-process test asserting an empty
   stderr here would now fail. The remaining half — that the mapped text
   reaches the `inspect` envelope end-to-end — has **no** witness at all;
   `tests/unit/adapter.test.js:496-498` says so in as many words ("is not
   covered end-to-end by any test"), because the errno path cannot be provoked
   hermetically. Recorded here as an open gap rather than as coverage. (An
   earlier revision of this record cited
   `tests/unit/adapter.test.js:431,453` as the in-process witness; those two
   lines assert `inspect-failed` on a *listing-parse* failure — `cannot parse
   output of '<codex> plugin list --json'` — and neither spawns a broken
   executable, so neither witnesses a launch failure.) An earlier
   revision of this record filed this whole block under
   `CLI-ENV-INSTALLED-ROOT-01`; that was wrong — nothing here asserts a plugin
   cache path, and that ID's sole witness is shell-original line 543, in the
   block above.

### An invalid fingerprint listing fails closed (`tests/test_adapter_protocol.sh:656-657`)

133-134. A syntactically invalid plugin listing and a listing naming a
   version with no matching cache directory each fail with no result file
   (`tests/test_adapter_protocol.sh:656`, `tests/test_adapter_protocol.sh:657`).
   **Duplicate witness** of `ADAPTER-FINGERPRINT-REJECT-01`-adjacent
   fail-closed handling of a malformed Codex plugin listing, already covered
   by `tests/unit/adapter.test.js`'s invalid-UTF-8/malformed-listing cases.

### A missing Codex command fails install, fingerprint, ownership, and uninstall inspection (`tests/test_adapter_protocol.sh:670-726`)

135-153. A `SUPERPOWERS_CODEX` naming a nonexistent command fails install
   (`tests/test_adapter_protocol.sh:670`, `tests/test_adapter_protocol.sh:671`, `tests/test_adapter_protocol.sh:672`, `tests/test_adapter_protocol.sh:673`, `tests/test_adapter_protocol.sh:674`, `tests/test_adapter_protocol.sh:675`), fingerprint
   inspection (`tests/test_adapter_protocol.sh:691`, `tests/test_adapter_protocol.sh:692`, `tests/test_adapter_protocol.sh:693`, `tests/test_adapter_protocol.sh:694`, `tests/test_adapter_protocol.sh:695`), and both ownership and
   uninstall inspection (`tests/test_adapter_protocol.sh:720`, `tests/test_adapter_protocol.sh:721`, `tests/test_adapter_protocol.sh:722`, `tests/test_adapter_protocol.sh:723`, `tests/test_adapter_protocol.sh:724`, `tests/test_adapter_protocol.sh:725`), in every case with `error.code` `command-not-found` and the exact
   stderr line `error: required Codex command not found: <path>`. The
   "never a poisoned invalid adapter response" half is asserted only by the
   `if grep -Fq 'error: invalid adapter response:' …; then echo …; exit 1;
   fi` negative guards — one on the install case
   (`tests/test_adapter_protocol.sh:676`) and one inside the
   ownership/uninstall loop (`tests/test_adapter_protocol.sh:726`).
   **Retired at the gap**: this exact
   message and `command-not-found` code are already covered by
   `tests/unit/adapter.test.js:542`, `tests/bin/uninstall-commands.test.js:465,488`
   (`uninstall-commands.md`), and `tests/baseline/probe.test.js:553`
   (`probe.md`) — all pre-existing, none newly ported by this inventory.

### `PROV-READER-CODEX-SOURCE-01` Codex build source reader profile (`tests/test_adapter_protocol.sh:803-862`)

154-173. Against `run_source_build`: non-standard JSON constants in the
   provenance file are rejected with "provenance must contain valid JSON"
   (`tests/test_adapter_protocol.sh:803`, `tests/test_adapter_protocol.sh:804`) and not with the reader's
   generic "candidate provenance is missing or invalid" message — a bare
   `! grep -Fq …` predicate under `set -eu`
   (`tests/test_adapter_protocol.sh:805`), counted as one assertion under the
   bare-predicate rule this record inherits; a 2000-deep nested top-level array — which
   has no `source` key — parses successfully under the accepting profile's
   unset `maxDepth` and is rejected afterward by `asObject`'s schema check,
   not by a depth limit (`tests/test_adapter_protocol.sh:817`, `tests/test_adapter_protocol.sh:818`); a candidate manifest that is a file
   rather than a directory fails the copy step with the exact "cannot copy
   upstream manifest into candidate" message and is not reported as a
   poisoned adapter response (`tests/test_adapter_protocol.sh:823`, `tests/test_adapter_protocol.sh:824`, `tests/test_adapter_protocol.sh:825`, `tests/test_adapter_protocol.sh:826`, `tests/test_adapter_protocol.sh:827`, `tests/test_adapter_protocol.sh:828`,
   `tests/test_adapter_protocol.sh:830`, with the `if grep -Fq 'error:
   invalid adapter response:' …; then echo …; exit 1; fi` negative guard at
   `tests/test_adapter_protocol.sh:831` carrying the
   not-a-poisoned-response half); an otherwise-valid duplicate-key provenance
   document is accepted (`tests/test_adapter_protocol.sh:837`, `tests/test_adapter_protocol.sh:838`); a provenance file padded past
   1,048,576 bytes is still accepted, with no byte cap (`tests/test_adapter_protocol.sh:853`, `tests/test_adapter_protocol.sh:854`); and a
   provenance document missing required keys fails with "provenance keys do
   not match" (`tests/test_adapter_protocol.sh:860`, `tests/test_adapter_protocol.sh:861`) and not with the generic
   "candidate provenance is missing or invalid" message — a second bare
   `! grep -Fq …` predicate under `set -eu`
   (`tests/test_adapter_protocol.sh:862`).
   **Port**: `tests/unit/provenance.test.js`'s `PROV-READER-CODEX-SOURCE-01
   Codex build source reader preserves its accepting profile` (`tests/unit/provenance.test.js:36`).
   `tests/test_adapter_protocol.sh:817-818` maps to that test's schema-rejection assertion at
   `tests/unit/provenance.test.js:49-52` (the `for` loop over `"{", "[]",
   "{}", '{"source":7}', '{"source":""}'`), not to its separate nesting
   assertions (`tests/unit/provenance.test.js:79-86`) — the shell case never exercised depth rejection,
   despite its proximity to a 2000-deep payload, so mapping it to the nesting
   assertion would record a port of a property the driver never tested.
   `tests/test_adapter_protocol.sh:853-854` maps to the same test's explicit port of this exact citation at
   `tests/unit/provenance.test.js:53-56` (the 1 MiB + 1 payload), added by
   PR-3.2 before this deletion specifically so the Bytes cell of this matrix
   row kept a witness.

### `test_build_and_uninstall_accept_exact_empty_results` (`tests/test_adapter_protocol.py:233`)

174. Successful `build` and `uninstall` responses accept only their exact
   empty result objects (`tests/test_adapter_protocol.py:233`). **Retire**:
   `ADAPTER-PROTOCOL-01`, pure protocol-1 response schema, dies with the
   transport.

### `test_inspect_fingerprint_accepts_full_sha_short_sha_and_null` (`tests/test_adapter_protocol.py:236`, `tests/test_adapter_protocol.py:254`)

175-176. Fingerprint inspection accepts a 40-hex fixture value and, via a
   synthetic envelope, a 7-hex and a `null` fingerprint
   (`tests/test_adapter_protocol.py:236`, `tests/test_adapter_protocol.py:254`).
   **Duplicate witness** of `ADAPTER-FINGERPRINT-01`, remapped to
   `tests/unit/adapter.test.js`.

### `test_inspect_update_control_accepts_only_exact_allowed_values` (`tests/test_adapter_protocol.py:265`, `tests/test_adapter_protocol.py:273`, `tests/test_adapter_protocol.py:284`)

177-179. The validator accepts an update-control envelope reporting
   `managed` from a fixture and `unsupported` from a synthetic envelope, and
   rejects a missing key, an unknown value, and an extra key
   (`tests/test_adapter_protocol.py:265`, `tests/test_adapter_protocol.py:273`,
   `tests/test_adapter_protocol.py:284`). **Split disposition** per
   `ADAPTER-UPDATE-CONTROL-01`'s own rationale: `tests/test_adapter_protocol.py:265` and `tests/test_adapter_protocol.py:273` are the
   validator's envelope-acceptance schema for a value the in-process adapter
   can no longer produce (`runInspect` always returns the literal `managed`)
   — **retire**, pure wire format. `tests/test_adapter_protocol.py:284`'s third-value rejection is the
   surviving recognition rule, remapped to `requireManagedUpdateControl`
   (`src/lifecycle.ts`) — **duplicate witness**, already claimed by
   `codex-state-units.md`.

### `test_inspect_ownership_accepts_all_consistent_identity_states` (`tests/test_adapter_protocol.py:292`, `tests/test_adapter_protocol.py:322`)

180-181. Ownership inspection accepts a fixture `manager` state and, via a
   loop over synthetic envelopes, `neither`/`legacy`/`both`
   (`tests/test_adapter_protocol.py:292`, `tests/test_adapter_protocol.py:322`).
   **Duplicate witness** of `ADAPTER-OWNERSHIP-01`, remapped to
   `tests/unit/adapter.test.js`.

### `test_inspect_ownership_rejects_old_malformed_and_inconsistent_results` (`tests/test_adapter_protocol.py:364`)

182. Six malformed or internally-inconsistent ownership result shapes are
   each rejected with a distinct fragment (`tests/test_adapter_protocol.py:364`).
   **Retire**: `ADAPTER-OWNERSHIP-REJECT-01` — the old/malformed clauses are
   wire residue, and the internally-inconsistent clause cannot be produced
   in-process because `identity_state` is derived from the same booleans it
   reports.

### `test_install_accepts_empty_one_and_both_verification_hints` (`tests/test_adapter_protocol.py:372`, `tests/test_adapter_protocol.py:386`)

183-184. Install accepts a fixture single-hint result and, via a loop, an
   empty and a both-hints result
   (`tests/test_adapter_protocol.py:372`, `tests/test_adapter_protocol.py:386`).
   **Duplicate witness** of `ADAPTER-INSTALL-RESULT-01`, remapped to
   `tests/unit/adapter.test.js`.

### `test_messages_replay_by_channel_in_order` (`tests/test_adapter_protocol.py:400`)

185. Four interleaved stdout/stderr messages replay to their declared
   streams in array order (`tests/test_adapter_protocol.py:400`).
   **Duplicate witness** of `DIAG-ADAPTER-01`, remapped to
   `tests/unit/adapter.test.js`'s two message-replay-order tests.

### `test_enforces_inclusive_response_size_boundary_before_replay` (`tests/test_adapter_protocol.py:409`, `tests/test_adapter_protocol.py:416`)

186-187. A response of exactly 1,048,576 bytes is accepted and replays its
   sentinels; one byte larger is rejected before any replay, with sentinels
   absent from both streams (`tests/test_adapter_protocol.py:409`,
   `tests/test_adapter_protocol.py:416`). **Retire**: `ADAPTER-READER-BYTES-01`,
   the response-file byte cap lives only in the deleted validator.

### `test_response_size_limit_counts_utf8_bytes_before_replay` (`tests/test_adapter_protocol.py:437`, `tests/test_adapter_protocol.py:442`, `tests/test_adapter_protocol.py:443`, `tests/test_adapter_protocol.py:448`, `tests/test_adapter_protocol.py:455`)

188-192. A response under the byte limit in UTF-8 code units but over it in
   Unicode code points is rejected with the exact byte-limit message, with
   sentinels absent from both streams (`tests/test_adapter_protocol.py:437`,
   `tests/test_adapter_protocol.py:442`, `tests/test_adapter_protocol.py:443`, `tests/test_adapter_protocol.py:448`, `tests/test_adapter_protocol.py:455`). **Retire**: `ADAPTER-READER-UTF8-01`, a
   refinement of the same deleted byte cap.

### `test_controlled_failure_replays_messages_error_and_hints` (`tests/test_adapter_protocol.py:461`, `tests/test_adapter_protocol.py:462`, `tests/test_adapter_protocol.py:463`, `tests/test_adapter_protocol.py:470`, `tests/test_adapter_protocol.py:471`)

193-197. A controlled install failure replays its pre-failure stdout
   message, then its warning, error, and both hints on stderr in order,
   yields no result, and leaks no traceback
   (`tests/test_adapter_protocol.py:461`, `tests/test_adapter_protocol.py:462`, `tests/test_adapter_protocol.py:463`, `tests/test_adapter_protocol.py:470`, `tests/test_adapter_protocol.py:471`).
   **Duplicate witness** of `ADAPTER-CONTROLLED-FAILURE-01`, remapped to
   `tests/unit/adapter.test.js`.

### `test_rejects_terminal_controls_in_terminal_facing_protocol_strings` (`tests/test_adapter_protocol.py:536`)

198. Five terminal-facing string populations — a message, an error code, an
   error message, an error hint, and an install verification hint —
   individually carrying a C0/C1/DEL control character are each rejected
   with a fragment naming the offending field
   (`tests/test_adapter_protocol.py:536`). **Duplicate witness** of
   `ADAPTER-TERMINAL-01`, remapped to `tests/unit/adapter-protocol.test.js`
   and `tests/unit/lifecycle.test.js`.

### `test_rejects_surrogate_escapes_in_terminal_facing_protocol_strings` (`tests/test_adapter_protocol.py:603`, `tests/test_adapter_protocol.py:604`, `tests/test_adapter_protocol.py:605`, `tests/test_adapter_protocol.py:606`)

199-202. The same five populations, each carrying a lone UTF-8 surrogate
   escape, are rejected with no leaked surrogate byte on either stream
   (`tests/test_adapter_protocol.py:603`, `tests/test_adapter_protocol.py:604`, `tests/test_adapter_protocol.py:605`, `tests/test_adapter_protocol.py:606`).
   **Duplicate witness** of `ADAPTER-SURROGATE-01`, remapped to
   `tests/unit/adapter-protocol.test.js` and `tests/unit/lifecycle.test.js`.

### `test_rejects_empty_malformed_non_object_and_extra_fields` (`tests/test_adapter_protocol.py:616`, `tests/test_adapter_protocol.py:617`, `tests/test_adapter_protocol.py:618`, `tests/test_adapter_protocol.py:620`, `tests/test_adapter_protocol.py:624`)

203-207. Empty input, unterminated JSON, a non-object top level, and an
   extra top-level key are each rejected with no leaked traceback
   (`tests/test_adapter_protocol.py:616`, `tests/test_adapter_protocol.py:617`, `tests/test_adapter_protocol.py:618`, `tests/test_adapter_protocol.py:620`, `tests/test_adapter_protocol.py:624`).
   **Retire**: `ADAPTER-ENVELOPE-01`, pure wire format, dies with the
   deleted validator.

### `test_rejects_deeply_nested_raw_json_without_traceback` (`tests/test_adapter_protocol.py:632`, `tests/test_adapter_protocol.py:633`, `tests/test_adapter_protocol.py:634`, `tests/test_adapter_protocol.py:635`, `tests/test_adapter_protocol.py:636`)

208-212. A raw JSON array nested 2000 deep is rejected with the generic
   "invalid adapter response" message and no leaked traceback, and yields no
   validated result (`tests/test_adapter_protocol.py:632`, `tests/test_adapter_protocol.py:633`, `tests/test_adapter_protocol.py:634`,
   `tests/test_adapter_protocol.py:635`, `tests/test_adapter_protocol.py:636`). **Retire**: crash-safety of the deleted validator's own
   raw-JSON parser under pathological input — a property of that
   implementation, not a distinct behavior ID in
   `docs/baseline/protocol-disposition.md`; dies with the validator.

### `test_rejects_non_standard_json_constants_without_replay` (`tests/test_adapter_protocol.py:639`, `tests/test_adapter_protocol.py:657`, `tests/test_adapter_protocol.py:664`)

213-215. A fixture `NaN` and synthetic `Infinity`/`-Infinity` protocol
   values are each rejected before replay, with sentinels absent from both
   streams (`tests/test_adapter_protocol.py:639`, `tests/test_adapter_protocol.py:657`, `tests/test_adapter_protocol.py:664`).
   **Retire**: `ADAPTER-READER-CONSTANTS-01`, scoped to the deleted
   validator's own constant rejection.

### `test_rejects_duplicate_object_keys_recursively_without_replay` (`tests/test_adapter_protocol.py:695`, `tests/test_adapter_protocol.py:702`, `tests/test_adapter_protocol.py:709`, `tests/test_adapter_protocol.py:710`, `tests/test_adapter_protocol.py:711`, `tests/test_adapter_protocol.py:712`)

216-221. A fixture top-level duplicate key and a synthetic nested duplicate
   key are each rejected with the exact "duplicate object key" message and
   sentinels absent from both streams; a control envelope with no duplicate
   keys is accepted with an empty result
   (`tests/test_adapter_protocol.py:695`, `tests/test_adapter_protocol.py:702`, `tests/test_adapter_protocol.py:709`, `tests/test_adapter_protocol.py:710`, `tests/test_adapter_protocol.py:711`,
   `tests/test_adapter_protocol.py:712`). **Retire**: `ADAPTER-READER-DUPLICATES-01`, scoped to the
   deleted validator's own duplicate-key rejection.

### `test_enforces_exact_json_nesting_boundary` (`tests/test_adapter_protocol.py:716`, `tests/test_adapter_protocol.py:717`, `tests/test_adapter_protocol.py:718`, `tests/test_adapter_protocol.py:720`)

222-225. A document nested exactly 64 deep is rejected on its own object
   schema, never on nesting; one deeper (65) is rejected with the exact
   "response JSON nesting exceeds limit" message
   (`tests/test_adapter_protocol.py:716`, `tests/test_adapter_protocol.py:717`, `tests/test_adapter_protocol.py:718`, `tests/test_adapter_protocol.py:720`).
   **Retire**: `ADAPTER-READER-DEPTH-01`, `MAX_NESTING = 64` exists only in
   the deleted validator.

### `test_rejects_wrong_protocol_operation_types_and_views` (`tests/test_adapter_protocol.py:799`, `tests/test_adapter_protocol.py:807`)

226-227. Twelve type/shape mismatches are each rejected with a fragment
   naming the mismatch. Eleven are driven by the `invalid_cases` tuple's loop
   (`tests/test_adapter_protocol.py:799`): a Boolean `protocol`, a float
   `protocol`, a `protocol` of `2`, an `operation` mismatch, a non-Boolean
   `ok`, a non-array `messages`, an invalid message channel, an empty message
   text, a non-null error on a successful response, an inspect result-key
   mismatch, and an inspect result-view mismatch. The twelfth is a standalone
   call outside that loop (`tests/test_adapter_protocol.py:807`): an inspect
   invocation with no view at all, rejected with `inspect view must be
   fingerprint or ownership`. **Retire**:
   `ADAPTER-ENVELOPE-TYPES-01`, pure envelope type-schema.

### `test_rejects_invalid_fingerprint_and_result_schema_keys` (`tests/test_adapter_protocol.py:871`)

228. Seven result-schema violations — an out-of-range fingerprint, an
   incomplete ownership `resources` key set, a non-Boolean ownership value,
   an unknown install verification-hint key, an empty verification-hint
   string, and an unexpected key in an otherwise-empty build/uninstall result
   — are each rejected with a fragment naming the violation
   (`tests/test_adapter_protocol.py:871`). **Split disposition**: the
   fingerprint case is a **duplicate witness** of
   `ADAPTER-FINGERPRINT-REJECT-01` (remapped to `tests/unit/adapter.test.js`);
   the ownership-schema cases duplicate `ADAPTER-OWNERSHIP-REJECT-01`'s
   wire-residue clause; the verification-hint cases are
   `ADAPTER-INSTALL-REJECT-01`, retired — no in-process construct rejects an
   unknown hint key or an empty hint string, since hints are plain string
   literals in `runInstall`'s returned object; the build/uninstall
   extra-key cases are `ADAPTER-PROTOCOL-01`'s reject side, retired with the
   deleted response schema.

### `test_rejects_exit_envelope_mismatches_and_null_cross_rules` (`tests/test_adapter_protocol.py:927`)

229. Five exit-status/envelope cross-rules — a successful response with a
   nonzero adapter exit, a failure response with a zero adapter exit, a
   non-null error on a successful response, a non-null result on a failure
   response, and a null error on a failure response — are each rejected with
   a fragment naming the violated rule
   (`tests/test_adapter_protocol.py:927`). **Retire**: `ADAPTER-STATUS-01`,
   every term names a protocol-v1 envelope key or the adapter exit status
   that accompanies it.

<!-- inventory:mapped:end -->

## Divergences

The derived baseline is 156 (mechanical shell census) + 56 (Python after the
helper-definition rule) = **212**. Two divergences apply, in opposite
directions:

1. **−5** (`tests/test_adapter_protocol.sh:162-166`). `assert_identity_state`'s
   own body, five bracket tests the mechanical regex matches, credited to the
   four call sites items 28-31 already count. Declared `unmapped` below.
2. **+22** (`tests/test_adapter_protocol.sh:39`, `:291`, `:295`, `:336`,
   `:346`, `:358`, `:373`, `:378`, `:387`, `:397`, `:406`, `:415`, `:436`,
   `:545`, `:576`, `:616`, `:639`, `:676`, `:726`, `:805`, `:831`, `:862`).
   Twenty of these are `if <command>; then echo …; exit 1; fi` negative
   guards, where the command succeeding is itself the test failure; the other
   two (`:805`, `:862`) are bare `! grep -Fq …` predicates under `set -eu`.
   All 22 assert a property of the product rather than the harness, so each is
   one assertion and one item, mapped by the section covering its block above.
   Several are the *only* witness of a clause this record names, four of them
   established line by line — `:295` (the
   add-only-refresh default, read off the fake Codex stub's command log, which
   no ordinary-regex line in that block touches), `:336` (no traceback from
   non-UTF-8 Codex output), `:436` (the invalid inspect view is not an
   operation-mismatch failure), and `:639` (a launch failure leaves stderr
   empty) — so declaring them `unswept` would have dropped a mapped clause
   with a written excuse attached. That is what an earlier revision of this
   record did, for all 22.

In the machine-readable block the −5 appears as five `unmapped` entries and
the +22 as twenty-two `added` entries: a recovered guard is, by that block's
definition, a line an item cites and the census never counted. No line is
claimed by two distinct items. 212 − 5 + 22 = **229**, which
is `shellOriginal`. Seven sweep lines remain `unswept`: five are the fake
`codex` stub's own argument dispatch and two are the system-Python
compatibility probe in setup — harness control flow, the disposition
`probe.md` gave its `:631` and `selection-commands.md` its `:271`. The 21
excluded Python helper-body lines (see Counting rules) are not declared here —
they are subtracted before the `unmapped` set is computed, so nothing about
them needs judgment.

```json divergences
{
  "added": {
    "tests/test_adapter_protocol.sh:39": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 3-7 maps it as the sole witness that a rejected envelope replays no message",
    "tests/test_adapter_protocol.sh:291": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 56-83 maps it as the sole witness that escaped Codex output does not poison a successful install envelope",
    "tests/test_adapter_protocol.sh:295": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 56-83 maps it as the sole witness of the add-only refresh default, read off the fake Codex stub's command log",
    "tests/test_adapter_protocol.sh:336": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 56-83 maps it as the sole witness that non-UTF-8 Codex output produces no traceback on the failure-after-mutation path",
    "tests/test_adapter_protocol.sh:346": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 84-92 maps it as the assertion that a C0 control byte in an operation argument makes the invocation fail",
    "tests/test_adapter_protocol.sh:358": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 84-92 maps it as the assertion that a non-ASCII operation name makes the invocation fail",
    "tests/test_adapter_protocol.sh:373": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 84-92 maps it as the assertion that a lone surrogate byte in an operation name makes the invocation fail",
    "tests/test_adapter_protocol.sh:378": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 84-92 maps it as the sole witness that the surrogate case emits no bytes on stdout",
    "tests/test_adapter_protocol.sh:387": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 93-101 maps it as the assertion that a zero-argument adapter invocation fails",
    "tests/test_adapter_protocol.sh:397": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 93-101 maps it as the assertion that an explicitly empty operation fails",
    "tests/test_adapter_protocol.sh:406": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 93-101 maps it as the assertion that an unknown operation fails",
    "tests/test_adapter_protocol.sh:415": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 56-83 maps it as the sole witness that escaped Codex output does not poison a controlled-failure envelope",
    "tests/test_adapter_protocol.sh:436": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 102-108 maps it as the sole witness that an invalid inspect view is not an operation-mismatch failure",
    "tests/test_adapter_protocol.sh:545": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 112-124 maps it as the sole witness that an empty HOME produces a controlled fingerprint failure rather than an invalid adapter response",
    "tests/test_adapter_protocol.sh:576": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 112-124 maps it as the sole witness that an unset HOME produces a controlled fingerprint failure rather than an invalid adapter response",
    "tests/test_adapter_protocol.sh:616": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 125-132 maps it as the assertion that an absent PATH makes the fingerprint inspection fail rather than search the current directory",
    "tests/test_adapter_protocol.sh:639": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 125-132 maps it as the sole witness that a Codex launch failure leaves adapter-cli's stderr empty",
    "tests/test_adapter_protocol.sh:676": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 135-153 maps it as the sole witness that a missing Codex command is a controlled install failure rather than an invalid adapter response",
    "tests/test_adapter_protocol.sh:726": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 135-153 maps it as the sole witness that a missing Codex command is a controlled ownership/uninstall failure rather than an invalid adapter response",
    "tests/test_adapter_protocol.sh:805": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 154-173 maps this bare ! grep predicate under set -eu as the sole witness that a non-standard JSON constant is not reported as a generic missing-or-invalid provenance",
    "tests/test_adapter_protocol.sh:831": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 154-173 maps it as the sole witness that a non-directory candidate manifest is not reported as an invalid adapter response",
    "tests/test_adapter_protocol.sh:862": "+22 recovery: the supplementary sweep found this negative guard, which the census regex structurally cannot see; item 154-173 maps this bare ! grep predicate under set -eu as the sole witness that a provenance key mismatch is not reported as a generic missing-or-invalid provenance"
  },
  "duplicate": {},
  "unmapped": {
    "tests/test_adapter_protocol.sh:162": "assert_identity_state's own body, credited to its four call sites (items 28-31) under bin-dispatch.md's rule",
    "tests/test_adapter_protocol.sh:163": "assert_identity_state's own body, credited to its four call sites (items 28-31) under bin-dispatch.md's rule",
    "tests/test_adapter_protocol.sh:164": "assert_identity_state's own body, credited to its four call sites (items 28-31) under bin-dispatch.md's rule",
    "tests/test_adapter_protocol.sh:165": "assert_identity_state's own body, credited to its four call sites (items 28-31) under bin-dispatch.md's rule",
    "tests/test_adapter_protocol.sh:166": "assert_identity_state's own body, credited to its four call sites (items 28-31) under bin-dispatch.md's rule"
  },
  "unswept": {
    "tests/test_adapter_protocol.sh:45": "the system-Python compatibility probe in setup, gating an optional --help smoke check on /usr/bin/python3 being executable -- harness control flow, not a check about the product",
    "tests/test_adapter_protocol.sh:49": "the same probe's 3.9-only branch, gating that optional smoke check on the interpreter version -- harness control flow, not a check about the product",
    "tests/test_adapter_protocol.sh:234": "the fake codex stub's own argument dispatch (plugin marketplace list), not a check about the product -- the treatment probe.md gave its :631",
    "tests/test_adapter_protocol.sh:238": "the fake codex stub's own argument dispatch (plugin marketplace add), not a check about the product -- the treatment probe.md gave its :631",
    "tests/test_adapter_protocol.sh:244": "the fake codex stub's own argument dispatch (plugin remove), not a check about the product -- the treatment probe.md gave its :631",
    "tests/test_adapter_protocol.sh:247": "the fake codex stub's own argument dispatch (plugin add), not a check about the product -- the treatment probe.md gave its :631",
    "tests/test_adapter_protocol.sh:251": "the fake codex stub's own scenario branch, choosing whether its plugin add exits 1, not a check about the product -- the treatment probe.md gave its :631"
  }
}
```

## Cardinality

**POINTER PROVENANCE — shell-original pointers.** The deleting commit
(`16aad89795876eb94d22e2350ba71cdf86613859`) cannot name its own SHA: it
cannot also be the commit in which either retired path is readable. The
anchor for every shell- and Python-original citation in this inventory is the
last commit in which both drivers existed:
`41c99390f51a0cbeb552ab0a0bff26fc1c5c07df`. `git cat-file -e` confirmed both
`tests/test_adapter_protocol.sh` and `tests/test_adapter_protocol.py` resolve
there and are absent at the deleting commit; line counts at that anchor
matched the declared 864 and 937 exactly. The citations are therefore
intentionally no longer resolvable at `HEAD`; use `git show
41c99390f51a0cbeb552ab0a0bff26fc1c5c07df:tests/test_adapter_protocol.sh` (or
`:tests/test_adapter_protocol.py`) to inspect either original.

```json inventory
{
  "shellOriginal": 229,
  "portOnly": 0,
  "ports": {
    "tests/baseline/cli-parity.test.js": 38,
    "tests/unit/provenance.test.js": 5
  }
}
```

- Shell original: **229** assertions (212 derived from the mechanical
  156-line shell census plus the Python driver's 56 items after its
  helper-definition rule, less the 5 shell lines this record declares
  `unmapped`, plus the 22 negative guards the supplementary sweep recovers:
  212 − 5 + 22 = 229; see Counting rules and Divergences above for the full
  derivation).
- Ports: `tests/baseline/cli-parity.test.js` carries the surviving witness for
  five shell-owned behavior IDs with no prior in-process port
  (`CLI-ENV-REFRESH-MODE-01`, `CLI-ENV-CODEX-MUTATION-01`,
  `CLI-ENV-CODEX-LISTING-01`, `CLI-ENV-INSTALLED-DEFAULTS-01`,
  `CLI-ENV-INSTALLED-ROOT-01`); `tests/unit/provenance.test.js` carries the
  surviving witness for `PROV-READER-CODEX-SOURCE-01` — a row PR-1 already
  witnessed, so not a first-time port — including the two
  citations (`tests/test_adapter_protocol.sh:853-854`) PR-3.2 ported ahead of
  this deletion specifically to keep the Bytes cell of that matrix row
  witnessed. `CLI-ENV-CODEX-LISTING-01`'s port test also carries items
  125-132's two `PATH`-component edges, which an earlier revision of this
  record recorded as retiring with the driver until merge review found the
  gap. Every other item is `Retire`, `Retired at the gap`, or a `Duplicate
  witness` of a behavior ID `docs/baseline/protocol-disposition.md` already
  disposed of, per this file's own disposition vocabulary (see Counting
  rules). One retired clause leaves an acknowledged gap rather than a
  successor: items 125-132's launch-failure envelope property, unwitnessed
  end-to-end by design (`tests/unit/adapter.test.js:496-498`).
