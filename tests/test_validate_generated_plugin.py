#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts/adapters/codex/validate-generated-plugin.py"
FIXTURES = ROOT / "tests" / "fixtures" / "baseline"
MANIFESTS = FIXTURES / "manifests"
PROVENANCE = FIXTURES / "provenance"
COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99"
SOURCE = "https://example.invalid/superpowers.git"


class ValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.plugin = Path(self.tempdir.name) / "plugin"
        self.manifest_source = "upstream"
        self.expected = {
            "source": SOURCE,
            "requested_ref": "latest-release",
            "resolved_ref": "v6.1.1",
            "commit": COMMIT,
            "manifest_version": "6.1.1+manager.d884ae0",
            "upstream_manifest_version": "6.1.1",
        }
        self.reset_candidate()

    def reset_candidate(self) -> None:
        shutil.rmtree(self.plugin, ignore_errors=True)
        (self.plugin / ".codex-plugin").mkdir(parents=True)
        (self.plugin / "skills" / "brainstorming").mkdir(parents=True)
        (self.plugin / "assets").mkdir()
        for name in ("LICENSE", "README.md", "CODE_OF_CONDUCT.md"):
            (self.plugin / name).write_text(name + "\n", encoding="utf-8")
        (self.plugin / ".codex-plugin" / "plugin.template.json").write_text(
            "{}\n", encoding="utf-8"
        )
        (self.plugin / "skills" / "brainstorming" / "SKILL.md").write_text(
            "---\nname: brainstorming\ndescription: Fake skill\n---\n# Body\n",
            encoding="utf-8",
        )
        (self.plugin / "assets" / "logo.svg").write_text("svg\n", encoding="utf-8")
        shutil.copyfile(
            MANIFESTS / "candidate-unknown-field.json",
            self.plugin / ".codex-plugin" / "plugin.json",
        )
        self.write_metadata()

    def write_manifest(self, value: Any) -> None:
        (self.plugin / ".codex-plugin" / "plugin.json").write_text(
            json.dumps(value) + "\n", encoding="utf-8"
        )

    def read_manifest(self) -> dict[str, Any]:
        return json.loads(
            (self.plugin / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )

    def write_hook_file(self, relative: str = "hooks/hooks-codex.json") -> None:
        path = self.plugin / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"hooks":{}}\n', encoding="utf-8")

    def set_hooks(self, value: Any) -> None:
        manifest = self.read_manifest()
        manifest["hooks"] = value
        self.write_manifest(manifest)

    def write_metadata(self, value: Any | None = None) -> None:
        if value is None:
            shutil.copyfile(
                PROVENANCE / "valid-tag.json",
                self.plugin / ".superpowers-upstream.json",
            )
            return
        (self.plugin / ".superpowers-upstream.json").write_text(
            json.dumps(value) + "\n", encoding="utf-8"
        )

    def nested_value(self, containers: int) -> Any:
        value: Any = 0
        for _ in range(containers):
            value = [value]
        return value

    def run_validator(self) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            "-S",
            str(VALIDATOR),
            "--plugin-root",
            str(self.plugin),
            "--source",
            self.expected["source"],
            "--requested-ref",
            self.expected["requested_ref"],
            "--resolved-ref",
            self.expected["resolved_ref"],
            "--commit",
            self.expected["commit"],
            "--manifest-version",
            self.expected["manifest_version"],
            "--manifest-source",
            self.manifest_source,
            "--upstream-manifest-version",
            self.expected["upstream_manifest_version"],
        ]
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def assert_rejected(self, fragment: str) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def assert_rejected_all(self, *fragments: str) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for fragment in fragments:
            self.assertIn(fragment, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_manifest_source_rejects_invalid_choice_without_traceback(self) -> None:
        self.manifest_source = "invalid"
        result = self.run_validator()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("--manifest-source", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_valid_candidate_and_unknown_manifest_field_pass(self) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("generated plugin validation passed", result.stdout)

    def test_candidate_provenance_reader_profile(self) -> None:
        metadata_path = self.plugin / ".superpowers-upstream.json"

        # BASELINE CASE: PROV-READER-CANDIDATE-01 candidate provenance validator profile
        shutil.copyfile(PROVENANCE / "non-standard-constant.json", metadata_path)
        self.assert_rejected("provenance must contain valid JSON")

        self.reset_candidate()
        shutil.copyfile(FIXTURES / "selection" / "depth-257.json", metadata_path)
        self.assert_rejected("provenance exceeds maximum JSON nesting")

        self.reset_candidate()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        # The root object plus 255 arrays is the exact accepted depth 256.
        metadata["source"] = self.nested_value(255)
        self.write_metadata(metadata)
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(
            "provenance field `source` does not match expected value",
            result.stderr,
        )
        self.assertNotIn("exceeds maximum JSON nesting", result.stderr)

        self.reset_candidate()
        shutil.copyfile(PROVENANCE / "duplicate-key.json", metadata_path)
        self.assert_rejected("provenance field `source` does not match")

        self.reset_candidate()
        metadata_path.write_text(
            metadata_path.read_text(encoding="utf-8") + " " * (1_048_576 + 1),
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        self.reset_candidate()
        shutil.copyfile(PROVENANCE / "malformed.json", metadata_path)
        self.assert_rejected("provenance must contain valid JSON")

        self.reset_candidate()
        self.write_metadata([])
        self.assert_rejected("provenance must contain a JSON object")

        self.reset_candidate()
        shutil.copyfile(PROVENANCE / "wrong-key-set.json", metadata_path)
        self.assert_rejected("provenance keys do not match")

        mismatches = (
            ("source", "https://wrong.invalid/repo"),
            ("requested_ref", "v0.0.0"),
            ("resolved_ref", "v0.0.0"),
            ("commit", "0" * 40),
            ("upstream_manifest_version", "0.0.0"),
        )
        for field, value in mismatches:
            with self.subTest(mismatched=field):
                self.reset_candidate()
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata[field] = value
                self.write_metadata(metadata)
                self.assert_rejected(
                    f"provenance field `{field}` does not match expected value"
                )

        self.reset_candidate()
        shutil.copyfile(PROVENANCE / "commit-7-hex.json", metadata_path)
        self.expected["commit"] = "d884ae0"
        self.assert_rejected("commit must be 40 lowercase hexadecimal characters")

        self.reset_candidate()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["commit"] = "D" * 40
        self.write_metadata(metadata)
        self.expected["commit"] = "D" * 40
        self.assert_rejected("commit must be 40 lowercase hexadecimal characters")

    def test_candidate_manifest_reader_profile(self) -> None:
        manifest_path = self.plugin / ".codex-plugin" / "plugin.json"

        # BASELINE CASE: MANIFEST-READER-VALIDATOR-01 candidate validator profile
        shutil.copyfile(
            MANIFESTS / "candidate-non-standard-constant.json",
            manifest_path,
        )
        self.assert_rejected("plugin manifest must contain valid JSON")

        self.reset_candidate()
        shutil.copyfile(
            FIXTURES / "selection" / "depth-257.json",
            manifest_path,
        )
        self.assert_rejected("plugin manifest exceeds maximum JSON nesting")

        self.reset_candidate()
        manifest = self.read_manifest()
        # The root object plus 255 arrays is the exact accepted depth 256.
        manifest["x_future_manifest"] = self.nested_value(255)
        self.write_manifest(manifest)
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("generated plugin validation passed", result.stdout)

        self.reset_candidate()
        shutil.copyfile(
            MANIFESTS / "candidate-duplicate-key.json",
            manifest_path,
        )
        self.assert_rejected("field `name` must equal `superpowers`")

        self.reset_candidate()
        manifest_path.write_text(
            manifest_path.read_text(encoding="utf-8") + " " * (1_048_576 + 1),
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        self.reset_candidate()
        manifest_path.write_text("{bad", encoding="utf-8")
        self.assert_rejected("must contain valid JSON")

        self.reset_candidate()
        manifest_path.write_bytes(b"\xff")
        self.assert_rejected("plugin manifest is unreadable UTF-8")

        cases: tuple[tuple[str, Any, str], ...] = (
            ("non-object", [], "must contain a JSON object"),
            ("wrong-name", {"name": "renamed"}, "field `name` must equal `superpowers`"),
            ("wrong-version", {"version": "6.1.2"}, "must equal expected version"),
            ("bad-semver", {"version": "01.0.0"}, "must be SemVer 2.0.0"),
            ("empty-description", {"description": ""}, "field `description`"),
            ("wrong-skills", {"skills": "skills"}, "field `skills` must equal `./skills/`"),
        )
        for label, change, fragment in cases:
            with self.subTest(label=label):
                self.reset_candidate()
                if label == "non-object":
                    self.write_manifest(change)
                else:
                    manifest = self.read_manifest()
                    manifest.update(change)
                    self.write_manifest(manifest)
                self.assert_rejected(fragment)

        for field, fragment in (
            ("version", "field `version` must equal expected version"),
            ("description", "field `description` must be non-empty"),
        ):
            with self.subTest(missing=field):
                self.reset_candidate()
                manifest = self.read_manifest()
                manifest.pop(field)
                self.write_manifest(manifest)
                self.assert_rejected(fragment)

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["version"] = 611
        self.write_manifest(manifest)
        self.assert_rejected("field `version` must be SemVer 2.0.0")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["apps"] = "/absolute/.app.json"
        self.write_manifest(manifest)
        self.assert_rejected("field `apps` must be a relative path")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["interface"]["logo"] = "../outside.svg"
        self.write_manifest(manifest)
        self.assert_rejected("escapes the plugin root")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["interface"]["screenshots"] = ["./assets/missing.png"]
        self.write_manifest(manifest)
        self.assert_rejected("does not exist")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["interface"] = "not-an-object"
        self.write_manifest(manifest)
        self.assert_rejected("field `interface` must be an object")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["mcpServers"] = 17
        self.write_manifest(manifest)
        self.assert_rejected("field `mcpServers` must be a string or object")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["apps"] = 17
        self.write_manifest(manifest)
        self.assert_rejected("field `apps` must be a non-empty relative path")

        self.reset_candidate()
        manifest = self.read_manifest()
        manifest["interface"]["screenshots"] = "./assets/logo.svg"
        self.write_manifest(manifest)
        self.assert_rejected("field `interface.screenshots` must be an array")

        if hasattr(os, "symlink"):
            self.reset_candidate()
            outside = Path(self.tempdir.name) / "outside.svg"
            outside.write_text("outside\n", encoding="utf-8")
            (self.plugin / "assets" / "escape.svg").symlink_to(outside)
            manifest = self.read_manifest()
            manifest["interface"]["logo"] = "./assets/escape.svg"
            self.write_manifest(manifest)
            self.assert_rejected("escapes the plugin root")

    def test_full_semver_forms_pass(self) -> None:
        versions = (
            "6.1.1+manager.d884ae0",
            "6.1.0-beta.1+manager.d884ae0",
            "0.0.0-main+manager.d884ae0",
            "0.0.0-ref-feature-x+manager.d884ae0",
        )
        for version in versions:
            with self.subTest(version=version):
                self.reset_candidate()
                self.expected["manifest_version"] = version
                manifest = self.read_manifest()
                manifest["version"] = version
                self.write_manifest(manifest)
                result = self.run_validator()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_semver_rejects_unicode_digits(self) -> None:
        for version in ("1.1١.0", "1.0.0-١"):
            with self.subTest(version=version):
                self.reset_candidate()
                self.expected["manifest_version"] = version
                manifest = self.read_manifest()
                manifest["version"] = version
                self.write_manifest(manifest)
                self.assert_rejected("field `version` must be SemVer 2.0.0")

    def test_json_rejects_nonstandard_numeric_constants(self) -> None:
        manifest_path = self.plugin / ".codex-plugin" / "plugin.json"
        shutil.copyfile(MANIFESTS / "candidate-non-standard-constant.json", manifest_path)
        self.assert_rejected("plugin manifest must contain valid JSON")

        self.reset_candidate()
        metadata_path = self.plugin / ".superpowers-upstream.json"
        shutil.copyfile(PROVENANCE / "non-standard-constant.json", metadata_path)
        self.assert_rejected("provenance must contain valid JSON")

    def test_json_rejects_excessive_nesting_without_traceback(self) -> None:
        nested = "[" * 2000 + "0" + "]" * 2000
        manifest_path = self.plugin / ".codex-plugin" / "plugin.json"
        manifest_path.write_text(
            '{"name":"superpowers","version":"6.1.1+manager.d884ae0",'
            '"description":"Generated Superpowers","skills":"./skills/",'
            f'"x_future_manifest":{nested}}}\n',
            encoding="utf-8",
        )
        self.assert_rejected("plugin manifest exceeds maximum JSON nesting")

    def test_skill_enumeration_oserror_is_reported_deterministically(self) -> None:
        validate_tree = runpy.run_path(str(VALIDATOR))["validate_tree"]
        errors: list[str] = []
        with mock.patch.object(Path, "iterdir", side_effect=OSError("fixture error")):
            validate_tree(self.plugin, "forbid", errors)
        self.assertIn("skills directory could not be enumerated", errors)

    def test_required_tree_and_skill_structure_fail_closed(self) -> None:
        required = (
            ".codex-plugin/plugin.template.json",
            ".superpowers-upstream.json",
            "LICENSE",
            "README.md",
            "CODE_OF_CONDUCT.md",
        )
        for relative in required:
            with self.subTest(relative=relative):
                self.reset_candidate()
                (self.plugin / relative).unlink()
                self.assert_rejected(f"missing required file `{relative}`")

        self.reset_candidate()
        shutil.rmtree(self.plugin / "skills" / "brainstorming")
        self.assert_rejected("must contain at least one skill directory")

        self.reset_candidate()
        (self.plugin / "skills" / "brainstorming" / "SKILL.md").unlink()
        self.assert_rejected("missing `SKILL.md`")

        self.reset_candidate()
        (self.plugin / "skills" / "brainstorming" / "SKILL.md").write_text(
            "", encoding="utf-8"
        )
        self.assert_rejected("has empty `SKILL.md`")

        self.reset_candidate()
        (self.plugin / "skills" / "brainstorming" / "SKILL.md").write_bytes(b"\xff")
        self.assert_rejected("has unreadable UTF-8 `SKILL.md`")

        self.reset_candidate()
        (self.plugin / "hooks").mkdir()
        self.assert_rejected("default-discovered `hooks/` must contain `hooks/hooks.json`")

    def test_upstream_hook_shapes_are_accepted(self) -> None:
        cases: tuple[tuple[str, Any, tuple[str, ...]], ...] = (
            ("exact-empty-object", {}, ()),
            ("single-path", "./hooks/hooks-codex.json", ("hooks/hooks-codex.json",)),
            (
                "path-array",
                ["./hooks/first.json", "./hooks/second.json"],
                ("hooks/first.json", "hooks/second.json"),
            ),
            (
                "inline-object",
                {
                    "hooks": {
                        "SessionStart": [
                            {"hooks": [{"type": "prompt", "prompt": "opaque"}]}
                        ],
                        "Stop": [
                            {"hooks": [{"type": "agent", "agent": "opaque"}]}
                        ],
                    }
                },
                ("hooks/required-by-inline.json",),
            ),
            (
                "inline-object-array",
                [{"hooks": {}}, {"future": {"preserved": True}}],
                ("hooks/required-by-array.json",),
            ),
            ("empty-array", [], ("hooks/hooks.json",)),
        )
        for label, hooks, files in cases:
            with self.subTest(label=label):
                self.reset_candidate()
                self.set_hooks(hooks)
                for relative in files:
                    self.write_hook_file(relative)
                manifest = self.read_manifest()
                manifest["x_unknown_alongside_hooks"] = {"preserved": True}
                self.write_manifest(manifest)
                result = self.run_validator()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_hook_policy_is_source_sensitive_and_fail_closed(self) -> None:
        self.manifest_source = "fallback"
        self.set_hooks({"future": True})
        self.assert_rejected("fallback plugin manifest field `hooks` must be absent")

        self.reset_candidate()
        self.manifest_source = "fallback"
        self.write_hook_file()
        self.assert_rejected("generated plugin must not contain `hooks/` for this manifest source")

        self.reset_candidate()
        self.manifest_source = "fallback"
        self.set_hooks({})
        self.write_hook_file()
        self.assert_rejected_all(
            "fallback plugin manifest field `hooks` must be absent",
            "generated plugin must not contain `hooks/` for this manifest source",
        )

        self.reset_candidate()
        self.manifest_source = "upstream"
        manifest = self.read_manifest()
        manifest.pop("interface")
        manifest["hooks"] = {}
        self.write_manifest(manifest)
        self.write_hook_file()
        self.assert_rejected("generated plugin must not contain `hooks/` for this manifest source")

        self.reset_candidate()
        self.set_hooks({})
        manifest = self.read_manifest()
        manifest["interface"] = "not-an-object"
        self.write_manifest(manifest)
        self.write_hook_file()
        self.assert_rejected_all(
            "plugin manifest field `interface` must be an object",
            "generated plugin must not contain `hooks/` for this manifest source",
        )

    def test_hook_declarations_reject_unsupported_or_unsafe_values(self) -> None:
        cases: tuple[tuple[str, Any, str], ...] = (
            ("unsupported-scalar", 17, "field `hooks` has an unsupported type"),
            (
                "mixed-array",
                ["./hooks/hooks-codex.json", {"hooks": {}}],
                "field `hooks` array must contain only paths or only objects",
            ),
            ("missing-dot-slash", "hooks/hooks-codex.json", "must start with `./`"),
            ("absolute", "/tmp/hooks.json", "must start with `./`"),
            ("traversal", "./../outside.json", "escapes the plugin root"),
            ("missing", "./hooks/missing.json", "does not exist"),
        )
        for label, hooks, fragment in cases:
            with self.subTest(label=label):
                self.reset_candidate()
                self.set_hooks(hooks)
                self.assert_rejected(fragment)

        self.reset_candidate()
        (self.plugin / "hooks" / "directory.json").mkdir(parents=True)
        self.set_hooks("./hooks/directory.json")
        self.assert_rejected("target `./hooks/directory.json` must be a file")

        if hasattr(os, "symlink"):
            self.reset_candidate()
            outside = Path(self.tempdir.name) / "outside-hooks.json"
            outside.write_text('{"hooks":{}}\n', encoding="utf-8")
            (self.plugin / "hooks").mkdir()
            (self.plugin / "hooks" / "escape.json").symlink_to(outside)
            self.set_hooks("./hooks/escape.json")
            self.assert_rejected("escapes the plugin root")

    def test_manifest_failures_preserve_physical_hook_prohibition(self) -> None:
        manifest_path = self.plugin / ".codex-plugin" / "plugin.json"
        manifest_path.unlink()
        self.write_hook_file()
        self.assert_rejected_all(
            "missing required file `.codex-plugin/plugin.json`",
            "generated plugin must not contain `hooks/` for this manifest source",
        )

        self.reset_candidate()
        manifest_path.write_text("{bad", encoding="utf-8")
        self.write_hook_file()
        self.assert_rejected_all(
            "plugin manifest must contain valid JSON",
            "generated plugin must not contain `hooks/` for this manifest source",
        )

    def test_default_discovery_requires_hooks_json(self) -> None:
        self.write_hook_file("hooks/hooks.json")
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        self.reset_candidate()
        (self.plugin / "hooks").mkdir()
        self.assert_rejected("default-discovered `hooks/` must contain `hooks/hooks.json`")

    def test_hook_subtree_rejects_unsafe_symlinks_for_allowing_policies(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are unavailable")

        for policy in ("default", "allow"):
            for location in ("root", "nested"):
                for target_kind in ("absolute", "broken", "escape"):
                    with self.subTest(policy=policy, location=location, target=target_kind):
                        self.reset_candidate()
                        if policy == "allow":
                            self.set_hooks({"hooks": {}})

                        outside_dir = Path(self.tempdir.name) / f"outside-{policy}-{location}-{target_kind}"
                        outside_dir.mkdir(exist_ok=True)
                        (outside_dir / "hooks.json").write_text(
                            '{"hooks":{}}\n', encoding="utf-8"
                        )

                        hooks_root = self.plugin / "hooks"
                        if location == "root":
                            if target_kind == "absolute":
                                hooks_root.symlink_to(outside_dir)
                            elif target_kind == "broken":
                                hooks_root.symlink_to("missing-hooks")
                            else:
                                hooks_root.symlink_to(
                                    os.path.relpath(outside_dir, self.plugin)
                                )
                        else:
                            hooks_root.mkdir()
                            self.write_hook_file("hooks/hooks.json")
                            nested = hooks_root / "nested"
                            if target_kind == "absolute":
                                nested.symlink_to(outside_dir)
                            elif target_kind == "broken":
                                nested.symlink_to("missing-target")
                            else:
                                nested.symlink_to(
                                    os.path.relpath(outside_dir, hooks_root)
                                )

                        result = self.run_validator()
                        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                        self.assertRegex(
                            result.stderr,
                            r"generated hook symlink (?:must be relative|escapes or is broken)",
                        )
                        self.assertNotIn("Traceback", result.stderr)

    def test_hook_subtree_follows_contained_directory_symlink(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are unavailable")
        self.set_hooks({"hooks": {}})
        (self.plugin / "hooks").mkdir()
        contained = self.plugin / "hook-targets" / "contained-directory"
        contained.mkdir(parents=True)
        outside = Path(self.tempdir.name) / "outside-hook.json"
        outside.write_text('{"hooks":{}}\n', encoding="utf-8")
        (contained / "unsafe.json").symlink_to(outside)
        (contained / "cycle").symlink_to(".")
        (self.plugin / "hooks" / "contained-directory").symlink_to(
            "../hook-targets/contained-directory"
        )

        self.assert_rejected("generated hook symlink must be relative")

    def test_hook_subtree_accepts_contained_materialized_relative_symlink(self) -> None:
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are unavailable")
        self.set_hooks({"hooks": {}})
        self.write_hook_file("hook-targets/contained.json")
        contained_directory = self.plugin / "hook-targets" / "contained-directory"
        contained_directory.mkdir()
        (contained_directory / "hook.json").write_text(
            '{"hooks":{}}\n', encoding="utf-8"
        )
        (contained_directory / "cycle").symlink_to(".")
        (self.plugin / "hooks").mkdir()
        (self.plugin / "hooks" / "contained.json").symlink_to(
            "../hook-targets/contained.json"
        )
        (self.plugin / "hooks" / "contained-directory").symlink_to(
            "../hook-targets/contained-directory"
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_frontmatter_uses_first_closing_fence_and_owned_keys_only(self) -> None:
        skill = self.plugin / "skills" / "brainstorming" / "SKILL.md"
        skill.write_text(
            "---\nname: brainstorming\ndescription: Valid\n---\n"
            "---\nname: teaching-example\ndescription:\n---\n",
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        self.reset_candidate()
        skill = self.plugin / "skills" / "brainstorming" / "SKILL.md"
        skill.write_text(
            "---\nname: brainstorming\ndescription: >\n  Block text\n---\n# Body\n",
            encoding="utf-8",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        cases = (
            ("name: brainstorming\ndescription: x\n---\n", "must start with `---`"),
            ("---\nname: brainstorming\ndescription: x\n", "frontmatter is not closed"),
            ("---\ndescription: x\n---\n", "exactly one top-level `name:`"),
            ("---\nname: a\nname: b\ndescription: x\n---\n", "exactly one top-level `name:`"),
            ("---\nname: ''\ndescription: x\n---\n", "field `name` must be non-empty"),
            ("---\nname: a\ndescription: # empty\n---\n", "field `description` must be non-empty"),
        )
        for contents, fragment in cases:
            with self.subTest(fragment=fragment):
                self.reset_candidate()
                skill = self.plugin / "skills" / "brainstorming" / "SKILL.md"
                skill.write_text(contents, encoding="utf-8")
                self.assert_rejected(fragment)

if __name__ == "__main__":
    unittest.main()
