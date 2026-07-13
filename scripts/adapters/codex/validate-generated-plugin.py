#!/usr/bin/env python3
"""Validate the wrapper-owned generated Superpowers plugin contract."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Sequence


SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
MAX_JSON_NESTING = 256
PROVENANCE_KEYS = {
    "source",
    "requested_ref",
    "resolved_ref",
    "commit",
    "upstream_manifest_version",
}


def reject_json_constant(constant: str) -> None:
    raise ValueError(f"non-standard numeric constant: {constant}")


def json_nesting_exceeds_limit(value: Any) -> bool:
    stack = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if isinstance(current, dict):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current.values())
        elif isinstance(current, list):
            next_depth = depth + 1
            if next_depth > MAX_JSON_NESTING:
                return True
            stack.extend((child, next_depth) for child in current)
    return False


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a generated Superpowers wrapper candidate."
    )
    parser.add_argument("--plugin-root", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--requested-ref", required=True)
    parser.add_argument("--resolved-ref", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--manifest-version", required=True)
    parser.add_argument("--upstream-manifest-version", required=True)
    return parser.parse_args(argv)


def load_json_object(path: Path, label: str, errors: list[str]) -> dict[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        errors.append(f"{label} is unreadable UTF-8")
        return None
    try:
        value = json.loads(text, parse_constant=reject_json_constant)
    except RecursionError:
        errors.append(f"{label} exceeds maximum JSON nesting")
        return None
    except (json.JSONDecodeError, ValueError):
        errors.append(f"{label} must contain valid JSON")
        return None
    if json_nesting_exceeds_limit(value):
        errors.append(f"{label} exceeds maximum JSON nesting")
        return None
    if not isinstance(value, dict):
        errors.append(f"{label} must contain a JSON object")
        return None
    return value


def validate_local_path(
    plugin_root: Path,
    raw_value: Any,
    label: str,
    errors: list[str],
    *,
    require_directory: bool = False,
) -> None:
    if not isinstance(raw_value, str) or not raw_value.strip():
        errors.append(f"{label} must be a non-empty relative path")
        return
    raw_path = Path(raw_value)
    if raw_path.is_absolute():
        errors.append(f"{label} must be a relative path")
        return
    try:
        root = plugin_root.resolve()
        target = (root / raw_path).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        errors.append(f"{label} could not be resolved")
        return
    try:
        target.relative_to(root)
    except ValueError:
        errors.append(f"{label} escapes the plugin root")
        return
    try:
        if not target.exists():
            errors.append(f"{label} target `{raw_value}` does not exist")
        elif require_directory and not target.is_dir():
            errors.append(f"{label} target `{raw_value}` must be a directory")
    except OSError:
        errors.append(f"{label} target `{raw_value}` could not be inspected")


def validate_manifest(plugin_root: Path, expected_version: str, errors: list[str]) -> None:
    path = plugin_root / ".codex-plugin" / "plugin.json"
    if not path.is_file():
        errors.append("missing required file `.codex-plugin/plugin.json`")
        return
    manifest = load_json_object(path, "plugin manifest", errors)
    if manifest is None:
        return

    if manifest.get("name") != "superpowers":
        errors.append("plugin manifest field `name` must equal `superpowers`")
    version = manifest.get("version")
    if version != expected_version:
        errors.append("plugin manifest field `version` must equal expected version")
    if not isinstance(version, str) or SEMVER_RE.fullmatch(version) is None:
        errors.append("plugin manifest field `version` must be SemVer 2.0.0")
    description = manifest.get("description")
    if not isinstance(description, str) or not description.strip():
        errors.append("plugin manifest field `description` must be non-empty")
    if manifest.get("skills") != "./skills/":
        errors.append("plugin manifest field `skills` must equal `./skills/`")
    if "hooks" in manifest:
        errors.append("plugin manifest field `hooks` must be absent")

    validate_local_path(
        plugin_root,
        manifest.get("skills"),
        "plugin manifest field `skills`",
        errors,
        require_directory=True,
    )
    if "apps" in manifest:
        validate_local_path(plugin_root, manifest["apps"], "plugin manifest field `apps`", errors)
    if "mcpServers" in manifest:
        mcp_servers = manifest["mcpServers"]
        if isinstance(mcp_servers, str):
            validate_local_path(
                plugin_root, mcp_servers, "plugin manifest field `mcpServers`", errors
            )
        elif not isinstance(mcp_servers, dict):
            errors.append("plugin manifest field `mcpServers` must be a string or object")

    if "interface" not in manifest:
        return
    interface = manifest["interface"]
    if not isinstance(interface, dict):
        errors.append("plugin manifest field `interface` must be an object")
        return
    for field in ("composerIcon", "logo", "logoDark"):
        if field in interface:
            validate_local_path(
                plugin_root,
                interface[field],
                f"plugin manifest field `interface.{field}`",
                errors,
            )
    if "screenshots" in interface:
        screenshots = interface["screenshots"]
        if not isinstance(screenshots, list):
            errors.append("plugin manifest field `interface.screenshots` must be an array")
        else:
            for index, value in enumerate(screenshots):
                validate_local_path(
                    plugin_root,
                    value,
                    f"plugin manifest field `interface.screenshots[{index}]`",
                    errors,
                )


def validate_skill_frontmatter(skill_md: Path, skill_name: str, errors: list[str]) -> None:
    try:
        contents = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        errors.append(f"skill `{skill_name}` has unreadable UTF-8 `SKILL.md`")
        return
    if not contents:
        errors.append(f"skill `{skill_name}` has empty `SKILL.md`")
        return
    lines = contents.splitlines()
    if not lines or lines[0] != "---":
        errors.append(f"skill `{skill_name}` must start with `---`")
        return
    try:
        closing_index = lines.index("---", 1)
    except ValueError:
        errors.append(f"skill `{skill_name}` frontmatter is not closed")
        return
    frontmatter = lines[1:closing_index]
    for key in ("name", "description"):
        matches = [line for line in frontmatter if line.startswith(f"{key}:")]
        if len(matches) != 1:
            errors.append(
                f"skill `{skill_name}` frontmatter must contain exactly one top-level `{key}:`"
            )
            continue
        value = matches[0].split(":", 1)[1].strip()
        if value in {"", "''", '\"\"'} or value.startswith("#"):
            errors.append(f"skill `{skill_name}` frontmatter field `{key}` must be non-empty")


def validate_tree(plugin_root: Path, errors: list[str]) -> None:
    required_files = (
        ".codex-plugin/plugin.template.json",
        ".superpowers-upstream.json",
        "LICENSE",
        "README.md",
        "CODE_OF_CONDUCT.md",
    )
    for relative in required_files:
        if not (plugin_root / relative).is_file():
            errors.append(f"missing required file `{relative}`")
    if os.path.lexists(plugin_root / "hooks"):
        errors.append("generated plugin must not contain `hooks/`")

    skills_root = plugin_root / "skills"
    if not skills_root.is_dir():
        errors.append("missing required directory `skills/`")
        return
    try:
        skill_dirs = sorted(
            path
            for path in skills_root.iterdir()
            if not path.name.startswith(".") and path.is_dir()
        )
    except OSError:
        errors.append("skills directory could not be enumerated")
        return
    if not skill_dirs:
        errors.append("`skills/` must contain at least one skill directory")
        return
    for skill_dir in skill_dirs:
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            errors.append(f"skill `{skill_dir.name}` is missing `SKILL.md`")
            continue
        validate_skill_frontmatter(skill_md, skill_dir.name, errors)


def validate_provenance(args: argparse.Namespace, plugin_root: Path, errors: list[str]) -> None:
    path = plugin_root / ".superpowers-upstream.json"
    if not path.is_file():
        return
    provenance = load_json_object(path, "provenance", errors)
    if provenance is None:
        return
    if set(provenance) != PROVENANCE_KEYS:
        errors.append("provenance keys do not match the wrapper-owned contract")
    expected = {
        "source": args.source,
        "requested_ref": args.requested_ref,
        "resolved_ref": args.resolved_ref,
        "commit": args.commit,
        "upstream_manifest_version": args.upstream_manifest_version,
    }
    for key, value in expected.items():
        if provenance.get(key) != value:
            errors.append(f"provenance field `{key}` does not match expected value")
    if re.fullmatch(r"[0-9a-f]{40}", args.commit) is None:
        errors.append("commit must be 40 lowercase hexadecimal characters")


def validate(args: argparse.Namespace) -> list[str]:
    errors: list[str] = []
    try:
        plugin_root = Path(args.plugin_root).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        errors.append("plugin root could not be resolved")
        return errors
    validate_manifest(plugin_root, args.manifest_version, errors)
    validate_tree(plugin_root, errors)
    validate_provenance(args, plugin_root, errors)
    return errors


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    errors = validate(args)
    if errors:
        print("Generated plugin validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"generated plugin validation passed: {args.plugin_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
