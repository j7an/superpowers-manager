# Behavioral Migration Baseline

This inventory freezes the observable behavior that later migration pull
requests must preserve or explicitly amend. It records the repository at the
Phase 0 baseline; it does not make generated content under
`plugins/superpowers/` maintained source.

Every normative behavior has a stable ID. The executable mapping is in
[`traceability.md`](traceability.md). Reader differences are deliberate
compatibility facts, not a recommendation to make every parser identical.

## Public CLI

| Behavior ID | Contract |
|---|---|
| `CLI-MODE-HELP-01` | `--help` and `-h` are standalone help modes. Even when Git, Python, Codex, and the POSIX shell are unavailable, they write the complete usage text to stdout, write nothing to stderr, perform no preflight or dispatch, and exit 0. |
| `CLI-MODE-VERSION-01` | `--version` is a standalone version mode. It reads the current package version, writes that value plus one newline to stdout, writes nothing to stderr, performs no dispatch, and exits 0. |
| `CLI-MODE-DEFAULT-01` | No arguments is the third distinct mode and is exactly equivalent to dispatching `update` with no arguments. |
| `CLI-COMMANDS-01` | The eight named subcommands are `pin`, `track-latest`, `unpin`, `prepare`, `probe`, `install`, `update`, and `uninstall`. Except for CLI-owned arity and pin-ref checks, remaining arguments pass through unchanged to the selected script. |
| `CLI-USAGE-01` | Unknown commands, stray top-level flags, invalid `pin` arity/ref syntax, and extra arguments to `track-latest` or `unpin` are usage errors. They do not dispatch, print `error: ...` followed by usage, and exit 2. |
| `CLI-PREFLIGHT-01` | Preflight is command-specific and completes before dispatch: `pin` needs Git and Python; `track-latest` needs Python; `unpin` has no extra tool; `prepare` needs Git and Python; `probe`, `install`, and `update` need Git, Python, and Codex; `uninstall` needs Python and Codex. Every command also needs a POSIX shell. Missing requirements exit 1 without dispatch. |
| `CLI-CHILD-STATUS-01` | After successful preflight, the delegated script inherits stdio and environment; its numeric exit status is the CLI exit status. Spawn failure or a signal-only result is normalized to exit 1. |

## Environment and location

The ten `SUPERPOWERS_*` variables below are the complete public override set.
The CLI inherits the environment wholesale. “Unset” means the consumer uses
the source-derived default shown here. `SUPERPOWERS_CODEX` appears three times
to separate launcher preflight, listing, and mutation use.

| Behavior ID | Variable | Current default | Production consumer and effect |
|---|---|---|---|
| `SEL-PRECEDENCE-REF-01` | `SUPERPOWERS_REF` | Saved pinned/track-latest intent, then `config/upstream-ref` (`latest-release`) | Selection/ref computation. Ref precedence is independent: non-empty `SUPERPOWERS_REF` > saved pinned ref or saved track-latest intent > packaged `config/upstream-ref`. Generic runtime resolution is frozen separately under `REF-GENERIC-FALLBACK-01`. |
| `SEL-PRECEDENCE-SOURCE-01` | `SUPERPOWERS_UPSTREAM_URL` | `https://github.com/obra/superpowers` unless saved selection supplies a source | Selection/source computation plus `pin` and `track-latest`. Source precedence is independent: non-empty `SUPERPOWERS_UPSTREAM_URL` > source saved with either selection mode > `https://github.com/obra/superpowers`. A ref and source may therefore have different origins. |
| `CLI-ENV-CODEX-PREFLIGHT-01` | `SUPERPOWERS_CODEX` | `codex` | Public CLI preflight accepts an executable path override in place of the default `codex` command before dispatching Codex-dependent commands. |
| `CLI-ENV-CODEX-LISTING-01` | `SUPERPOWERS_CODEX` | `codex` | Codex adapter fingerprint listing uses the executable override; when unset, it resolves `codex` from `PATH`. |
| `CLI-ENV-CODEX-MUTATION-01` | `SUPERPOWERS_CODEX` | `codex` | Codex adapter install mutation uses the explicit executable override. |
| `CLI-ENV-CACHE-DIR-01` | `SUPERPOWERS_CACHE_DIR` | Package-root `.cache/upstream` | `prepare`; the upstream repository is beneath `superpowers/`. |
| `SEL-LOCATION-01` | `SUPERPOWERS_CONFIG_DIR` | `SUPERPOWERS_CONFIG_DIR/selection.json`, otherwise the XDG/HOME chain below | Selection-state readers and writers. Selection state is exactly `SUPERPOWERS_CONFIG_DIR/selection.json` when that variable is set; otherwise `$XDG_CONFIG_HOME/superpowers-manager/selection.json` when XDG is non-empty; otherwise `$HOME/.config/superpowers-manager/selection.json`. Relative or unavailable required bases fail closed. An explicitly set value, including empty, must be absolute. |
| `CLI-ENV-PLUGIN-ROOT-01` | `SUPERPOWERS_PLUGIN_ROOT` | Package-root `plugins/superpowers` | `prepare`; the selected path becomes the generated live tree. |
| `CLI-ENV-MANIFEST-TEMPLATE-01` | `SUPERPOWERS_MANIFEST_TEMPLATE` | Package-root `plugins/superpowers/.codex-plugin/plugin.template.json` | `prepare` passes the selected fallback bytes through adapter build into generated `.codex-plugin/plugin.template.json`. A non-file path fails before adapter build or mutation. |
| `CLI-ENV-VALIDATOR-01` | `SUPERPOWERS_VALIDATOR` | Empty, meaning no additional validator | `prepare`; a non-empty path runs after built-in validation and before activation. |
| `CLI-ENV-INSTALLED-ROOT-01` | `SUPERPOWERS_INSTALLED_SEARCH_ROOT` | `$HOME/.codex` | Codex fingerprint inspection; the active version selects the exact plugin cache path below this root. |
| `CLI-ENV-REFRESH-MODE-01` | `SUPERPOWERS_INSTALL_REFRESH_MODE` | `add-only` | Codex adapter install; allowed values are `add-only` and `remove-add`. |

| Behavior ID | Contract |
|---|---|
| `CLI-ENV-PASSTHROUGH-01` | The CLI inherits its controlled invocation environment wholesale, including the ten public `SUPERPOWERS_*` overrides; it does not synthesize unrelated `XDG_*`, npm, or Codex variables. |
| `CLI-ENV-PREPARE-PATHS-01` | Relative `SUPERPOWERS_CACHE_DIR` and `SUPERPOWERS_PLUGIN_ROOT` values are resolved from the invocation directory. |
| `CLI-ENV-INSTALLED-DEFAULTS-01` | Without explicit overrides, Codex adapter fingerprint listing uses `codex` from `PATH` and installed fingerprint lookup uses `$HOME/.codex`. |
| `SEL-PRECEDENCE-VALIDATE-01` | Saved selection and the resulting source are validated before ref resolution. Invalid saved state cannot be bypassed by environment ref/source overrides. |

## Selection schema, refs, and canonical bytes

| Behavior ID | Contract |
|---|---|
| `SEL-SCHEMA-MODES-01` | Absent state normalizes to mode `none` and empty saved fields. Valid present state normalizes mode exactly `pinned` or `track-latest`. |
| `SEL-SCHEMA-KEYS-01` | Present state is an object with integer `schema_version: 1`; Boolean `true` is not integer 1. `track-latest` has exactly `schema_version`, `mode`, and `source`. `pinned` additionally has exactly `requested_ref`, `resolved_ref`, and `commit`. Missing, unknown, or duplicate keys fail. |
| `SEL-SCHEMA-REFS-01` | A pinned tag is a v-prefixed SemVer 2.0.0 core with optional prerelease and no build metadata; `resolved_ref` must equal the requested tag. All ref/source strings are non-empty single-line strings without NUL. |
| `SEL-SCHEMA-COMMIT-01` | A saved raw commit is lowercase 40-hex and `requested_ref`, `resolved_ref`, and `commit` must be identical. |
| `SEL-SCHEMA-COMMIT-WRITE-01` | Writers accept uppercase raw-commit input only by normalizing `requested_ref`, `resolved_ref`, and `commit` to lowercase. |
| `SEL-SCHEMA-SOURCE-01` | Source may be HTTP(S), SSH, scp-like, absolute local, or other Git-compatible text. HTTP(S) userinfo is rejected and redacted from diagnostics. |
| `SEL-BYTES-PINNED-01` | `pin` writes the canonical two-space-indented pinned record below with a final newline and file mode 0600. |
| `SEL-BYTES-TRACK-01` | `track-latest` writes the canonical two-space-indented track-latest record below with a final newline and file mode 0600. It saves intent only. |
| `SEL-BYTES-DIRECTORY-01` | A newly created selection-state directory is mode 0700. |
| `SEL-BYTES-DIRECTORY-PRESERVE-01` | A selection writer preserves the mode of an existing state directory. |

Pinned tag bytes:

```json
{
  "schema_version": 1,
  "mode": "pinned",
  "source": "https://github.com/obra/superpowers",
  "requested_ref": "v6.1.1",
  "resolved_ref": "v6.1.1",
  "commit": "0123456789abcdef0123456789abcdef01234567"
}
```

Pinned commit bytes:

```json
{
  "schema_version": 1,
  "mode": "pinned",
  "source": "https://github.com/obra/superpowers",
  "requested_ref": "0123456789abcdef0123456789abcdef01234567",
  "resolved_ref": "0123456789abcdef0123456789abcdef01234567",
  "commit": "0123456789abcdef0123456789abcdef01234567"
}
```

Track-latest bytes:

```json
{
  "schema_version": 1,
  "mode": "track-latest",
  "source": "https://github.com/obra/superpowers"
}
```

| Behavior ID | Contract |
|---|---|
| `REF-PINNABLE-01` | Public `pin` accepts only an exact v-prefixed SemVer tag or full 40-hex commit. Tag build metadata, short commits, branches, and symbolic refs are rejected as usage errors. |
| `REF-GENERIC-FALLBACK-01` | Outside persisted `pin` grammar, a non-empty runtime branch ref is resolved by trying the exact tag namespace first, then the same text as a generic ref; this includes a branch whose spelling resembles a tag. |
| `REF-LATEST-STABLE-01` | `latest-release` considers v-prefixed tags, ignores prereleases and non-three-component tags, uses peeled annotated-tag commits, and selects the greatest numeric stable major/minor/patch. |
| `REF-PIN-SOURCE-01` | Public `pin` resolves exact tags only from the selected source’s tag namespace, peels annotated tags, normalizes raw commit input to lowercase, and saves the proven identity and source. |
| `REF-SOURCE-PROOF-01` | Exact-commit proof uses an invocation-private repository, cannot be satisfied by an object already in the persistent cache, and accepts only a commit object supplied by the selected source. |
| `REF-CLEANUP-01` | An interrupted exact-fetch source-proof removes only its invocation-owned proof repository and preserves sibling workspace content. |
| `REF-PIN-CLEANUP-01` | An interrupted public `pin` raw-commit proof removes only its invocation-owned verifier repository, preserves sibling content and prior selection state, and reports signal status 143. |

## Canonical generated provenance

| Behavior ID | Contract |
|---|---|
| `PROVENANCE-BYTES-01` | For tag/latest and raw 40-hex commit preparation, `prepare` manager-authors `.superpowers-upstream.json` with exactly `source`, `requested_ref`, `resolved_ref`, `commit`, and `upstream_manifest_version` in that order, two-space indentation, JSON escaping, and one final newline. |

Tag/latest provenance bytes:

```json
{
  "source": "https://example.invalid/superpowers.git",
  "requested_ref": "latest-release",
  "resolved_ref": "v6.1.1",
  "commit": "d884ae04edebef577e82ff7c4e143debd0bbec99",
  "upstream_manifest_version": "6.1.1"
}
```

Raw-commit provenance bytes:

```json
{
  "source": "https://example.invalid/superpowers.git",
  "requested_ref": "d884ae04edebef577e82ff7c4e143debd0bbec99",
  "resolved_ref": "d884ae04edebef577e82ff7c4e143debd0bbec99",
  "commit": "d884ae04edebef577e82ff7c4e143debd0bbec99",
  "upstream_manifest_version": "6.1.1"
}
```

## Reader and trust-boundary matrix

“No byte cap” means the reader has no manager-authored input-size check. “No
explicit depth cap” means decoder recursion failure is handled, but there is no
promised numeric nesting boundary.

| Profile | Constants | Nesting | Bytes | Duplicate keys | Schema refinement and fail-closed behavior |
|---|---|---|---|---|---|
| Selection state | Reject | Maximum 256 containers; 257 rejects | No byte cap | Reject recursively | Exact selection keys/types/cross-field rules; absent is normalized, malformed/path-type input exits nonzero with no normalized output or traceback. |
| Provenance strict field reader | Reject | Maximum 256 containers | No byte cap | Last key wins | Requires a top-level object, then extracts one dotted field; malformed input is an operational error. |
| Provenance lenient generated-commit reader | Reject to empty | No explicit depth cap; recursion failure becomes empty | No byte cap | Last key wins | Returns only a 40-hex commit. Missing, malformed, short, or wrong-type input yields empty success so status remains conservative. |
| Provenance candidate validator | Reject | Maximum 256 containers | No byte cap | Last key wins | Exact five-key manager contract, expected-value equality, and lowercase 40-hex commit; validation exits 1 without traceback. |
| Provenance Codex build source reader | Accept | No explicit depth cap; recursion failure rejects | No byte cap | Last key wins | Requires only a top-level object with non-empty string `source`; failure becomes controlled `invalid-provenance`, then candidate validation applies the full contract. |
| Provenance Codex installed-commit reader | Reject | Maximum 256 containers | No byte cap | Last key wins | Top-level object and string commit of 7 or 40 hex; unreadable or invalid input returns nonzero and cannot prove a fingerprint. |
| Installed generated-manifest reader | Reject | Maximum 256 containers | No byte cap | Last key wins | Requires a top-level object and string `version`. The version must contain `+manager.`, and its final dot component is returned only when that component is seven hex characters; it need not have the literal terminal shape `+manager.<7hex>`. Valid nonmatching versions return empty success, while reader failure cannot prove the installed fingerprint. |
| Upstream manifest pipeline | Reject | Maximum 256 containers | No byte cap | Last key wins | Requires an object and prevents activation on reader failure. Materialization, overlay, and generated-tree validation are separate profiles below. |
| Candidate hook materializer | Reject | Maximum 256 containers | No byte cap | Last key wins | Requires an object and materialization fails on reader failure. Source-sensitive hook forms and containment are frozen separately under generated-tree and filesystem IDs. |
| Candidate manifest overlay | Reject | Maximum 256 containers | No byte cap | Last key wins | Requires an object and preserves unknown fields and winning upstream values except manager-owned `version` and `skills`. |
| Candidate generated-plugin validator | Reject | Maximum 256 containers | No byte cap | Last key wins | Validates manager-owned manifest fields and referenced paths; manifest validation failures exit 1 without traceback. Provenance, hooks, required tree, and skill frontmatter have independent contracts and selectors. |
| Codex installed/listing membership parser | Accept | No explicit depth cap; recursion failure exits 2 | No byte cap | Last key wins | Named top-level array; every item must be an object with a non-empty string target field. Emits only `present`/`absent`; invalid input exits 2 with no result. |
| Codex marketplace-root parser | Accept | No explicit depth cap; recursion failure exits 2 | No byte cap | Last key wins | Every item needs a non-empty string name; only the matching item needs a non-empty string root. Invalid input exits 2 with no result. |
| Codex active-version parser | Reject | No explicit depth cap; recursion failure exits 2 | No byte cap | Last key wins | At most one matching plugin; version is a safe non-empty cache-path component without terminal controls. Invalid input exits 2; verified absence is empty exit 0. |
| Adapter-response reader | Reject | Maximum 64 containers; 65 rejects | 1,048,576 bytes inclusive | Reject recursively | Exact protocol-v1 envelope and per-operation schema. Malformed input exits validator 2, writes no result, and replays nothing; the public adapter boundary normalizes nonzero to operational failure. |

The reader behaviors above are assigned as follows.

| Behavior ID | Contract |
|---|---|
| `SEL-READER-DUPLICATES-01` | Selection JSON rejects duplicate object keys recursively. |
| `SEL-READER-CONSTANTS-01` | Selection JSON rejects `NaN`, `Infinity`, and `-Infinity`. |
| `SEL-READER-DEPTH-01` | Selection JSON accepts parsing through 256 nested arrays/objects and rejects 257 before schema use. |
| `SEL-READER-BYTES-01` | Selection JSON has no input byte cap; valid state padded beyond 1 MiB remains valid. |
| `SEL-READER-PATHS-01` | Selection state is inspected without following a state symlink; symlink, directory, and FIFO state paths fail closed. |
| `PROV-READER-STRICT-01` | The strict provenance field-reader profile is frozen exactly as the matrix states. |
| `PROV-READER-LENIENT-01` | The lenient generated-commit profile is frozen exactly as the matrix states. |
| `PROV-READER-CANDIDATE-01` | The generated-candidate provenance validator profile is frozen exactly as the matrix states. |
| `PROV-READER-CODEX-SOURCE-01` | The Codex build source-reader profile is frozen exactly as the matrix states. |
| `PROV-READER-CODEX-COMMIT-01` | The Codex installed-metadata commit-reader profile is frozen exactly as the matrix states. |
| `MANIFEST-READER-INSTALLED-01` | The installed generated-manifest fingerprint profile is frozen exactly as the matrix states. |
| `MANIFEST-READER-UPSTREAM-01` | The upstream manifest pipeline profile is frozen exactly as the matrix states. |
| `MANIFEST-READER-MATERIALIZE-01` | The candidate hook-materializer profile is frozen exactly as the matrix states. |
| `MANIFEST-READER-OVERLAY-01` | The candidate manifest-overlay profile is frozen exactly as the matrix states. |
| `MANIFEST-READER-VALIDATOR-01` | The candidate generated-plugin validator profile is frozen exactly as the matrix states. |
| `CODEX-JSON-ARRAY-01` | The Codex installed/listing membership profile is frozen exactly as the matrix states. |
| `CODEX-JSON-MARKETPLACE-01` | The Codex marketplace-root profile is frozen exactly as the matrix states. |
| `CODEX-JSON-VERSION-01` | The Codex active-version profile is frozen exactly as the matrix states. |

## Adapter protocol

[`docs/adapter-protocol.md`](../adapter-protocol.md) is the normative internal
protocol-v1 envelope and operation-schema definition. This inventory links to
that contract rather than restating or redefining its six-key envelope.

| Behavior ID | Contract |
|---|---|
| `ADAPTER-PROTOCOL-01` | Successful `build` and `uninstall` protocol-1 responses accept only their exact empty result objects. Inspect and install results have independent contracts below. |
| `ADAPTER-ENVELOPE-01` | Empty, malformed, non-object, and extra-key response input is rejected before replay. |
| `ADAPTER-ENVELOPE-KEYS-01` | A response missing a required protocol-v1 envelope key is rejected before result creation or message replay. |
| `ADAPTER-ENVELOPE-TYPES-01` | Protocol, operation, Boolean, message, result-view, and invocation-view mismatches are rejected before replay. |
| `ADAPTER-FINGERPRINT-01` | Fingerprint inspection accepts null and exact 7- or 40-hex fingerprints in its exact result shape. |
| `ADAPTER-FINGERPRINT-REJECT-01` | Fingerprint inspection rejects a non-null fingerprint whose length is neither 7 nor 40 hexadecimal characters. |
| `ADAPTER-UPDATE-CONTROL-01` | Update-control inspection accepts only `managed` or `unsupported` in its exact result shape. |
| `ADAPTER-OWNERSHIP-01` | Ownership inspection accepts all internally consistent manager/legacy resource Boolean combinations and derived identity states. |
| `ADAPTER-OWNERSHIP-REJECT-01` | Ownership inspection rejects old, malformed, wrong-type, and internally inconsistent result shapes. |
| `ADAPTER-INSTALL-RESULT-01` | Install success accepts exact `verification_hints` with neither, either, or both optional `mismatch` and `missing` terminal-facing strings. |
| `ADAPTER-INSTALL-REJECT-01` | Install results reject unknown hint keys and empty hint strings. |
| `ADAPTER-STATUS-01` | `ok`, adapter exit status, `result`, and `error` obey the success/failure cross-rules. |
| `ADAPTER-REPLAY-01` | Only a completely validated response replays messages, in array order and to each declared stream. |
| `ADAPTER-CONTROLLED-FAILURE-01` | A valid controlled failure replays validated messages, error, and hints, yields no result, and returns validator status 1. |
| `ADAPTER-TERMINAL-01` | Terminal-facing protocol strings reject C0, DEL, and C1 controls. |
| `ADAPTER-TERMINAL-SHAPE-01` | Empty replayed message text is rejected. |
| `ADAPTER-SURROGATE-01` | Terminal-facing protocol strings reject surrogate code points without leaking a traceback. |
| `ADAPTER-READER-BYTES-01` | The response file limit is inclusive at exactly 1,048,576 bytes and rejects the next byte before replay. |
| `ADAPTER-READER-UTF8-01` | Adapter response size is counted in UTF-8 bytes, not Unicode code points. |
| `ADAPTER-READER-CONSTANTS-01` | Adapter response JSON rejects all non-standard numeric constants before replay. |
| `ADAPTER-READER-DEPTH-01` | Adapter response JSON accepts exactly 64 nested containers and rejects 65 before replay. |
| `ADAPTER-READER-DUPLICATES-01` | Adapter response JSON rejects duplicate keys recursively before replay. |

## Generated tree and hook forms

| Behavior ID | Contract |
|---|---|
| `GENERATED-LAYOUT-01` | A successful public prepare produces `.codex-plugin/plugin.json`, `.codex-plugin/plugin.template.json`, `.superpowers-upstream.json`, `CODE_OF_CONDUCT.md`, `LICENSE`, `README.md`, and a non-empty `skills/`; optional upstream `assets/` is copied. |
| `GENERATED-UNKNOWN-FIELDS-01` | When upstream provides `.codex-plugin/plugin.json`, unknown upstream fields are preserved and the manager overwrites a ref-aware manager version and `skills: ./skills/`. |
| `GENERATED-WRONG-NAME-01` | An upstream manifest whose name is not exactly `superpowers` is rejected rather than repaired or activated. |
| `GENERATED-FALLBACK-01` | The fallback template is used only when upstream has no manifest; the generated fallback keeps manager-owned `version` and `skills` and has neither a hook declaration nor `hooks/`. |
| `GENERATED-HOOKS-FORBID-01` | Upstream exact `hooks: {}` forbids generated `hooks/`. Manifest-less fallback also has no hook declaration and forbids generated `hooks/`. |
| `GENERATED-HOOKS-DEFAULT-01` | Upstream absent `hooks` or empty array uses default discovery: copy `hooks/` only when upstream has regular `hooks/hooks.json`; generated default-discovered hooks must contain that file. |
| `GENERATED-HOOKS-DEFAULT-LAYOUT-01` | Default-discovered hooks produce the complete canonical path layout recorded by the default-hooks golden fixture. |
| `GENERATED-HOOKS-DECLARED-01` | Valid active upstream string/path-list declarations materialize the declared contained files and valid hook subtree; valid active object/object-list declarations copy a present valid hook subtree. |

Canonical no-hooks form:

```text
.codex-plugin/
.codex-plugin/plugin.json
.codex-plugin/plugin.template.json
.superpowers-upstream.json
CODE_OF_CONDUCT.md
LICENSE
README.md
assets/
assets/superpowers-small.svg
skills/
skills/brainstorming/
skills/brainstorming/SKILL.md
```

Canonical default-hooks form adds:

```text
hooks/
hooks/hooks-codex.json
hooks/hooks.json
hooks/session-start-codex
hooks/support/
hooks/support/helper.txt
```

Canonical declared-hooks form adds:

```text
alternate/
alternate/hooks-second.json
config/
config/hooks-first.json
hooks/
hooks/hooks-codex.json
hooks/session-start-codex
hooks/support/
hooks/support/helper.txt
```

## Filesystem, lifecycle, and observability

| Behavior ID | Contract |
|---|---|
| `FS-ATOMIC-01` | `prepare` passes the generated-tree candidate from a same-parent `.superpowers.prepare.XXXXXX` invocation workspace to validation. Any pre-activation failure preserves the previous generated tree and removes its own staging tree. |
| `FS-ATOMIC-SWAP-01` | Activation uses rename; if the candidate-to-live rename fails after backing up an existing live tree, the previous tree is restored and candidate/backup residue is removed. |
| `FS-CLEANUP-01` | Failed prepare cleanup removes only the current invocation workspace; sibling and interrupted historical workspaces are preserved. |
| `FS-SYMLINK-01` | Public prepare rejects escaping and broken symlinks in a copied hook tree before activation or Codex mutation. |
| `FS-HOOK-CONTAINMENT-01` | Declared hook files and copied hook roots/subtrees enforce contained regular-file/directory rules; missing, directory, absolute, broken, escaping, and unsafe source-only symlinks fail before activation. |
| `FS-SELECTION-ATOMIC-01` | A selection writer passes a mode-0600 invocation-owned temporary file to atomic replacement; failed replacement preserves the prior record, removes only that temporary file, and retains unrelated temporary files. |
| `FS-SELECTION-CONCURRENT-01` | Two concurrent selection writers leave one complete canonical record that reads as either requested mode. |
| `FS-SELECTION-POST-REPLACE-01` | If replace completes but reports failure, the writer reports the truthful final selection mode. |
| `FS-SELECTION-TYPES-01` | Selection writers reject symlink, directory, FIFO, and symlinked-parent targets. |
| `FS-SELECTION-UNPIN-TYPES-01` | `unpin` removes only the exact regular selection file and refuses symlink, directory, and FIFO targets without removing sibling content. |
| `SEL-READER-PARENT-01` | Selection reads reject an absent state beneath a symlinked configuration directory. |
| `PREPARE-VALIDATE-01` | `prepare` resolves/fetches, builds via the adapter, completes built-in validation, then any configured additional validator, and only then activates. |
| `PREPARE-DETERMINISTIC-01` | Given the same selected source/ref and inputs, `prepare` emits the canonical generated layout, manager overlay, provenance bytes, and ref-aware version deterministically. |
| `PROBE-READONLY-01` | `probe` computes desired/generated/installed state and reports human or porcelain fields without changing selection, generated, cache, adapter, or Codex state; its own temporary workspace is removed. |
| `PROBE-FAIL-CLOSED-01` | Invalid selection/source and malformed required adapter evidence are operational failures, never reported as current or absent, and validation precedes Git or adapter access. |
| `INSTALL-ORDER-01` | `install` probes, prepares and validates when needed, then re-inspects ownership/update control, mutates manager state, and finally inspects the installed fingerprint. No adapter mutation precedes successful preparation/validation. |
| `INSTALL-LEGACY-01` | Fresh legacy ownership evidence blocks installation before preparation or mutation, preserves the interrupted state, and emits no success report. |
| `INSTALL-VERIFY-01` | Install succeeds only when the final 7- or 40-hex installed fingerprint matches the prepared 40-hex commit; missing or mismatched proof fails with the validated adapter hint when available. |
| `UPDATE-CONTROL-01` | `update` requires fresh validated `managed` update-control evidence before treating current state as success or allowing installation/refresh mutation. Unsupported, unknown, or malformed evidence fails without mutation. |
| `UNINSTALL-OWNERSHIP-01` | Public `uninstall` inspects manager ownership, leaves legacy resources in place with a report, and leaves generated/cache artifacts in place. |
| `UNINSTALL-TARGETS-01` | The Codex adapter removes only plugin `superpowers@superpowers-manager` and marketplace `superpowers-manager`; unrelated providers are never named by removal commands. |
| `UNINSTALL-VERIFY-01` | After adapter uninstall, ownership is re-inspected and success requires both manager plugin and marketplace to be absent; otherwise uninstall fails. |

Observable filesystem and external-state effects:

| Operation | Success effect | Failure or no-op boundary |
|---|---|---|
| `pin` / `track-latest` | Create/update only selection state and its private temporary file lifecycle. | Prior valid state survives failed proof/write; no generated or Codex mutation. |
| `unpin` | Remove only a regular saved `selection.json`. | Invalid path types remain and fail; generated/cache/Codex state is untouched. |
| `prepare` | Update the upstream cache and atomically replace only the selected generated plugin root. | Prior live tree survives validation/build/swap failure; current invocation scratch is removed. |
| `probe` | No durable write. | Unprovable state is failure, not absence/current. |
| `install` / `update` | May register/reconcile the manager marketplace and add/refresh only the manager plugin after validation. | Preflight, prepare, ownership, update-control, and protocol failures prevent later mutations. |
| `uninstall` | May remove only the manager plugin and manager marketplace. | Generated plugin and cache remain; legacy and foreign providers remain. |

## Diagnostics and package entrypoints

| Behavior ID | Contract |
|---|---|
| `DIAG-INTENTIONAL-01` | Public usage/help bytes and usage-error classification/exit 2 are frozen by their exact public CLI selectors. |
| `DIAG-PREFLIGHT-01` | Missing-tool preflight messages and exit behavior are frozen where the public preflight selector compares exact bytes. |
| `DIAG-SELECTION-PIN-01` | Canonical successful `pin` text is the pinned ref and resolved full commit followed by one newline. |
| `DIAG-SELECTION-TRACK-01` | Canonical successful `track-latest` text is `saved upstream selection: latest stable release` followed by one newline. |
| `DIAG-SELECTION-UNPIN-01` | Canonical successful `unpin` text reports saved-state removal, the packaged fallback, and active ref/source override notes, each on its own line. |
| `DIAG-PROBE-01` | A public read-only porcelain probe reports a 40-hex `desired_commit` line and the exact `status=needs prepare` value for the frozen scenario. |
| `DIAG-ADAPTER-01` | Validated adapter messages, controlled errors, and hints retain their declared stream and array order. |
| `PACKAGE-REPO-01` | The public bin resolves package root from the physical bin location and runs from a repository/copy checkout without relying on the caller’s current directory. |
| `PACKAGE-TARBALL-01` | The same declared `superpowers-manager` bin works from an offline installed npm tarball and exposes package-local help/version without reaching the repository checkout or network. |

Absolute temporary paths, upstream Git/Codex/library wording, and unasserted
operational prose are not frozen. Where a selector matches only a fragment,
the category, safety meaning, exit behavior, and absence of traceback remain
intentional; surrounding prose does not.
