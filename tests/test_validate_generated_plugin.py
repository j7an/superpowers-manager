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
COMMIT = "d884ae04edebef577e82ff7c4e143debd0bbec99"
SOURCE = "https://example.invalid/superpowers.git"


class ValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.plugin = Path(self.tempdir.name) / "plugin"
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
        self.write_manifest(
            {
                "name": "superpowers",
                "version": self.expected["manifest_version"],
                "description": "Generated Superpowers",
                "skills": "./skills/",
                "interface": {"logo": "./assets/logo.svg", "screenshots": []},
                "x_future_manifest": {"preserved": True},
            }
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

    def write_metadata(self, value: Any | None = None) -> None:
        if value is None:
            value = {
                "source": self.expected["source"],
                "requested_ref": self.expected["requested_ref"],
                "resolved_ref": self.expected["resolved_ref"],
                "commit": self.expected["commit"],
                "upstream_manifest_version": self.expected["upstream_manifest_version"],
            }
        (self.plugin / ".superpowers-upstream.json").write_text(
            json.dumps(value) + "\n", encoding="utf-8"
        )

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
            "--upstream-manifest-version",
            self.expected["upstream_manifest_version"],
        ]
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def assert_rejected(self, fragment: str) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_valid_candidate_and_unknown_manifest_field_pass(self) -> None:
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("generated plugin validation passed", result.stdout)

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
        manifest_path.write_text(
            '{"name":"superpowers","version":"6.1.1+manager.d884ae0",'
            '"description":"Generated Superpowers","skills":"./skills/",'
            '"x_future_manifest":NaN}\n',
            encoding="utf-8",
        )
        self.assert_rejected("plugin manifest must contain valid JSON")

        self.reset_candidate()
        metadata_path = self.plugin / ".superpowers-upstream.json"
        metadata_path.write_text(
            '{"source":"https://example.invalid/superpowers.git",'
            '"requested_ref":"latest-release","resolved_ref":"v6.1.1",'
            f'"commit":"{COMMIT}","upstream_manifest_version":Infinity}}\n',
            encoding="utf-8",
        )
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
            validate_tree(self.plugin, errors)
        self.assertIn("skills directory could not be enumerated", errors)

    def test_manifest_json_shape_and_owned_fields_fail_closed(self) -> None:
        manifest_path = self.plugin / ".codex-plugin" / "plugin.json"
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
            ("hooks", {"hooks": "./hooks.json"}, "field `hooks` must be absent"),
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
        self.assert_rejected("must not contain `hooks/`")

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

    def test_known_paths_fail_on_bad_types_escape_and_missing_targets(self) -> None:
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

    def test_provenance_shape_values_and_commit_fail_closed(self) -> None:
        (self.plugin / ".superpowers-upstream.json").write_text("{bad", encoding="utf-8")
        self.assert_rejected("provenance must contain valid JSON")

        self.reset_candidate()
        self.write_metadata([])
        self.assert_rejected("provenance must contain a JSON object")

        self.reset_candidate()
        metadata = json.loads((self.plugin / ".superpowers-upstream.json").read_text())
        metadata.pop("resolved_ref")
        self.write_metadata(metadata)
        self.assert_rejected("provenance keys do not match")

        self.reset_candidate()
        metadata = json.loads((self.plugin / ".superpowers-upstream.json").read_text())
        metadata["source"] = "https://wrong.invalid/repo"
        self.write_metadata(metadata)
        self.assert_rejected("provenance field `source` does not match")

        self.reset_candidate()
        metadata = json.loads((self.plugin / ".superpowers-upstream.json").read_text())
        metadata["commit"] = "D" * 40
        self.write_metadata(metadata)
        self.expected["commit"] = "D" * 40
        self.assert_rejected("commit must be 40 lowercase hexadecimal characters")


if __name__ == "__main__":
    unittest.main()
