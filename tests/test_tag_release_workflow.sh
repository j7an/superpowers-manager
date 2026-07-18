#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
wf="$root/.github/workflows/tag-release.yml"
bump="$root/.version-bump.json"
package="$root/package.json"

[ -f "$wf" ] || { echo "missing $wf" >&2; exit 1; }
[ -f "$bump" ] || { echo "missing $bump" >&2; exit 1; }
[ -f "$package" ] || { echo "missing $package" >&2; exit 1; }

grep -q 'workflow_dispatch:' "$wf"
grep -Fq 'uses: j7an/shared-workflows/.github/workflows/tag-release.yml@dc9105acf09a4ad43bad2e4a86f4c65f553fe3c0 # v4.2.2' "$wf"
grep -Fq 'bump: ${{ inputs.bump }}' "$wf"
grep -q 'tag-prefix: "v"' "$wf"
grep -q 'RELEASE_BOT_PRIVATE_KEY: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}' "$wf"

python3 - "$wf" "$bump" "$package" <<'PY'
import json
import re
import sys

workflow_path, path, package_path = sys.argv[1:]
with open(workflow_path, encoding="utf-8") as fh:
    workflow = fh.read()
with open(path, encoding="utf-8") as fh:
    actual = json.load(fh)

expected = {"files": [{"path": "package.json", "field": "version"}]}
if actual != expected:
    raise SystemExit(f"unexpected {path}: {actual!r}")


def extract_bump_options(document):
    expected_path = ["on", "workflow_dispatch", "inputs", "bump", "options"]
    key_path = []
    key_indents = []
    options = None
    options_indent = None

    for line in document.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        content = line[indent:]
        key_match = re.fullmatch(r"([A-Za-z0-9_-]+):(?:\s*#.*)?", content)
        if key_match is not None:
            while key_indents and indent <= key_indents[-1]:
                key_indents.pop()
                key_path.pop()
            key_path.append(key_match[1])
            key_indents.append(indent)
            if key_path == expected_path:
                if options is not None:
                    raise ValueError("Tag Release bump options are duplicated")
                options = []
                options_indent = indent
            continue

        option_match = re.fullmatch(r"-\s+(.+)", content)
        if (
            option_match is not None
            and key_path == expected_path
            and indent == options_indent + 2
        ):
            options.append(option_match[1])

    if options is None:
        raise ValueError("Tag Release bump options are missing")
    return options


def assert_supported_bump_options(document):
    options = extract_bump_options(document)
    expected_options = ["auto", "patch", "minor", "major"]
    if options != expected_options:
        raise ValueError(
            "Tag Release bump options must be exactly "
            f"{expected_options!r}, got {options!r}"
        )


try:
    assert_supported_bump_options(workflow)
except ValueError as exc:
    raise SystemExit(str(exc)) from exc

unsupported_option_fixture = """\
on:
  workflow_dispatch:
    inputs:
      unrelated:
        type: choice
        options:
          - auto
          - patch
          - minor
          - major
      bump:
        type: choice
        options:
          - auto
          - patch
          - minor
          - major
          - prerelease
"""
try:
    assert_supported_bump_options(unsupported_option_fixture)
except ValueError:
    pass
else:
    raise SystemExit(
        "internal bump-option regression: unsupported prerelease option accepted"
    )

with open(package_path, encoding="utf-8") as fh:
    package = json.load(fh)

stable_semver = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)


def parse_stable_semver(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} is not a stable semver string: {value!r}")
    match = stable_semver.fullmatch(value)
    if match is None:
        raise ValueError(f"{label} is not stable semver: {value!r}")
    return tuple(int(part) for part in match.groups())

try:
    parse_stable_semver("1.2.3-beta.1", "test version")
except ValueError:
    pass
else:
    raise SystemExit("internal version-contract regression: prerelease accepted")

if package.get("name") != "superpowers-manager":
    raise SystemExit(
        f"unexpected package name in {package_path}: {package.get('name')!r}"
    )

try:
    parse_stable_semver(package.get("version"), "package.json version")
except ValueError as exc:
    raise SystemExit(str(exc)) from exc
PY

echo "test_tag_release_workflow: OK"
