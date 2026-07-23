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
| `CLI-MODE-VERSION-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode` | — |
| `CLI-MODE-DEFAULT-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-DEFAULT-01 no arguments dispatch update` | — |
| `CLI-COMMANDS-01` | `tests/baseline/cli-parity.test.js::CLI-COMMANDS-01 eight named commands dispatch` | — |
| `CLI-USAGE-01` | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `CLI-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `CLI-CHILD-STATUS-01` | `tests/baseline/cli-parity.test.js::CLI-CHILD-STATUS-01 delegated child status is preserved` | — |
| `CLI-ENV-CODEX-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-CODEX-PREFLIGHT-01 custom Codex command satisfies launcher preflight` | — |
| `CLI-ENV-CODEX-LISTING-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `CLI-ENV-CODEX-MUTATION-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-MUTATION-01 install mutation uses Codex override` | — |
| `CLI-ENV-CACHE-DIR-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-PLUGIN-ROOT-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-MANIFEST-TEMPLATE-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-MANIFEST-TEMPLATE-01 fallback template bytes and non-file rejection` | — |
| `CLI-ENV-VALIDATOR-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-PREPARE-01 public prepare path defaults and overrides` | — |
| `CLI-ENV-INSTALLED-ROOT-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `CLI-ENV-REFRESH-MODE-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-REFRESH-MODE-01 install refresh defaults and validation` | — |
| `CLI-ENV-PASSTHROUGH-01` | `tests/baseline/cli-parity.test.js::CLI-ENV-01 ten SUPERPOWERS variables pass through` | — |
| `CLI-ENV-PREPARE-PATHS-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: CLI-ENV-PREPARE-PATHS-01 relative prepare paths use invocation cwd` | — |
| `CLI-ENV-INSTALLED-DEFAULTS-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: CLI-ENV-CODEX-LISTING-01 fingerprint listing uses override and default command` | — |
| `SEL-LOCATION-01` | `tests/test_selection_state.sh::# BASELINE CASE: SEL-LOCATION-01 selection location chain and fail-closed bases` | — |
| `SEL-PRECEDENCE-REF-01` | `tests/test_selection_state.sh::# BASELINE CASE: SEL-PRECEDENCE-REF-01 complete ref precedence` | — |
| `SEL-PRECEDENCE-SOURCE-01` | `tests/baseline/cli-parity.test.js::SEL-PRECEDENCE-SOURCE-01 source precedence is independent` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-PRECEDENCE-VALIDATE-01` | `tests/test_selection_state.sh::# BASELINE CASE: SEL-PRECEDENCE-VALIDATE-01 invalid saved state stops resolution` | — |
| `SEL-SCHEMA-MODES-01` | `tests/test_selection_state.py::test_read_normalizes_absent_pinned_and_track_latest` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-SCHEMA-KEYS-01` | `tests/test_selection_state.py::test_read_rejects_duplicate_unknown_missing_and_inconsistent_fields` | `tests/fixtures/baseline/selection/unknown-key.json` |
| `SEL-SCHEMA-REFS-01` | `tests/test_selection_state.py::test_read_rejects_empty_multiline_and_invalid_ref_strings` | — |
| `SEL-SCHEMA-COMMIT-01` | `tests/test_selection_state.py::test_raw_commit_requires_cross_field_equality` | — |
| `SEL-SCHEMA-COMMIT-WRITE-01` | `tests/test_selection_state.py::test_writer_normalizes_raw_commit_input_to_lowercase` | — |
| `SEL-SCHEMA-SOURCE-01` | `tests/test_selection_state.py::test_source_validation_rejects_http_userinfo_only` | — |
| `SEL-BYTES-PINNED-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | `tests/fixtures/baseline/selection/pinned-tag.json` |
| `SEL-BYTES-TRACK-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-BYTES-DIRECTORY-01` | `tests/test_selection_state.py::test_writer_creates_private_directory_and_canonical_private_file` | — |
| `SEL-BYTES-DIRECTORY-PRESERVE-01` | `tests/test_selection_state.py::test_writer_preserves_existing_directory_mode` | — |
| `REF-PINNABLE-01` | `tests/baseline/cli-parity.test.js::CLI-PIN-REF-01 pin accepts exact tag or 40-hex commit only` | — |
| `REF-GENERIC-FALLBACK-01` | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-GENERIC-FALLBACK-01 arbitrary refs fall back after tag lookup` | — |
| `REF-LATEST-STABLE-01` | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-LATEST-STABLE-01 numeric stable release selection and peeling` | — |
| `REF-PIN-SOURCE-01` | `tests/test_selection_commands.sh::# BASELINE CASE: REF-PIN-SOURCE-01 exact tag and raw commit pins prove selected source` | — |
| `REF-SOURCE-PROOF-01` | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-SOURCE-PROOF-01 selected source must supply a commit object` | — |
| `REF-CLEANUP-01` | `tests/test_ref_resolution.sh::# BASELINE CASE: REF-CLEANUP-01 interrupted source proof cleans only its workspace` | — |
| `REF-PIN-CLEANUP-01` | `tests/test_selection_commands.sh::# BASELINE CASE: REF-PIN-CLEANUP-01 interrupted pin proof cleans only its workspace` | — |
| `PROVENANCE-BYTES-01` | `tests/baseline/cli-parity.test.js::PROVENANCE-BYTES-01 prepare writes canonical provenance bytes` | `tests/fixtures/baseline/provenance/valid-commit.json` |
| `SEL-READER-DUPLICATES-01` | `tests/test_selection_state.py::test_read_rejects_duplicate_unknown_missing_and_inconsistent_fields` | `tests/fixtures/baseline/selection/duplicate-key.json` |
| `SEL-READER-CONSTANTS-01` | `tests/test_selection_state.py::test_read_rejects_non_object_and_constants` | `tests/fixtures/baseline/selection/non-standard-constant.json` |
| `SEL-READER-DEPTH-01` | `tests/test_selection_state.py::test_read_enforces_exact_nesting_boundary` | `tests/fixtures/baseline/selection/depth-257.json` |
| `SEL-READER-BYTES-01` | `tests/test_selection_state.py::test_read_has_no_input_byte_limit` | `tests/fixtures/baseline/selection/track-latest.json` |
| `SEL-READER-PATHS-01` | `tests/test_selection_state.py::test_read_rejects_symlink_directory_and_fifo_paths` | — |
| `PROV-READER-STRICT-01` | `tests/test_probe.sh::# BASELINE CASE: PROV-READER-STRICT-01 strict provenance reader profile` | `tests/fixtures/baseline/provenance/duplicate-key.json` |
| `PROV-READER-LENIENT-01` | `tests/test_probe.sh::# BASELINE CASE: PROV-READER-LENIENT-01 lenient commit reader profile` | `tests/fixtures/baseline/provenance/commit-7-hex.json` |
| `PROV-READER-CANDIDATE-01` | `tests/test_validate_generated_plugin.py::test_candidate_provenance_reader_profile` | `tests/fixtures/baseline/provenance/wrong-key-set.json` |
| `PROV-READER-CODEX-SOURCE-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: PROV-READER-CODEX-SOURCE-01 Codex source reader profile` | `tests/fixtures/baseline/provenance/non-standard-constant.json` |
| `PROV-READER-CODEX-COMMIT-01` | `tests/test_codex_state_units.sh::# BASELINE CASE: PROV-READER-CODEX-COMMIT-01 installed metadata reader profile` | `tests/fixtures/baseline/provenance/commit-7-hex.json` |
| `MANIFEST-READER-INSTALLED-01` | `tests/test_probe.sh::# BASELINE CASE: MANIFEST-READER-INSTALLED-01 installed generated manifest reader profile` | `tests/fixtures/baseline/manifests/installed-manager-version.json` |
| `MANIFEST-READER-UPSTREAM-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-UPSTREAM-01 upstream manifest reader profile` | `tests/fixtures/baseline/manifests/upstream-no-hooks.json` |
| `MANIFEST-READER-MATERIALIZE-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-MATERIALIZE-01 hook materializer profile` | `tests/fixtures/baseline/manifests/candidate-non-standard-constant.json` |
| `MANIFEST-READER-OVERLAY-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: MANIFEST-READER-OVERLAY-01 manifest overlay profile` | `tests/fixtures/baseline/manifests/candidate-unknown-field.json` |
| `MANIFEST-READER-VALIDATOR-01` | `tests/test_validate_generated_plugin.py::test_candidate_manifest_reader_profile` | `tests/fixtures/baseline/manifests/candidate-duplicate-key.json` |
| `CODEX-JSON-ARRAY-01` | `tests/test_codex_state_units.sh::# BASELINE CASE: CODEX-JSON-ARRAY-01 installed/listing parser profile` | — |
| `CODEX-JSON-MARKETPLACE-01` | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: CODEX-JSON-MARKETPLACE-01 marketplace-root parser profile` | — |
| `CODEX-JSON-VERSION-01` | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: CODEX-JSON-VERSION-01 active-version parser profile` | — |
| `ADAPTER-PROTOCOL-01` | `tests/test_adapter_protocol.py::test_build_and_uninstall_accept_exact_empty_results` | `tests/fixtures/baseline/adapter-responses/valid-build.json` |
| `ADAPTER-ENVELOPE-01` | `tests/test_adapter_protocol.py::test_rejects_empty_malformed_non_object_and_extra_fields` | — |
| `ADAPTER-ENVELOPE-KEYS-01` | `tests/test_adapter_protocol.sh::# BASELINE CASE: ADAPTER-ENVELOPE-KEYS-01 missing envelope keys reject before replay` | — |
| `ADAPTER-ENVELOPE-TYPES-01` | `tests/test_adapter_protocol.py::test_rejects_wrong_protocol_operation_types_and_views` | — |
| `ADAPTER-FINGERPRINT-01` | `tests/test_adapter_protocol.py::test_inspect_fingerprint_accepts_full_sha_short_sha_and_null` | `tests/fixtures/baseline/adapter-responses/valid-inspect-fingerprint.json` |
| `ADAPTER-FINGERPRINT-REJECT-01` | `tests/test_adapter_protocol.py::test_rejects_invalid_fingerprint_and_result_schema_keys` | — |
| `ADAPTER-UPDATE-CONTROL-01` | `tests/test_adapter_protocol.py::test_inspect_update_control_accepts_only_exact_allowed_values` | `tests/fixtures/baseline/adapter-responses/valid-inspect-update-control.json` |
| `ADAPTER-OWNERSHIP-01` | `tests/test_adapter_protocol.py::test_inspect_ownership_accepts_all_consistent_identity_states` | `tests/fixtures/baseline/adapter-responses/valid-inspect-ownership.json` |
| `ADAPTER-OWNERSHIP-REJECT-01` | `tests/test_adapter_protocol.py::test_inspect_ownership_rejects_old_malformed_and_inconsistent_results` | — |
| `ADAPTER-INSTALL-RESULT-01` | `tests/test_adapter_protocol.py::test_install_accepts_empty_one_and_both_verification_hints` | `tests/fixtures/baseline/adapter-responses/valid-install.json` |
| `ADAPTER-INSTALL-REJECT-01` | `tests/test_adapter_protocol.py::test_rejects_invalid_fingerprint_and_result_schema_keys` | — |
| `ADAPTER-STATUS-01` | `tests/test_adapter_protocol.py::test_rejects_exit_envelope_mismatches_and_null_cross_rules` | — |
| `ADAPTER-REPLAY-01` | `tests/test_adapter_protocol.py::test_messages_replay_by_channel_in_order` | — |
| `ADAPTER-CONTROLLED-FAILURE-01` | `tests/test_adapter_protocol.py::test_controlled_failure_replays_messages_error_and_hints` | `tests/fixtures/baseline/adapter-responses/controlled-failure.json` |
| `ADAPTER-TERMINAL-01` | `tests/test_adapter_protocol.py::test_rejects_terminal_controls_in_terminal_facing_protocol_strings` | — |
| `ADAPTER-TERMINAL-SHAPE-01` | `tests/test_adapter_protocol.py::test_rejects_wrong_protocol_operation_types_and_views` | — |
| `ADAPTER-SURROGATE-01` | `tests/test_adapter_protocol.py::test_rejects_surrogate_escapes_in_terminal_facing_protocol_strings` | — |
| `ADAPTER-READER-BYTES-01` | `tests/test_adapter_protocol.py::test_enforces_inclusive_response_size_boundary_before_replay` | `tests/fixtures/baseline/adapter-responses/size-1048576.json` |
| `ADAPTER-READER-UTF8-01` | `tests/test_adapter_protocol.py::test_response_size_limit_counts_utf8_bytes_before_replay` | — |
| `ADAPTER-READER-CONSTANTS-01` | `tests/test_adapter_protocol.py::test_rejects_non_standard_json_constants_without_replay` | `tests/fixtures/baseline/adapter-responses/non-standard-constant.json` |
| `ADAPTER-READER-DEPTH-01` | `tests/test_adapter_protocol.py::test_enforces_exact_json_nesting_boundary` | `tests/fixtures/baseline/adapter-responses/depth-64.json` |
| `ADAPTER-READER-DUPLICATES-01` | `tests/test_adapter_protocol.py::test_rejects_duplicate_object_keys_recursively_without_replay` | `tests/fixtures/baseline/adapter-responses/duplicate-key.json` |
| `GENERATED-LAYOUT-01` | `tests/baseline/cli-parity.test.js::PREPARE-TREE-01 prepare creates the canonical generated tree` | `tests/fixtures/baseline/generated-tree/no-hooks.txt` |
| `GENERATED-UNKNOWN-FIELDS-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DECLARED-01 declared path and inline hook forms` | `tests/fixtures/baseline/manifests/upstream-active-hooks.json` |
| `GENERATED-WRONG-NAME-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-WRONG-NAME-01 wrong upstream name is rejected` | — |
| `GENERATED-FALLBACK-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-FALLBACK-01 manifest-less upstream uses manager fallback` | — |
| `GENERATED-HOOKS-FORBID-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-FORBID-01 explicit empty and fallback stay hook-free` | `tests/fixtures/baseline/manifests/upstream-empty-hooks.json` |
| `GENERATED-HOOKS-DEFAULT-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DEFAULT-01 absent and empty-array default discovery` | `tests/fixtures/baseline/manifests/upstream-default-hooks.json` |
| `GENERATED-HOOKS-DEFAULT-LAYOUT-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DEFAULT-01 absent and empty-array default discovery` | `tests/fixtures/baseline/generated-tree/default-hooks.txt` |
| `GENERATED-HOOKS-DECLARED-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: GENERATED-HOOKS-DECLARED-01 declared path and inline hook forms` | `tests/fixtures/baseline/generated-tree/declared-hooks.txt` |
| `FS-ATOMIC-01` | `tests/baseline/cli-parity.test.js::FS-ATOMIC-01 failed prepare preserves the previous generated tree` | `tests/builders/baseline-scenario.sh` |
| `FS-ATOMIC-SWAP-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: FS-ATOMIC-SWAP-01 failed activation restores the prior tree` | — |
| `FS-CLEANUP-01` | `tests/baseline/cli-parity.test.js::FS-CLEANUP-01 interrupted state cleanup is invocation-scoped` | `tests/builders/baseline-scenario.sh` |
| `FS-SYMLINK-01` | `tests/baseline/cli-parity.test.js::FS-SYMLINK-01 escaping and broken symlinks fail closed` | `tests/builders/baseline-scenario.sh` |
| `FS-HOOK-CONTAINMENT-01` | `tests/test_prepare_with_fake_upstream.sh::# BASELINE CASE: FS-HOOK-CONTAINMENT-01 unsafe hook paths and symlinks fail closed` | — |
| `FS-SELECTION-ATOMIC-01` | `tests/test_selection_state.py::test_failed_replace_cleans_only_own_temporary_file` | — |
| `FS-SELECTION-CONCURRENT-01` | `tests/test_selection_state.py::test_two_concurrent_writers_leave_one_complete_valid_record` | — |
| `FS-SELECTION-POST-REPLACE-01` | `tests/test_selection_state.py::test_post_replace_failure_truthfully_reports_final_mode` | — |
| `FS-SELECTION-TYPES-01` | `tests/test_selection_state.py::test_writer_rejects_unexpected_state_and_parent_path_types` | — |
| `FS-SELECTION-UNPIN-TYPES-01` | `tests/test_selection_commands.sh::# BASELINE CASE: FS-SELECTION-UNPIN-TYPES-01 unpin rejects unsafe path types` | — |
| `SEL-READER-PARENT-01` | `tests/test_selection_state.py::test_read_rejects_absent_state_below_symlinked_config_directory` | — |
| `PREPARE-VALIDATE-01` | `tests/baseline/cli-parity.test.js::PREPARE-VALIDATE-01 validation completes before activation` | `tests/builders/baseline-scenario.sh` |
| `PREPARE-DETERMINISTIC-01` | `tests/baseline/cli-parity.test.js::PREPARE-TREE-01 prepare creates the canonical generated tree` | `tests/fixtures/baseline/generated-tree/no-hooks.txt` |
| `PROBE-READONLY-01` | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | `tests/builders/baseline-scenario.sh` |
| `PROBE-FAIL-CLOSED-01` | `tests/test_probe.sh::# BASELINE CASE: PROBE-FAIL-CLOSED-01 invalid selection and adapter evidence fail closed` | — |
| `INSTALL-ORDER-01` | `tests/baseline/cli-parity.test.js::INSTALL-ORDER-01 install prepares and validates before adapter mutation` | `tests/builders/baseline-scenario.sh` |
| `INSTALL-LEGACY-01` | `tests/baseline/cli-parity.test.js::LIFECYCLE-INTERRUPT-01 interrupted installation state fails closed` | `tests/builders/baseline-scenario.sh` |
| `INSTALL-VERIFY-01` | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: INSTALL-VERIFY-01 installed fingerprint proof and hints` | — |
| `UPDATE-CONTROL-01` | `tests/baseline/cli-parity.test.js::UPDATE-CONTROL-01 update requires current managed control evidence` | `tests/fixtures/baseline/bin/stateful-adapter` |
| `UNINSTALL-OWNERSHIP-01` | `tests/baseline/cli-parity.test.js::UNINSTALL-OWNERSHIP-01 uninstall removes only manager-owned resources` | `tests/fixtures/baseline/bin/stateful-adapter` |
| `UNINSTALL-TARGETS-01` | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: UNINSTALL-TARGETS-01 adapter removes only manager resources` | — |
| `UNINSTALL-VERIFY-01` | `tests/test_marketplace_reconcile.sh::# BASELINE CASE: UNINSTALL-VERIFY-01 both manager resources must be absent` | — |
| `DIAG-INTENTIONAL-01` | `tests/baseline/cli-parity.test.js::CLI-USAGE-01 invalid command and stray flag fail with exit 2` | — |
| `DIAG-PREFLIGHT-01` | `tests/baseline/cli-parity.test.js::CLI-PREFLIGHT-01 missing tools fail before dispatch` | — |
| `DIAG-SELECTION-PIN-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-PINNED-01 pin writes canonical selection bytes` | — |
| `DIAG-SELECTION-TRACK-01` | `tests/baseline/cli-parity.test.js::SEL-BYTES-TRACK-01 track-latest writes canonical selection bytes` | — |
| `DIAG-SELECTION-UNPIN-01` | `tests/baseline/cli-parity.test.js::SEL-UNPIN-01 unpin removes saved intent without applying changes` | — |
| `DIAG-PROBE-01` | `tests/baseline/cli-parity.test.js::PROBE-READONLY-01 probe is read-only` | — |
| `DIAG-ADAPTER-01` | `tests/test_adapter_protocol.py::test_messages_replay_by_channel_in_order` | — |
| `PACKAGE-REPO-01` | `tests/baseline/cli-parity.test.js::CLI-MODE-VERSION-01 version mode` | — |
| `PACKAGE-TARBALL-01` | `tests/baseline/packaged-cli.test.js::PACKAGE-CLI-01 offline installed tarball exposes help and version` | — |
