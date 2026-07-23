# Behavioral Baseline Traceability

Every behavior ID in
[`behavioral-inventory.md`](behavioral-inventory.md) has exactly one row here.
`PATH::SELECTOR` names a literal runnable Node test, Python unittest method, or
committed shell `BASELINE CASE` marker. A supporting artifact is optional; it
never substitutes for the named test.

Later migration pull requests must cite the affected IDs and preserve their
selectors or intentionally update the inventory, test, and this map together.

| Behavior ID | Behavior | Exact test case | Fixture / builder |
|---|---|---|---|
| `CLI-MODE-HELP-01` | Help modes | `tests/baseline/cli-parity.test.js::CLI-MODE-HELP-01 help modes` | — |
| `CLI-MODE-VERSION-01` | Version mode | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode` | — |
| `CLI-MODE-DEFAULT-01` | Default update mode | `tests/baseline/cli-parity.test.js::CLI-MODE-DEFAULT-01 no arguments dispatch update` | — |
| `CLI-COMMANDS-01` | Eight subcommands and argument pass-through | `tests/baseline/cli-parity.test.js::CLI-COMMANDS-01 eight named commands dispatch` | — |
| `CLI-USAGE-01` | Usage errors and exit 2 | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `CLI-PREFLIGHT-01` | Command-specific preflight | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `CLI-CHILD-STATUS-01` | Delegated status propagation | `tests/baseline/cli-parity.test.js::CLI-CHILD-STATUS-01 delegated child status is preserved` | — |
| `CLI-ENV-REF-01` | Generic ref override and precedence | `tests/test_selection_state.sh::# BASELINE CASE: SEL-PRECEDENCE-REF-01 complete ref precedence` | — |
| `CLI-ENV-UPSTREAM-URL-01` | Source override and precedence | `tests/baseline/cli-parity.test.js::SEL-PRECEDENCE-SOURCE-01 source precedence is independent` | `tests/fixtures/baseline/selection/track-latest.json` |
| `CLI-ENV-CODEX-PREFLIGHT-01` | Codex executable launcher preflight | `tests/baseline/cli-parity.test.js::CLI-ENV-CODEX-PREFLIGHT-01 custom Codex command satisfies launcher preflight` | — |
| `CLI-ENV-CODEX-LISTING-01` | Codex executable listing use | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `CLI-ENV-CODEX-MUTATION-01` | Codex executable mutation use | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-MUTATION-01 install mutation uses Codex override` | — |
| `CLI-ENV-CACHE-DIR-01` | Cache default and override | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-CONFIG-DIR-01` | Explicit config location | `tests/test_selection_state.sh::# BASELINE CASE: SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `CLI-ENV-PLUGIN-ROOT-01` | Plugin-root default and override | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-MANIFEST-TEMPLATE-01` | Manifest-template default, override, and type gate | `tests/baseline/cli-parity.test.js::CLI-ENV-MANIFEST-TEMPLATE-01 fallback template bytes and non-file rejection` | — |
| `CLI-ENV-VALIDATOR-01` | Optional validator default and override | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-INSTALLED-ROOT-01` | Installed-root default and override | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `CLI-ENV-REFRESH-MODE-01` | Install-refresh default and validation | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-REFRESH-MODE-01 install refresh defaults and validation` | — |
| `CLI-ENV-XDG-CONFIG-01` | XDG config location | `tests/test_selection_state.sh::# BASELINE CASE: SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `CLI-ENV-HOME-01` | HOME config fallback | `tests/test_selection_state.sh::# BASELINE CASE: SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `CLI-ENV-PASSTHROUGH-01` | Whole-environment pass-through | `tests/baseline/cli-parity.test.js::CLI-ENV-01 ten SUPERPOWERS variables pass through` | — |
| `CLI-ENV-PREPARE-PATHS-01` | Relative prepare paths | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: CLI-ENV-PREPARE-PATHS-01 relative prepare paths use invocation cwd` | — |
| `CLI-ENV-INSTALLED-DEFAULTS-01` | Default Codex and installed root | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `SEL-LOCATION-01` | Selection location chain | `tests/test_selection_state.sh::# BASELINE CASE: SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `SEL-PRECEDENCE-REF-01` | Complete ref precedence | `tests/test_selection_state.sh::# BASELINE CASE: SEL-PRECEDENCE-REF-01 complete ref precedence` | — |
| `SEL-PRECEDENCE-SOURCE-01` | Independent source precedence | `tests/baseline/cli-parity.test.js::SEL-PRECEDENCE-SOURCE-01 source precedence is independent` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-PRECEDENCE-VALIDATE-01` | Validate before access | `tests/test_selection_state.sh::# BASELINE CASE: SEL-PRECEDENCE-VALIDATE-01 invalid saved state stops resolution` | — |
| `SEL-SCHEMA-MODES-01` | Selection modes and absent normalization | `tests/test_selection_state.py::test_read_normalizes_absent_pinned_and_track_latest` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-SCHEMA-KEYS-01` | Exact keys and version | `tests/test_selection_state.py::test_read_rejects_duplicate_unknown_missing_and_inconsistent_fields` | `tests/fixtures/baseline/selection/unknown-key.json` |
| `SEL-SCHEMA-REFS-01` | Tag and string refinement | `tests/test_selection_state.py::test_read_rejects_empty_multiline_and_invalid_ref_strings` | — |
| `SEL-SCHEMA-COMMIT-01` | Raw-commit cross-field equality | `tests/test_selection_state.py::test_raw_commit_requires_cross_field_equality` | — |
| `SEL-SCHEMA-COMMIT-WRITE-01` | Raw-commit writer normalization | `tests/test_selection_state.py::test_writer_normalizes_raw_commit_input_to_lowercase` | — |
| `SEL-SCHEMA-SOURCE-01` | Source validation and redaction | `tests/test_selection_state.py::test_source_validation_rejects_http_userinfo_only` | — |
| `SEL-BYTES-PINNED-01` | Canonical pinned bytes | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | `tests/fixtures/baseline/selection/pinned-tag.json` |
| `SEL-BYTES-TRACK-01` | Canonical track-latest bytes | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-BYTES-DIRECTORY-01` | New selection directory mode | `tests/test_selection_state.py::test_writer_creates_private_directory_and_canonical_private_file` | — |
| `SEL-BYTES-DIRECTORY-PRESERVE-01` | Existing selection directory mode | `tests/test_selection_state.py::test_writer_preserves_existing_directory_mode` | — |
| `REF-PINNABLE-01` | Pinnable public ref forms | `tests/baseline/cli-parity.test.js::CLI-PIN-REF-01 pin accepts exact tag or 40-hex commit only` | — |
| `REF-GENERIC-FALLBACK-01` | Arbitrary ref fallback | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-GENERIC-FALLBACK-01 arbitrary refs fall back after tag lookup` | — |
| `REF-LATEST-STABLE-01` | Latest stable tag selection | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-LATEST-STABLE-01 numeric stable release selection and peeling` | — |
| `REF-PIN-SOURCE-01` | Public pin source proof | `tests/test_selection_commands.sh::# BASELINE CASE: REF-PIN-SOURCE-01 exact tag and raw commit pins prove selected source` | — |
| `REF-SOURCE-PROOF-01` | Exact source proof | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-SOURCE-PROOF-01 selected source must supply a commit object` | — |
| `REF-CLEANUP-01` | Interrupted exact-fetch cleanup | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-CLEANUP-01 interrupted source proof cleans only its workspace` | — |
| `REF-PIN-CLEANUP-01` | Interrupted pin cleanup | `tests/test_selection_commands.sh::# BASELINE CASE: REF-PIN-CLEANUP-01 interrupted pin proof cleans only its workspace` | — |
| `PROVENANCE-BYTES-01` | Canonical tag and raw-commit provenance bytes | `tests/baseline/cli-parity.test.js::PROVENANCE-BYTES-01 prepare writes canonical provenance bytes` | `tests/fixtures/baseline/provenance/valid-commit.json` |
| `SEL-READER-DUPLICATES-01` | Selection duplicate keys | `tests/test_selection_state.py::test_read_rejects_duplicate_unknown_missing_and_inconsistent_fields` | `tests/fixtures/baseline/selection/duplicate-key.json` |
| `SEL-READER-CONSTANTS-01` | Selection constants | `tests/test_selection_state.py::test_read_rejects_non_object_constants_and_excessive_nesting` | `tests/fixtures/baseline/selection/non-standard-constant.json` |
| `SEL-READER-DEPTH-01` | Selection depth 256 | `tests/test_selection_state.py::test_read_enforces_exact_nesting_boundary` | `tests/fixtures/baseline/selection/depth-257.json` |
| `SEL-READER-BYTES-01` | Selection has no byte cap | `tests/test_selection_state.py::test_read_has_no_input_byte_limit` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-READER-PATHS-01` | Selection path types | `tests/test_selection_state.py::test_read_rejects_symlink_directory_and_fifo_paths` | — |
| `PROV-READER-STRICT-01` | Strict provenance profile | `tests/test_probe.sh::# BASELINE CASE: PROV-READER-STRICT-01 strict provenance reader profile` | `tests/fixtures/baseline/provenance/duplicate-key.json` |
| `PROV-READER-LENIENT-01` | Lenient provenance profile | `tests/test_probe.sh::# BASELINE CASE: PROV-READER-LENIENT-01 lenient commit reader profile` | `tests/fixtures/baseline/provenance/commit-7-hex.json` |
| `PROV-READER-CANDIDATE-01` | Candidate provenance validator profile | `tests/test_validate_generated_plugin.py::test_candidate_provenance_reader_profile` | `tests/fixtures/baseline/provenance/wrong-key-set.json` |
| `PROV-READER-CODEX-SOURCE-01` | Codex source-reader profile | `tests/test_adapter_protocol.sh::# BASELINE CASE: PROV-READER-CODEX-SOURCE-01 Codex source reader profile` | `tests/fixtures/baseline/provenance/non-standard-constant.json` |
| `PROV-READER-CODEX-COMMIT-01` | Codex commit-reader profile | `tests/test_codex_state_units.sh::# BASELINE CASE: PROV-READER-CODEX-COMMIT-01 installed metadata reader profile` | `tests/fixtures/baseline/provenance/commit-7-hex.json` |
| `MANIFEST-READER-INSTALLED-01` | Installed manifest profile | `tests/test_probe.sh::# BASELINE CASE: MANIFEST-READER-INSTALLED-01 installed generated manifest reader profile` | `tests/fixtures/baseline/manifests/installed-manager-version.json` |
| `MANIFEST-READER-UPSTREAM-01` | Upstream manifest profile | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-UPSTREAM-01 upstream manifest reader profile` | `tests/fixtures/baseline/manifests/upstream-no-hooks.json` |
| `MANIFEST-READER-MATERIALIZE-01` | Candidate materializer profile | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-MATERIALIZE-01 hook materializer profile` | `tests/fixtures/baseline/manifests/candidate-non-standard-constant.json` |
| `MANIFEST-READER-OVERLAY-01` | Candidate overlay profile | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-OVERLAY-01 manifest overlay profile` | `tests/fixtures/baseline/manifests/candidate-unknown-field.json` |
| `MANIFEST-READER-VALIDATOR-01` | Candidate validator profile | `tests/test_validate_generated_plugin.py::test_candidate_manifest_reader_profile` | `tests/fixtures/baseline/manifests/candidate-duplicate-key.json` |
| `CODEX-JSON-ARRAY-01` | Codex membership parser | `tests/test_codex_state_units.sh::# BASELINE CASE: CODEX-JSON-ARRAY-01 installed/listing parser profile` | — |
| `CODEX-JSON-MARKETPLACE-01` | Codex marketplace parser | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: CODEX-JSON-MARKETPLACE-01 marketplace-root parser profile` | — |
| `CODEX-JSON-VERSION-01` | Codex active-version parser | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: CODEX-JSON-VERSION-01 active-version parser profile` | — |
| `ADAPTER-PROTOCOL-01` | Protocol v1 operation results | `tests/test_adapter_protocol.py::test_build_and_uninstall_accept_exact_empty_results` | `tests/fixtures/baseline/adapter-responses/valid-build.json` |
| `ADAPTER-ENVELOPE-01` | Exact envelope and shapes | `tests/test_adapter_protocol.py::test_rejects_empty_malformed_non_object_and_extra_fields` | — |
| `ADAPTER-ENVELOPE-KEYS-01` | Required envelope keys | `tests/test_adapter_protocol.sh::# BASELINE CASE: ADAPTER-ENVELOPE-KEYS-01 missing envelope keys reject before replay` | — |
| `ADAPTER-ENVELOPE-TYPES-01` | Envelope types and invocation views | `tests/test_adapter_protocol.py::test_rejects_wrong_protocol_operation_types_and_views` | — |
| `ADAPTER-FINGERPRINT-01` | Fingerprint result | `tests/test_adapter_protocol.py::test_inspect_fingerprint_accepts_full_sha_short_sha_and_null` | `tests/fixtures/baseline/adapter-responses/valid-inspect-fingerprint.json` |
| `ADAPTER-FINGERPRINT-REJECT-01` | Invalid fingerprint results | `tests/test_adapter_protocol.py::test_rejects_invalid_fingerprint_and_result_schema_keys` | — |
| `ADAPTER-UPDATE-CONTROL-01` | Update-control result | `tests/test_adapter_protocol.py::test_inspect_update_control_accepts_only_exact_allowed_values` | `tests/fixtures/baseline/adapter-responses/valid-inspect-update-control.json` |
| `ADAPTER-OWNERSHIP-01` | Ownership result | `tests/test_adapter_protocol.py::test_inspect_ownership_accepts_all_consistent_identity_states` | `tests/fixtures/baseline/adapter-responses/valid-inspect-ownership.json` |
| `ADAPTER-OWNERSHIP-REJECT-01` | Invalid ownership results | `tests/test_adapter_protocol.py::test_inspect_ownership_rejects_old_malformed_and_inconsistent_results` | — |
| `ADAPTER-INSTALL-RESULT-01` | Install verification hints | `tests/test_adapter_protocol.py::test_install_accepts_empty_one_and_both_verification_hints` | `tests/fixtures/baseline/adapter-responses/valid-install.json` |
| `ADAPTER-INSTALL-REJECT-01` | Invalid install verification hints | `tests/test_adapter_protocol.py::test_rejects_invalid_fingerprint_and_result_schema_keys` | — |
| `ADAPTER-STATUS-01` | Exit and envelope cross-rules | `tests/test_adapter_protocol.py::test_rejects_exit_envelope_mismatches_and_null_cross_rules` | — |
| `ADAPTER-REPLAY-01` | Ordered channel replay | `tests/test_adapter_protocol.py::test_messages_replay_by_channel_in_order` | — |
| `ADAPTER-CONTROLLED-FAILURE-01` | Controlled failure replay | `tests/test_adapter_protocol.py::test_controlled_failure_replays_messages_error_and_hints` | `tests/fixtures/baseline/adapter-responses/controlled-failure.json` |
| `ADAPTER-TERMINAL-01` | Terminal control rejection | `tests/test_adapter_protocol.py::test_rejects_terminal_controls_in_terminal_facing_protocol_strings` | — |
| `ADAPTER-TERMINAL-SHAPE-01` | Nonempty single-line terminal strings | `tests/test_adapter_protocol.py::test_rejects_wrong_protocol_operation_types_and_views` | — |
| `ADAPTER-SURROGATE-01` | Surrogate rejection | `tests/test_adapter_protocol.py::test_rejects_surrogate_escapes_in_terminal_facing_protocol_strings` | — |
| `ADAPTER-READER-BYTES-01` | Inclusive 1 MiB boundary | `tests/test_adapter_protocol.py::test_enforces_inclusive_response_size_boundary_before_replay` | `tests/fixtures/baseline/adapter-responses/size-1048576.json` |
| `ADAPTER-READER-UTF8-01` | UTF-8 byte counting | `tests/test_adapter_protocol.py::test_response_size_limit_counts_utf8_bytes_before_replay` | — |
| `ADAPTER-READER-CONSTANTS-01` | Adapter constants | `tests/test_adapter_protocol.py::test_rejects_non_standard_json_constants_without_replay` | `tests/fixtures/baseline/adapter-responses/non-standard-constant.json` |
| `ADAPTER-READER-DEPTH-01` | Adapter depth 64 | `tests/test_adapter_protocol.py::test_enforces_exact_json_nesting_boundary` | `tests/fixtures/baseline/adapter-responses/depth-64.json` |
| `ADAPTER-READER-DUPLICATES-01` | Adapter duplicate keys | `tests/test_adapter_protocol.py::test_rejects_duplicate_object_keys_recursively_without_replay` | `tests/fixtures/baseline/adapter-responses/duplicate-key.json` |
| `GENERATED-LAYOUT-01` | Canonical generated layout | `tests/baseline/cli-parity.test.js::PREPARE-TREE-01 prepare creates the canonical generated tree` | `tests/fixtures/baseline/generated-tree/no-hooks.txt` |
| `GENERATED-UNKNOWN-FIELDS-01` | Preserve unknown manifest fields | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DECLARED-01 declared path and inline hook forms` | `tests/fixtures/baseline/manifests/upstream-active-hooks.json` |
| `GENERATED-WRONG-NAME-01` | Reject wrong upstream name | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-WRONG-NAME-01 wrong upstream name is rejected` | — |
| `GENERATED-FALLBACK-01` | Manifest-less fallback form | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-FALLBACK-01 manifest-less upstream uses manager fallback` | — |
| `GENERATED-HOOKS-FORBID-01` | Hook-free policies | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-FORBID-01 explicit empty and fallback stay hook-free` | `tests/fixtures/baseline/manifests/upstream-empty-hooks.json` |
| `GENERATED-HOOKS-DEFAULT-01` | Default hook discovery | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DEFAULT-01 absent and empty-array default discovery` | `tests/fixtures/baseline/manifests/upstream-default-hooks.json` |
| `GENERATED-HOOKS-DECLARED-01` | Active declared hooks | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DECLARED-01 declared path and inline hook forms` | `tests/fixtures/baseline/generated-tree/declared-hooks.txt` |
| `FS-ATOMIC-01` | Atomic prepare activation | `tests/baseline/cli-parity.test.js::FS-ATOMIC-01 failed prepare preserves the previous generated tree` | `tests/builders/baseline-scenario.sh` |
| `FS-ATOMIC-SWAP-01` | Failed activation restoration | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: FS-ATOMIC-SWAP-01 failed activation restores the prior tree` | — |
| `FS-CLEANUP-01` | Invocation-scoped cleanup | `tests/baseline/cli-parity.test.js::FS-CLEANUP-01 interrupted state cleanup is invocation-scoped` | `tests/builders/baseline-scenario.sh` |
| `FS-SYMLINK-01` | Hook containment and symlinks | `tests/baseline/cli-parity.test.js::FS-SYMLINK-01 escaping and broken symlinks fail closed` | `tests/builders/baseline-scenario.sh` |
| `FS-HOOK-CONTAINMENT-01` | Declared hook containment | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: FS-HOOK-CONTAINMENT-01 unsafe hook paths and symlinks fail closed` | — |
| `FS-SELECTION-ATOMIC-01` | Atomic selection writer | `tests/test_selection_state.py::test_failed_replace_cleans_only_own_temporary_file` | — |
| `FS-SELECTION-CONCURRENT-01` | Concurrent selection writers | `tests/test_selection_state.py::test_two_concurrent_writers_leave_one_complete_valid_record` | — |
| `FS-SELECTION-POST-REPLACE-01` | Truthful post-replace failure | `tests/test_selection_state.py::test_post_replace_failure_truthfully_reports_final_mode` | — |
| `FS-SELECTION-TYPES-01` | Selection writer path types | `tests/test_selection_state.py::test_writer_rejects_unexpected_state_and_parent_path_types` | — |
| `FS-SELECTION-UNPIN-TYPES-01` | Unpin path types | `tests/test_selection_commands.sh::# BASELINE CASE: FS-SELECTION-UNPIN-TYPES-01 unpin rejects unsafe path types` | — |
| `SEL-READER-PARENT-01` | Symlinked selection parent | `tests/test_selection_state.py::test_read_rejects_absent_state_below_symlinked_config_directory` | — |
| `PREPARE-VALIDATE-01` | Validate before activation | `tests/baseline/cli-parity.test.js::PREPARE-VALIDATE-01 validation completes before activation` | `tests/builders/baseline-scenario.sh` |
| `PREPARE-DETERMINISTIC-01` | Deterministic prepare output | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DEFAULT-01 absent and empty-array default discovery` | `tests/fixtures/baseline/generated-tree/default-hooks.txt` |
| `PROBE-READONLY-01` | Read-only probe | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | `tests/builders/baseline-scenario.sh` |
| `PROBE-FAIL-CLOSED-01` | Probe fails closed | `tests/test_probe.sh::# BASELINE CASE: PROBE-FAIL-CLOSED-01 invalid selection and adapter evidence fail closed` | — |
| `INSTALL-ORDER-01` | Install ordering | `tests/baseline/cli-parity.test.js::INSTALL-ORDER-01 install prepares and validates before adapter mutation` | `tests/builders/baseline-scenario.sh` |
| `INSTALL-LEGACY-01` | Legacy state install gate | `tests/baseline/cli-parity.test.js::LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed` | `tests/builders/baseline-scenario.sh` |
| `INSTALL-VERIFY-01` | Installed fingerprint verification | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: INSTALL-VERIFY-01 installed fingerprint proof and hints` | — |
| `UPDATE-CONTROL-01` | Managed update control | `tests/baseline/cli-parity.test.js::UPDATE-CONTROL-01 update requires current managed control evidence` | `tests/fixtures/baseline/bin/stateful-adapter` |
| `UNINSTALL-OWNERSHIP-01` | Manager-only uninstall | `tests/baseline/cli-parity.test.js::UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources` | `tests/fixtures/baseline/bin/stateful-adapter` |
| `UNINSTALL-TARGETS-01` | Exact manager removal targets | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: UNINSTALL-TARGETS-01 adapter removes only manager resources` | — |
| `UNINSTALL-VERIFY-01` | Uninstall verification | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: UNINSTALL-VERIFY-01 both manager resources must be absent` | — |
| `DIAG-INTENTIONAL-01` | Frozen actionable diagnostics | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `DIAG-PREFLIGHT-01` | Exact public preflight diagnostics | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `DIAG-SELECTION-PIN-01` | Pin success diagnostic | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | — |
| `DIAG-SELECTION-TRACK-01` | Track-latest success diagnostic | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | — |
| `DIAG-SELECTION-UNPIN-01` | Unpin success diagnostic | `tests/baseline/cli-parity.test.js::SEL-UNPIN-01 unpin removes saved intent without applying changes` | — |
| `DIAG-PROBE-01` | Probe porcelain fields | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | — |
| `DIAG-ADAPTER-01` | Adapter stream and order diagnostics | `tests/test_adapter_protocol.py::test_messages_replay_by_channel_in_order` | — |
| `PACKAGE-REPO-01` | Repo/copy entrypoint | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode` | — |
| `PACKAGE-TARBALL-01` | Offline installed tarball entrypoint | `tests/baseline/packaged-cli.test.js::PACKAGE-CLI-01 offline installed tarball exposes help and version` | — |
