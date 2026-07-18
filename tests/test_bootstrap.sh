#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

assert_file() {
  path="$1"
  if [ ! -f "$root/$path" ]; then
    echo "missing file: $path" >&2
    exit 1
  fi
}

assert_contains() {
  path="$1"
  text="$2"
  if ! grep -Fq "$text" "$root/$path"; then
    echo "missing text in $path: $text" >&2
    exit 1
  fi
}

assert_not_contains() {
  path="$1"
  text="$2"
  if grep -Fq "$text" "$root/$path"; then
    echo "unexpected text in $path: $text" >&2
    exit 1
  fi
}

assert_file ".gitignore"
assert_file "config/upstream-ref"
assert_file ".agents/plugins/marketplace.json"
assert_file "plugins/superpowers/.codex-plugin/plugin.template.json"
assert_file "scripts/adapters/codex/adapter"
assert_file "scripts/adapters/codex/validate-generated-plugin.py"
assert_file "scripts/core/validate-adapter-response.py"

assert_contains "package.json" '"type": "module"'
assert_not_contains "bin/superpowers-manager.js" "import.meta.main"
assert_contains "config/upstream-ref" "latest-release"
assert_contains ".agents/plugins/marketplace.json" '"name": "superpowers-manager"'
assert_contains ".agents/plugins/marketplace.json" '"products": ["CODEX"]'
assert_contains ".gitignore" "plugins/superpowers/.codex-plugin/plugin.json"
assert_contains ".gitignore" "plugins/.superpowers.prepare.*/"
assert_not_contains ".gitignore" "plugins/.superpowers.tmp.*/"
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"name": "superpowers"'
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"skills": "./skills/"'
assert_contains "AGENTS.md" 'Run `sh tests/container.sh` before declaring a change complete.'
assert_contains "AGENTS.md" "no mutation of the developer's or runner's real Codex state"
assert_contains "README.md" "sh tests/container.sh"
assert_contains "README.md" "Layers 1-3 stay offline and hermetic"
assert_contains "README.md" "Layer 4 is the Docker acceptance path"
assert_contains "README.md" "sh tests/container.sh                    # Layers 1-4: blocking Docker acceptance command"
assert_contains "README.md" "no public harness selector"
assert_contains "RELEASING.md" 'Ensure `main` is green (`sh tests/container.sh`)'
assert_contains "RELEASING.md" "sh tests/container.sh"
assert_contains "RELEASING.md" '`v0.1.2` and `v0.1.3` were failed and unpublished maintenance attempts.'
assert_contains "RELEASING.md" '`v0.1.4` was the recovered maintenance publication.'
assert_contains "RELEASING.md" '`v0.1.5` failed before publication and must never be moved, reused, rerun, or published.'
assert_contains "RELEASING.md" '`v0.1.6` published successfully through OIDC and is immutable.'
assert_contains "RELEASING.md" 'No npm token belongs in this path.'
assert_contains "RELEASING.md" 'No prerelease path is authorized.'
assert_contains "RELEASING.md" 'Persistent upstream-version pinning is required before production `0.2.0`.'
assert_contains "RELEASING.md" 'protected `release` environment'
assert_contains "RELEASING.md" 'protected `npm` environment'
assert_contains "RELEASING.md" 'Never run or rerun a release workflow for `v0.1.5`, and never publish `superpowers-manager@0.1.5` by any path.'
assert_contains "RELEASING.md" 'j7an/superpowers-manager'
assert_contains "RELEASING.md" 'workflow `release.yml`'
assert_contains "RELEASING.md" 'environment `npm`'
assert_not_contains "RELEASING.md" 'Published Manager baseline for version monotonicity'
assert_not_contains "RELEASING.md" 'Advance this marker after successful publication'
assert_not_contains "RELEASING.md" 'one-time `0.1.6` recovery'
assert_not_contains "RELEASING.md" '0.1.6 recovery'
assert_not_contains "RELEASING.md" 'npm-bootstrap'
assert_not_contains "RELEASING.md" 'NPM_BOOTSTRAP_TOKEN'
assert_not_contains "RELEASING.md" 'j7an/superpowers-wrapper'
assert_contains "tests/manual/codex-behavior-probe.sh" "Optional native-only Codex compatibility probe"
assert_not_contains "README.md" "The automated suite is fully hermetic: it uses a fake local upstream repo and a"

python3 - "$root/RELEASING.md" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    release_doc = fh.read()


def extract_section(document, title):
    pattern = re.compile(rf"^### {re.escape(title)}$", re.MULTILINE)
    matches = list(pattern.finditer(document))
    if len(matches) != 1:
        raise ValueError(
            f"expected exactly one {title!r} section, found {len(matches)}"
        )
    match = matches[0]
    body_start = match.end()
    next_heading = re.search(r"^#{1,3} ", document[body_start:], re.MULTILINE)
    body_end = (
        len(document)
        if next_heading is None
        else body_start + next_heading.start()
    )
    return match.start(), document[body_start:body_end]


def assert_release_verification_sections(document):
    pre_position, pre_body = extract_section(document, "Pre-publication approval")
    post_position, post_body = extract_section(
        document, "Post-publication verification"
    )
    if pre_position >= post_position:
        raise ValueError(
            "Pre-publication approval must precede Post-publication verification"
        )

    required_pre = (
        "frozen tag and source SHA",
        "package name and version",
        "tarball digest",
        "zero npm secrets",
        "before approving publication",
    )
    required_post = (
        "npm provenance",
        "clean-cache `npx` execution",
        "published version and source SHA",
        "after publication",
    )
    for text in required_pre:
        if text not in pre_body:
            raise ValueError(f"missing pre-publication evidence: {text}")
    for text in required_post:
        if text not in post_body:
            raise ValueError(f"missing post-publication evidence: {text}")


try:
    assert_release_verification_sections(release_doc)
except ValueError as exc:
    raise SystemExit(str(exc)) from exc

swapped_sections_fixture = """\
### Post-publication verification

Verify npm provenance and clean-cache `npx` execution against the published
version and source SHA after publication.

### Pre-publication approval

Verify the frozen tag and source SHA, package name and version, tarball digest,
and zero npm secrets before approving publication.
"""
misplaced_evidence_fixture = """\
### Pre-publication approval

Verify npm provenance and clean-cache `npx` execution against the published
version and source SHA after publication.

### Post-publication verification

Verify the frozen tag and source SHA, package name and version, tarball digest,
and zero npm secrets before approving publication.
"""
for label, fixture in (
    ("swapped sections", swapped_sections_fixture),
    ("misplaced evidence", misplaced_evidence_fixture),
):
    try:
        assert_release_verification_sections(fixture)
    except ValueError:
        pass
    else:
        raise SystemExit(
            f"internal release-section regression: accepted {label} fixture"
        )
PY
