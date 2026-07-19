#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/core/selection-state.py"
SOURCE = "https://github.com/obra/superpowers"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
OTHER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef"
PINNED = {
    "schema_version": 1,
    "mode": "pinned",
    "source": SOURCE,
    "requested_ref": "v6.1.1",
    "resolved_ref": "v6.1.1",
    "commit": COMMIT,
}
TRACK_LATEST = {
    "schema_version": 1,
    "mode": "track-latest",
    "source": SOURCE,
}
NORMALIZED_ABSENT = {
    "saved_mode": "none",
    "saved_source": "",
    "saved_requested_ref": "",
    "saved_resolved_ref": "",
    "saved_commit": "",
}


class SelectionStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.base = Path(self.tempdir.name)
        self.state_path = self.base / "config" / "selection.json"

    def run_helper(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-S", str(HELPER), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )

    def read(self, path: Path | None = None) -> subprocess.CompletedProcess[str]:
        output = self.base / "normalized.json"
        return self.run_helper(
            "read", "--path", str(path or self.state_path), "--output", str(output)
        )

    def read_record(self, record: object) -> dict[str, str]:
        self.state_path.parent.mkdir(mode=0o700, exist_ok=True)
        self.state_path.write_text(json.dumps(record) + "\n", encoding="utf-8")
        output = self.base / "normalized.json"
        result = self.run_helper(
            "read", "--path", str(self.state_path), "--output", str(output)
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(output.read_text(encoding="utf-8"))

    def read_raw(self, raw: str) -> subprocess.CompletedProcess[str]:
        self.state_path.parent.mkdir(mode=0o700, exist_ok=True)
        self.state_path.write_text(raw, encoding="utf-8")
        return self.read()

    def assert_read_fails(self, raw: str, fragment: str | None = None) -> None:
        result = self.read_raw(raw)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        if fragment is not None:
            self.assertIn(fragment, result.stderr)

    def assert_source_valid(self, source: str) -> None:
        result = self.run_helper("validate-source", "--source", source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def assert_source_invalid(self, source: str) -> None:
        result = self.run_helper("validate-source", "--source", source)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)

    def write_pinned(
        self,
        *,
        path: Path | None = None,
        source: str = SOURCE,
        requested_ref: str = "v6.1.1",
        resolved_ref: str = "v6.1.1",
        commit: str = COMMIT,
    ) -> subprocess.CompletedProcess[str]:
        return self.run_helper(
            "write-pinned",
            "--path",
            str(path or self.state_path),
            "--source",
            source,
            "--requested-ref",
            requested_ref,
            "--resolved-ref",
            resolved_ref,
            "--commit",
            commit,
        )

    def write_track_latest(
        self, *, path: Path | None = None, source: str = SOURCE
    ) -> subprocess.CompletedProcess[str]:
        return self.run_helper(
            "write-track-latest",
            "--path",
            str(path or self.state_path),
            "--source",
            source,
        )

    def test_read_normalizes_absent_pinned_and_track_latest(self) -> None:
        output = self.base / "absent.json"
        result = self.run_helper(
            "read", "--path", str(self.state_path), "--output", str(output)
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), NORMALIZED_ABSENT)
        self.assertEqual(self.read_record(PINNED)["saved_commit"], PINNED["commit"])
        self.assertEqual(self.read_record(TRACK_LATEST)["saved_mode"], "track-latest")

    def test_read_rejects_duplicate_unknown_missing_and_inconsistent_fields(self) -> None:
        raw_cases = (
            '{"schema_version":1,"schema_version":1,"mode":"track-latest","source":"x"}',
            json.dumps({**TRACK_LATEST, "extra": True}),
            json.dumps({"schema_version": 1, "mode": "pinned", "source": "x"}),
            json.dumps({**PINNED, "resolved_ref": "v6.1.2"}),
            json.dumps({**PINNED, "commit": PINNED["commit"].upper()}),
            json.dumps({**TRACK_LATEST, "schema_version": True}),
            json.dumps({**TRACK_LATEST, "schema_version": 2}),
        )
        for raw in raw_cases:
            with self.subTest(raw=raw):
                self.assert_read_fails(raw)

    def test_read_rejects_non_object_constants_and_excessive_nesting(self) -> None:
        for raw in ("[]", '"value"', "null", "NaN", "Infinity", "-Infinity"):
            with self.subTest(raw=raw):
                self.assert_read_fails(raw)
        deeply_nested = "[" * 300 + "0" + "]" * 300
        self.assert_read_fails(deeply_nested, "nesting")

    def test_read_rejects_oversized_integer_without_traceback(self) -> None:
        oversized_integer = "9" * 5000
        self.assert_read_fails(
            '{"schema_version":' + oversized_integer + '}',
            "invalid JSON",
        )

    def test_read_rejects_empty_multiline_and_invalid_ref_strings(self) -> None:
        invalid_records = (
            {**TRACK_LATEST, "source": ""},
            {**TRACK_LATEST, "source": "local\npath"},
            {**PINNED, "requested_ref": ""},
            {**PINNED, "requested_ref": "v6.1.1\n", "resolved_ref": "v6.1.1\n"},
            {**PINNED, "requested_ref": "6.1.1", "resolved_ref": "6.1.1"},
            {**PINNED, "requested_ref": "v01.2.3", "resolved_ref": "v01.2.3"},
            {**PINNED, "requested_ref": "v1.02.3", "resolved_ref": "v1.02.3"},
            {**PINNED, "requested_ref": "v1.2.03", "resolved_ref": "v1.2.03"},
            {**PINNED, "requested_ref": "v1.2.3-01", "resolved_ref": "v1.2.3-01"},
            {**PINNED, "requested_ref": "v1.2.3+build", "resolved_ref": "v1.2.3+build"},
            {**PINNED, "requested_ref": "latest-release", "resolved_ref": "latest-release"},
        )
        for record in invalid_records:
            with self.subTest(record=record):
                self.assert_read_fails(json.dumps(record))

    def test_raw_commit_requires_cross_field_equality(self) -> None:
        raw = {
            **PINNED,
            "requested_ref": COMMIT,
            "resolved_ref": COMMIT,
            "commit": COMMIT,
        }
        self.assertEqual(self.read_record(raw)["saved_requested_ref"], COMMIT)
        for field in ("requested_ref", "resolved_ref", "commit"):
            invalid = {**raw, field: OTHER_COMMIT}
            with self.subTest(field=field):
                self.assert_read_fails(json.dumps(invalid))

    def test_source_validation_rejects_http_userinfo_only(self) -> None:
        for source in (
            SOURCE,
            "http://example.invalid/repo",
            "ssh://git@github.com/obra/superpowers.git",
            "git@github.com:obra/superpowers.git",
            "/tmp/local upstream",
        ):
            with self.subTest(source=source):
                self.assert_source_valid(source)
        for source in (
            "https://user:password@example.invalid/repo",
            "https://token@example.invalid/repo",
            "http://user@example.invalid/repo",
            "https://[invalid/repo",
        ):
            with self.subTest(source=source):
                self.assert_source_invalid(source)
                displayed = self.run_helper("display-source", "--source", source)
                self.assertEqual(displayed.returncode, 0, displayed.stderr)
                self.assertEqual(displayed.stdout, "<redacted-source>\n")
        displayed = self.run_helper("display-source", "--source", SOURCE)
        self.assertEqual(displayed.returncode, 0, displayed.stderr)
        self.assertEqual(displayed.stdout, SOURCE + "\n")

    def test_read_rejects_symlink_directory_and_fifo_paths(self) -> None:
        self.state_path.parent.mkdir(mode=0o700)
        real = self.state_path.parent / "real.json"
        real.write_text(json.dumps(TRACK_LATEST), encoding="utf-8")
        symlink = self.state_path.parent / "symlink.json"
        symlink.symlink_to(real)
        directory = self.state_path.parent / "directory.json"
        directory.mkdir()
        fifo = self.state_path.parent / "fifo.json"
        os.mkfifo(fifo)
        for path in (symlink, directory, fifo):
            with self.subTest(path=path):
                result = self.read(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)

    def test_read_rejects_absent_state_below_symlinked_config_directory(self) -> None:
        real_directory = self.base / "real-config"
        real_directory.mkdir(mode=0o700)
        linked_directory = self.base / "linked-config"
        linked_directory.symlink_to(real_directory, target_is_directory=True)
        result = self.read(linked_directory / "selection.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("directory must not be a symlink", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_writer_creates_private_directory_and_canonical_private_file(self) -> None:
        result = self.write_pinned()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(stat.S_IMODE(self.state_path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.state_path.stat().st_mode), 0o600)
        expected = json.dumps(PINNED, indent=2, allow_nan=False) + "\n"
        self.assertEqual(self.state_path.read_text(encoding="utf-8"), expected)

    def test_writer_preserves_existing_directory_mode(self) -> None:
        self.state_path.parent.mkdir(mode=0o750)
        os.chmod(self.state_path.parent, 0o750)
        result = self.write_track_latest()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(stat.S_IMODE(self.state_path.parent.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(self.state_path.stat().st_mode), 0o600)

    def test_writer_normalizes_raw_commit_input_to_lowercase(self) -> None:
        upper = COMMIT.upper()
        result = self.write_pinned(
            requested_ref=upper, resolved_ref=upper, commit=upper
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(self.state_path.read_text()), {
            **PINNED,
            "requested_ref": COMMIT,
            "resolved_ref": COMMIT,
            "commit": COMMIT,
        })

    def test_atomic_writer_preserves_valid_state_on_failure(self) -> None:
        first = self.write_pinned()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        before = self.state_path.read_bytes()
        result = self.write_pinned(
            source="https://token@example.invalid/repo",
            requested_ref="v6.1.2",
            resolved_ref="v6.1.2",
            commit=OTHER_COMMIT,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_writer_rejects_unexpected_state_and_parent_path_types(self) -> None:
        self.state_path.parent.mkdir(mode=0o700)
        target = self.state_path.parent / "target"
        target.write_text("target", encoding="utf-8")
        symlink = self.state_path.parent / "selection-link.json"
        symlink.symlink_to(target)
        directory = self.state_path.parent / "selection-dir.json"
        directory.mkdir()
        fifo = self.state_path.parent / "selection-fifo.json"
        os.mkfifo(fifo)
        parent_link = self.base / "config-link"
        parent_link.symlink_to(self.state_path.parent, target_is_directory=True)
        for path in (symlink, directory, fifo, parent_link / "selection.json"):
            with self.subTest(path=path):
                result = self.write_track_latest(path=path)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)

    def load_module(self):
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("selection_state", HELPER)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        self.addCleanup(sys.modules.pop, spec.name, None)
        spec.loader.exec_module(module)
        return module

    def test_failed_replace_cleans_only_own_temporary_file(self) -> None:
        module = self.load_module()
        self.state_path.parent.mkdir(mode=0o700)
        foreign = self.state_path.parent / ".selection.json.tmp.foreign"
        foreign.write_text("keep", encoding="utf-8")
        with mock.patch.object(module.os, "replace", side_effect=OSError("replace failed")):
            with self.assertRaises(module.SelectionError):
                module.write_record(self.state_path, PINNED)
        self.assertEqual(foreign.read_text(encoding="utf-8"), "keep")
        self.assertEqual(
            [path for path in self.state_path.parent.glob(".selection.json.tmp.*") if path != foreign],
            [],
        )

    def test_post_replace_failure_truthfully_reports_final_mode(self) -> None:
        module = self.load_module()
        real_replace = module.os.replace

        def replace_then_report_failure(source: Path, destination: Path) -> None:
            real_replace(source, destination)
            raise OSError("replace completion was uncertain")

        with mock.patch.object(module.os, "replace", side_effect=replace_then_report_failure):
            with self.assertRaises(module.SelectionError) as raised:
                module.write_record(self.state_path, PINNED)
        self.assertIn("selection state is now pinned", str(raised.exception))
        self.assertEqual(self.read_record(PINNED)["saved_mode"], "pinned")

    def test_two_concurrent_writers_leave_one_complete_valid_record(self) -> None:
        commands = (
            [
                sys.executable, "-S", str(HELPER), "write-pinned",
                "--path", str(self.state_path), "--source", SOURCE,
                "--requested-ref", "v6.1.1", "--resolved-ref", "v6.1.1",
                "--commit", COMMIT,
            ],
            [
                sys.executable, "-S", str(HELPER), "write-track-latest",
                "--path", str(self.state_path), "--source", SOURCE,
            ],
        )
        processes = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for command in commands]
        results = [process.communicate() + (process.returncode,) for process in processes]
        for stdout, stderr, returncode in results:
            self.assertEqual(returncode, 0, stdout + stderr)
        final = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertIn(final, (PINNED, TRACK_LATEST))
        normalized = self.read_record(final)
        self.assertIn(normalized["saved_mode"], ("pinned", "track-latest"))


if __name__ == "__main__":
    unittest.main()
