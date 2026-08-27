# Behavioral Baseline Traceability

Every behavior ID in
[`behavioral-inventory.md`](behavioral-inventory.md) has exactly one row here.
`PATH::SELECTOR` names a literal runnable Node test, Python unittest method, or
committed shell `BASELINE CASE` marker. A supporting artifact is optional; it
never substitutes for the named test.

Later migration pull requests must cite the affected IDs and preserve their
selectors or intentionally update the inventory, test, and this map together.

| Behavior ID | Exact test case | Fixture / builder |
|---|---|---|
| `CLI-MODE-HELP-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-HELP-01 help modes` | — |
| `CLI-MODE-VERSION-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode routes through dist` | — |
| `CLI-MODE-DEFAULT-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-DEFAULT-01 no arguments dispatch update` | — |
| `CLI-COMMANDS-01` | `tests/baseline/cli-parity.test.js::CLI-COMMANDS-01 eight named commands dispatch` | — |
| `CLI-USAGE-01` | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `CLI-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `CLI-ENV-CODEX-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-CODEX-PREFLIGHT-01 custom Codex command satisfies launcher preflight` | — |
| `CLI-ENV-CODEX-LISTING-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-CODEX-LISTING-01 the fingerprint listing uses the SUPERPOWERS_CODEX override, and resolves codex from PATH when it is unset` | — |
| `CLI-ENV-CODEX-MUTATION-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-CODEX-MUTATION-01 the install mutation uses the SUPERPOWERS_CODEX override` | — |
| `CLI-ENV-CACHE-DIR-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-PLUGIN-ROOT-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-MANIFEST-TEMPLATE-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-MANIFEST-TEMPLATE-01 fallback template bytes and non-file rejection` | — |
| `CLI-ENV-VALIDATOR-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-VALIDATOR-EXECUTABLE-01` | `tests/baseline/validator-executable.test.js::prepare accepts a tree when the executable validator exits 0` | `tests/bin/lifecycle-fixture.js` |
| `CLI-ENV-INSTALLED-ROOT-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-INSTALLED-ROOT-01 the active version selects its exact plugin cache path below SUPERPOWERS_INSTALLED_SEARCH_ROOT` | — |
| `CLI-ENV-REFRESH-MODE-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-REFRESH-MODE-01 install refuses a refresh mode outside add-only and remove-add, before any Codex mutation` | — |
| `CLI-ENV-PASSTHROUGH-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-01 eleven SUPERPOWERS variables pass through` | — |
| `CLI-ENV-PREPARE-PATHS-01` | `tests/baseline/prepare.test.js::CLI-ENV-PREPARE-PATHS-01 relative prepare paths use the invocation cwd` | — |
| `CLI-ENV-INSTALLED-DEFAULTS-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-INSTALLED-DEFAULTS-01 with no codex override and no search root the listing resolves codex from PATH and the installed fingerprint is read under $HOME/.codex` | — |
| `SEL-LOCATION-01` | `tests/baseline/selection-location.test.js::SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `SEL-PRECEDENCE-REF-01` | `tests/baseline/selection-location.test.js::SEL-PRECEDENCE-REF-01 complete ref precedence` | — |
| `SEL-PRECEDENCE-SOURCE-01` | `tests/baseline/cli-parity.test.js::SEL-PRECEDENCE-SOURCE-01 source precedence is independent` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-PRECEDENCE-VALIDATE-01` | `tests/baseline/selection-location.test.js::SEL-PRECEDENCE-VALIDATE-01 invalid saved state stops resolution` | — |
| `SEL-SCHEMA-MODES-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-MODES-01 read normalizes absent, pinned, and track-latest state` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-SCHEMA-KEYS-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-KEYS-01 read rejects unknown, missing, and inconsistent fields` | `tests/fixtures/baseline/selection/unknown-key.json` |
| `SEL-SCHEMA-REFS-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-REFS-01 read rejects empty, multiline, and invalid ref strings` | — |
| `SEL-SCHEMA-COMMIT-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-COMMIT-01 raw commit pins require cross-field equality` | — |
| `SEL-SCHEMA-COMMIT-WRITE-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-COMMIT-WRITE-01 the writer normalizes raw commit input to lowercase` | — |
| `SEL-SCHEMA-SOURCE-01` | `tests/baseline/selection-state.test.js::SEL-SCHEMA-SOURCE-01 source validation rejects HTTP(S) userinfo only` | — |
| `SEL-BYTES-PINNED-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | `tests/fixtures/baseline/selection/pinned-tag.json` |
| `SEL-BYTES-TRACK-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-BYTES-DIRECTORY-01` | `tests/baseline/selection-state.test.js::SEL-BYTES-DIRECTORY-01 the writer creates a private directory and a canonical private file` | — |
| `SEL-BYTES-DIRECTORY-PRESERVE-01` | `tests/baseline/selection-state.test.js::SEL-BYTES-DIRECTORY-PRESERVE-01 the writer preserves an existing directory mode` | — |
| `REF-PINNABLE-01` | `tests/baseline/cli-parity.test.js::CLI-PIN-REF-01 pin accepts exact tag or 40-hex commit only` | — |
| `REF-GENERIC-FALLBACK-01` | `tests/baseline/ref-resolution.test.js::REF-GENERIC-FALLBACK-01 arbitrary refs fall back after tag lookup` | — |
| `REF-LATEST-STABLE-01` | `tests/baseline/ref-resolution.test.js::REF-LATEST-STABLE-01 numeric stable release selection and peeling` | — |
| `REF-PIN-SOURCE-01` | `tests/baseline/selection-commands.test.js::REF-PIN-SOURCE-01 exact tag and raw commit pins prove selected source` | — |
| `REF-SOURCE-PROOF-01` | `tests/baseline/ref-resolution.test.js::REF-SOURCE-PROOF-01 selected source must supply a commit object` | — |
| `REF-CLEANUP-01` | `tests/baseline/ref-resolution.test.js::REF-CLEANUP-01 interrupted source proof cleans only its workspace` | — |
| `REF-PIN-CLEANUP-01` | `tests/baseline/selection-commands.test.js::REF-PIN-CLEANUP-01 interrupted pin proof cleans only its workspace` | — |
| `PROVENANCE-BYTES-01` | `tests/baseline/cli-parity.test.js::PROVENANCE-BYTES-01 prepare writes canonical provenance bytes` | `tests/fixtures/baseline/provenance/valid-commit.json` |
| `SEL-READER-DUPLICATES-01` | `tests/baseline/selection-state.test.js::SEL-READER-DUPLICATES-01 read rejects duplicate JSON keys` | `tests/fixtures/baseline/selection/duplicate-key.json` |
| `SEL-READER-CONSTANTS-01` | `tests/baseline/selection-state.test.js::SEL-READER-CONSTANTS-01 read rejects non-object documents and non-standard constants` | `tests/fixtures/baseline/selection/non-standard-constant.json` |
| `SEL-READER-DEPTH-01` | `tests/baseline/selection-state.test.js::SEL-READER-DEPTH-01 read enforces the exact JSON nesting boundary` | `tests/fixtures/baseline/selection/depth-257.json` |
| `SEL-READER-BYTES-01` | `tests/baseline/selection-state.test.js::SEL-READER-BYTES-01 read has no input byte limit` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-READER-PATHS-01` | `tests/baseline/selection-state.test.js::SEL-READER-PATHS-01 read rejects symlink, directory, and FIFO paths` | — |
| `PROV-READER-STRICT-01` | `tests/unit/provenance.test.js::PROV-READER-STRICT-01 reads fields under the strict provenance profile` | — |
| `PROV-READER-LENIENT-01` | `tests/unit/provenance.test.js::PROV-READER-LENIENT-01 returns only an acceptable generated commit` | — |
| `PROV-READER-CANDIDATE-01` | `tests/baseline/generated-plugin-corpus.test.js::PROV-READER-CANDIDATE-01 candidate provenance validator profile` | `tests/fixtures/baseline/provenance/wrong-key-set.json` |
| `PROV-READER-CODEX-SOURCE-01` | `tests/unit/provenance.test.js::PROV-READER-CODEX-SOURCE-01 Codex build source reader preserves its accepting profile` | `tests/fixtures/baseline/provenance/non-standard-constant.json` |
| `PROV-READER-CODEX-COMMIT-01` | `tests/unit/codex-state.test.js::PROV-READER-CODEX-COMMIT-01 installed metadata complete matrix` | `tests/fixtures/baseline/provenance/commit-7-hex.json` |
| `MANIFEST-READER-INSTALLED-01` | `tests/unit/codex-state.test.js::MANIFEST-READER-INSTALLED-01 installed manifest complete matrix` | `tests/fixtures/baseline/manifests/installed-manager-version.json` |
| `MANIFEST-READER-UPSTREAM-01` | `tests/baseline/prepare.test.js::MANIFEST-READER-UPSTREAM-01 upstream manifest version reaches provenance` | `tests/fixtures/baseline/manifests/upstream-no-hooks.json` |
| `MANIFEST-READER-MATERIALIZE-01` | `tests/unit/hooks.test.js::MANIFEST-READER-MATERIALIZE-01 hook manifest reader complete matrix` | `tests/fixtures/baseline/manifests/candidate-non-standard-constant.json` |
| `MANIFEST-READER-OVERLAY-01` | `tests/baseline/manifest-overlay-parity.test.js::BASELINE CASE: MANIFEST-READER-OVERLAY-01 byte parity with the Python oracle` | `tests/fixtures/baseline/overlay-parity/input/unknown-field.json` |
| `MANIFEST-READER-VALIDATOR-01` | `tests/baseline/generated-plugin-corpus.test.js::MANIFEST-READER-VALIDATOR-01 candidate validator profile` | `tests/fixtures/baseline/manifests/candidate-duplicate-key.json` |
| `CODEX-JSON-ARRAY-01` | `tests/unit/codex-json.test.js::CODEX-JSON-ARRAY-01 installed listing reader complete matrix` | — |
| `CODEX-JSON-MARKETPLACE-01` | `tests/unit/codex-json.test.js::CODEX-JSON-MARKETPLACE-01 marketplace reader complete matrix` | — |
| `CODEX-JSON-VERSION-01` | `tests/unit/codex-json.test.js::CODEX-JSON-VERSION-01 active version reader complete matrix` | — |
| `ADAPTER-FINGERPRINT-01` | `tests/unit/adapter.test.js::ADAPTER-FINGERPRINT-01 fingerprint inspection reports 40-hex and 7-hex commits in its exact result shape` | — |
| `ADAPTER-FINGERPRINT-REJECT-01` | `tests/unit/adapter.test.js::ADAPTER-FINGERPRINT-REJECT-01 a commit that is neither 7 nor 40 hex characters is never reported as a fingerprint` | — |
| `ADAPTER-UPDATE-CONTROL-01` | `tests/unit/lifecycle.test.js::ADAPTER-UPDATE-CONTROL-01 update-control recognizes exactly managed and unsupported and rejects a third value` | — |
| `ADAPTER-OWNERSHIP-01` | `tests/unit/adapter.test.js::ADAPTER-OWNERSHIP-01 identity_state is derived from all four manager and legacy resource booleans` | — |
| `ADAPTER-INSTALL-RESULT-01` | `tests/unit/adapter.test.js::ADAPTER-INSTALL-RESULT-01 install reports the missing hint always and the mismatch hint only in add-only refresh mode` | — |
| `ADAPTER-CONTROLLED-FAILURE-01` | `tests/unit/adapter.test.js::ADAPTER-CONTROLLED-FAILURE-01 a controlled failure carries its error and its hints in order, yields no result, and returns status 1` | — |
| `ADAPTER-TERMINAL-01` | `tests/unit/adapter-result.test.js::ADAPTER-TERMINAL-01 a C0, DEL, or C1 control in any terminal-facing failure string is refused` | — |
| `ADAPTER-SURROGATE-01` | `tests/unit/adapter-result.test.js::ADAPTER-SURROGATE-01 a surrogate code point in any terminal-facing failure string is refused without leaking a traceback` | — |
| `GENERATED-LAYOUT-01` | `tests/baseline/cli-parity.test.js::PREPARE-TREE-01 prepare creates the canonical generated tree` | `tests/fixtures/baseline/generated-tree/no-hooks.txt` |
| `GENERATED-UNKNOWN-FIELDS-01` | `tests/baseline/prepare.test.js::GENERATED-HOOKS-DECLARED-01 GENERATED-UNKNOWN-FIELDS-01 declared hook paths and unknown fields` | `tests/fixtures/baseline/manifests/upstream-active-hooks.json` |
| `GENERATED-WRONG-NAME-01` | `tests/baseline/prepare.test.js::GENERATED-WRONG-NAME-01 wrong upstream manifest name is rejected` | — |
| `GENERATED-FALLBACK-01` | `tests/baseline/prepare.test.js::GENERATED-FALLBACK-01 manifest-less upstream uses the manager fallback` | — |
| `GENERATED-HOOKS-FORBID-01` | `tests/baseline/prepare.test.js::GENERATED-HOOKS-FORBID-01 an exact empty hooks object stays hook-free` | `tests/fixtures/baseline/manifests/upstream-empty-hooks.json` |
| `GENERATED-HOOKS-DEFAULT-01` | `tests/baseline/prepare.test.js::GENERATED-HOOKS-DEFAULT-01 GENERATED-HOOKS-DEFAULT-LAYOUT-01 empty-array default discovery` | `tests/fixtures/baseline/manifests/upstream-default-hooks.json` |
| `GENERATED-HOOKS-DEFAULT-LAYOUT-01` | `tests/baseline/prepare.test.js::GENERATED-HOOKS-DEFAULT-01 GENERATED-HOOKS-DEFAULT-LAYOUT-01 empty-array default discovery` | `tests/fixtures/baseline/generated-tree/default-hooks.txt` |
| `GENERATED-HOOKS-DECLARED-01` | `tests/baseline/prepare.test.js::GENERATED-HOOKS-DECLARED-01 GENERATED-UNKNOWN-FIELDS-01 declared hook paths and unknown fields` | `tests/fixtures/baseline/generated-tree/declared-hooks.txt` |
| `FS-ATOMIC-01` | `tests/baseline/cli-parity.test.js::FS-ATOMIC-01 failed prepare preserves the previous generated tree` | `tests/builders/baseline-scenario.sh` |
| `FS-ATOMIC-SWAP-01` | `tests/unit/atomic.test.js::FS-ATOMIC-SWAP-01 EXDEV activation restores the prior tree` | — |
| `FS-CLEANUP-01` | `tests/baseline/cli-parity.test.js::FS-CLEANUP-01 interrupted state cleanup is invocation-scoped` | `tests/builders/baseline-scenario.sh` |
| `FS-SYMLINK-01` | `tests/baseline/cli-parity.test.js::FS-SYMLINK-01 escaping and broken symlinks fail closed` | `tests/builders/baseline-scenario.sh` |
| `FS-HOOK-CONTAINMENT-01` | `tests/baseline/prepare.test.js::FS-HOOK-CONTAINMENT-01 an escaping hook symlink fails closed` | — |
| `FS-GENERATED-RESOLVE-01` | `tests/unit/generated-plugin.test.js::FS-GENERATED-RESOLVE-01 filesystem boundary: resolution, cycles, pathname codec, inspection failures` | — |
| `FS-SELECTION-ATOMIC-01` | `tests/unit/selection.test.js::FS-SELECTION-ATOMIC-01 selection rename failure preserves prior state and foreign temporary` | — |
| `FS-SELECTION-CONCURRENT-01` | `tests/baseline/selection-state.test.js::FS-SELECTION-CONCURRENT-01 concurrent writers leave one complete valid record` | — |
| `FS-SELECTION-POST-REPLACE-01` | `tests/unit/selection.test.js::FS-SELECTION-POST-REPLACE-01 selection write reports final landed mode` | — |
| `FS-SELECTION-TYPES-01` | `tests/baseline/selection-state.test.js::FS-SELECTION-TYPES-01 the writer rejects unexpected state and parent path types` | — |
| `FS-SELECTION-UNPIN-TYPES-01` | `tests/baseline/selection-commands.test.js::FS-SELECTION-UNPIN-TYPES-01 unpin rejects unsafe path types` | — |
| `SEL-READER-PARENT-01` | `tests/baseline/selection-state.test.js::SEL-READER-PARENT-01 read rejects absent state below a symlinked config directory` | — |
| `PREPARE-VALIDATE-01` | `tests/baseline/cli-parity.test.js::PREPARE-VALIDATE-01 validation completes before activation` | `tests/builders/baseline-scenario.sh` |
| `PREPARE-DETERMINISTIC-01` | `tests/baseline/cli-parity.test.js::PREPARE-TREE-01 prepare creates the canonical generated tree` | `tests/fixtures/baseline/generated-tree/no-hooks.txt` |
| `PROBE-READONLY-01` | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | `tests/bin/lifecycle-fixture.js` |
| `PROBE-FAIL-CLOSED-01` | `tests/baseline/probe.test.js::PROBE-FAIL-CLOSED-01 invalid selection and adapter evidence fail closed` | — |
| `INSTALL-ORDER-01` | `tests/baseline/cli-parity.test.js::INSTALL-ORDER-01 install prepares and validates before adapter mutation` | `tests/bin/lifecycle-fixture.js` |
| `INSTALL-LEGACY-01` | `tests/baseline/cli-parity.test.js::LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed` | `tests/bin/lifecycle-fixture.js` |
| `INSTALL-VERIFY-01` | `tests/baseline/marketplace-reconcile.test.js::INSTALL-VERIFY-01 installed fingerprint proof and hints` | — |
| `UPDATE-CONTROL-01` | `tests/baseline/cli-parity.test.js::UPDATE-CONTROL-01 update requires current managed control evidence` | — |
| `UNINSTALL-OWNERSHIP-01` | `tests/baseline/cli-parity.test.js::UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources` | — |
| `UNINSTALL-TARGETS-01` | `tests/baseline/marketplace-reconcile.test.js::UNINSTALL-TARGETS-01 adapter removes only manager resources` | — |
| `UNINSTALL-VERIFY-01` | `tests/baseline/marketplace-reconcile.test.js::UNINSTALL-VERIFY-01 both manager resources must be absent` | — |
| `DIAG-INTENTIONAL-01` | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `DIAG-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `DIAG-SELECTION-PIN-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | — |
| `DIAG-SELECTION-TRACK-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | — |
| `DIAG-SELECTION-UNPIN-01` | `tests/baseline/cli-parity.test.js::SEL-UNPIN-01 unpin removes saved intent without applying changes` | — |
| `DIAG-PROBE-01` | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | — |
| `DIAG-ADAPTER-01` | `tests/unit/adapter.test.js::DIAG-ADAPTER-01 adapter messages, errors, and hints retain their declared stream and array order` | — |
| `PACKAGE-REPO-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode routes through dist` | — |
| `PACKAGE-TARBALL-01` | `tests/baseline/packaged-cli.test.js::PACKAGE-CLI-01 offline installed tarball routes through dist and exposes help and version` | — |

## Split coverage

One row above anchors a case that covers only part of its behavior ID. The
remainder is named here rather than left to be rediscovered.

`GENERATED-HOOKS-FORBID-01` states two claims in
[`behavioral-inventory.md`](behavioral-inventory.md): that an upstream exact
`hooks: {}` forbids a generated `hooks/`, and that a manifest-less fallback
forbids one too. Its row's case exercises only the first, over
`REFS.emptyObjectHooks`. The second is asserted by
`assert.equal(existsSync(join(generated(c), "hooks")), false);` inside
`tests/baseline/prepare.test.js::GENERATED-FALLBACK-01 manifest-less upstream
uses the manager fallback` — the case `GENERATED-FALLBACK-01`'s own row
anchors, and whose inventory entry independently states that the generated
fallback has no `hooks/`. The case is named rather than line-numbered on
purpose: a line pointer into a file under edit goes stale silently, and nothing
gates it. The claim is therefore co-owned by the two IDs, not orphaned:
broadening the `GENERATED-HOOKS-FORBID-01` case would duplicate an assertion
already made a few lines away in the same file, and would cost a case rename
that both this table and `tests/migration-inventory/prepare.md` cite by name.

Before PR 11.5 slice 3.5 the row anchored a single retired shell case that
carried both halves; the split is a consequence of that case's deletion, not of
lost coverage.
