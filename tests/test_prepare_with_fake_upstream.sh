#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

upstream="$tmpdir/upstream"
output="$tmpdir/out"
home="$tmpdir/home"
template="$root/plugins/superpowers/.codex-plugin/plugin.template.json"
template_before=$(cksum "$template")

mkdir -p "$upstream/skills/brainstorming" "$upstream/assets" "$upstream/hooks"
mkdir -p "$home"
additional_validator="$tmpdir/additional-validator.py"
validator_log="$tmpdir/additional-validator.log"
cat > "$additional_validator" <<'PY'
import os
import sys

plugin_root = sys.argv[1]
required = os.path.join(plugin_root, ".codex-plugin", "plugin.template.json")
if not os.path.isfile(required):
    print(f"additional validator did not receive complete candidate: {required}", file=sys.stderr)
    sys.exit(1)

with open(os.environ["SUPERPOWERS_FAKE_VALIDATOR_LOG"], "a", encoding="utf-8") as handle:
    handle.write(plugin_root + "\n")
print("additional validator ran")
PY
git -C "$tmpdir" init upstream >/dev/null
cat > "$upstream/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
description: Fake upstream skill
---
# Brainstorming
EOF
printf 'asset\n' > "$upstream/assets/superpowers-small.svg"
printf '#!/bin/sh\n' > "$upstream/hooks/session-start-codex"
printf 'license\n' > "$upstream/LICENSE"
printf 'readme\n' > "$upstream/README.md"
printf 'code\n' > "$upstream/CODE_OF_CONDUCT.md"
git -C "$upstream" add .
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "fake upstream without manifest" >/dev/null
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c tag.gpgsign=false tag -a v5.0.0 -m "fake legacy release"
legacy_commit=$(git -C "$upstream" rev-list -n1 v5.0.0)

mkdir -p "$upstream/.codex-plugin"
cat > "$upstream/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "6.0.3",
  "description": "Upstream manifest description",
  "skills": "./wrong-skills/",
  "hooks": "./hooks/hooks-codex.json",
  "x_future_manifest": {
    "preserved": true,
    "items": [1, "two"]
  }
}
JSON
git -C "$upstream" add .
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "fake upstream with manifest" >/dev/null
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c tag.gpgsign=false tag -a v6.0.3 -m "fake release"

release_commit=$(git -C "$upstream" rev-list -n1 v6.0.3)
git -C "$upstream" branch -M main

printf 'branch data\n' > "$upstream/skills/brainstorming/branch.txt"
git -C "$upstream" add skills/brainstorming/branch.txt
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "main branch update" >/dev/null
main_commit=$(git -C "$upstream" rev-parse HEAD)
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c tag.gpgsign=false tag -a v6.1.0-beta.1 -m "fake prerelease"

git -C "$upstream" checkout -b invalid-skill >/dev/null
cat > "$upstream/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
---
# Missing description
EOF
git -C "$upstream" add skills/brainstorming/SKILL.md
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "invalid skill frontmatter" >/dev/null
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b nonstandard-json >/dev/null
python3 - "$upstream/.codex-plugin/plugin.json" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace('"preserved": true', '"preserved": NaN'), encoding="utf-8")
PY
git -C "$upstream" add .codex-plugin/plugin.json
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "nonstandard manifest JSON" >/dev/null
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b unreadable-manifest >/dev/null
printf '\377' > "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "non-UTF-8 manifest" >/dev/null
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b unencodable-manifest-version >/dev/null
python3 - "$upstream/.codex-plugin/plugin.json" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace('"version": "6.0.3"', '"version": "\\ud800"'), encoding="utf-8")
PY
git -C "$upstream" add .codex-plugin/plugin.json
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "unencodable manifest version" >/dev/null
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b deeply-nested-json >/dev/null
python3 - "$upstream/.codex-plugin/plugin.json" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
nested = "[" * 2000 + "0" + "]" * 2000
path.write_text(text.replace('"preserved": true', f'"preserved": {nested}'), encoding="utf-8")
PY
git -C "$upstream" add .codex-plugin/plugin.json
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "deeply nested manifest JSON" >/dev/null
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b feature/foo >/dev/null
printf 'feature data\n' > "$upstream/skills/brainstorming/feature.txt"
git -C "$upstream" add skills/brainstorming/feature.txt
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "feature branch update" >/dev/null
feature_commit=$(git -C "$upstream" rev-parse HEAD)

git -C "$upstream" checkout -b 042 >/dev/null
printf 'leading zero ref\n' > "$upstream/skills/brainstorming/leading-zero.txt"
git -C "$upstream" add skills/brainstorming/leading-zero.txt
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "leading zero branch" >/dev/null
leading_zero_commit=$(git -C "$upstream" rev-parse HEAD)
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b bad-manifest >/dev/null
printf '{ "name": "superpowers", "version": ' > "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "bad upstream manifest" >/dev/null
git -C "$upstream" checkout main >/dev/null

read_json_key() {
  file="$1"
  key="$2"
  python3 - "$file" "$key" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f)[sys.argv[2]])
PY
}

read_json_path() {
  file="$1"
  path="$2"
  python3 - "$file" "$path" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    value = json.load(f)
for part in sys.argv[2].split("."):
    value = value[part]
if isinstance(value, (dict, list)):
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
else:
    print(value)
PY
}

assert_manifest_path() {
  destination="$1"
  path="$2"
  expected="$3"
  manifest="$tmpdir/$destination/.codex-plugin/plugin.json"
  actual=$(read_json_path "$manifest" "$path")
  if [ "$actual" != "$expected" ]; then
    echo "manifest $path mismatch for $destination: $actual != $expected" >&2
    exit 1
  fi
}

assert_manifest_lacks_key() {
  destination="$1"
  key="$2"
  manifest="$tmpdir/$destination/.codex-plugin/plugin.json"
  python3 - "$manifest" "$key" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
if sys.argv[2] in data:
    print(f"manifest must not contain key: {sys.argv[2]}", file=sys.stderr)
    sys.exit(1)
PY
}

run_prepare_for_ref() {
  ref="$1"
  destination="$2"
  SUPERPOWERS_REF="$ref" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
  SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
  SUPERPOWERS_VALIDATOR= \
  HOME="$home" \
  sh "$root/scripts/prepare" >/dev/null
}

assert_bad_manifest_error() {
  destination="$1"
  err="$tmpdir/$destination.err"
  if SUPERPOWERS_REF="bad-manifest" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
    SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    sh "$root/scripts/prepare" >"$tmpdir/$destination.out" 2>"$err"; then
    echo "prepare unexpectedly accepted a malformed upstream manifest" >&2
    exit 1
  fi
  if ! grep -Eq 'invalid JSON in .*/\.codex-plugin/plugin\.json: line [0-9]+ column [0-9]+' "$err"; then
    echo "bad manifest error did not mention invalid JSON with location" >&2
    cat "$err" >&2
    exit 1
  fi
  if grep -q 'Traceback' "$err"; then
    echo "bad manifest error must not include a Python traceback" >&2
    cat "$err" >&2
    exit 1
  fi
}

assert_rejected_manifest_input() {
  ref="$1"
  destination="$2"
  expected="$3"
  err="$tmpdir/$destination.err"
  if SUPERPOWERS_REF="$ref" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
    SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    sh "$root/scripts/prepare" >"$tmpdir/$destination.out" 2>"$err"; then
    echo "prepare unexpectedly accepted invalid manifest input: $ref" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$err"; then
    echo "manifest input error did not contain expected diagnostic: $expected" >&2
    cat "$err" >&2
    exit 1
  fi
  if grep -q 'Traceback' "$err"; then
    echo "manifest input error must not include a Python traceback" >&2
    cat "$err" >&2
    exit 1
  fi
}

assert_prepare_version() {
  destination="$1"
  expected="$2"
  manifest="$tmpdir/$destination/.codex-plugin/plugin.json"
  version=$(read_json_key "$manifest" version)
  if [ "$version" != "$expected" ]; then
    echo "unexpected wrapper version for $destination: $version (expected $expected)" >&2
    exit 1
  fi
}

assert_prepare_commit() {
  destination="$1"
  expected="$2"
  metadata="$tmpdir/$destination/.superpowers-upstream.json"
  actual_commit=$(read_json_key "$metadata" commit)
  if [ "$actual_commit" != "$expected" ]; then
    echo "metadata commit mismatch for $destination: $actual_commit != $expected" >&2
    exit 1
  fi
}

assert_prepare_upstream_manifest_version() {
  destination="$1"
  expected="$2"
  metadata="$tmpdir/$destination/.superpowers-upstream.json"
  actual_version=$(read_json_key "$metadata" upstream_manifest_version)
  if [ "$actual_version" != "$expected" ]; then
    echo "upstream manifest version mismatch for $destination: $actual_version != $expected" >&2
    exit 1
  fi
}

run_prepare_for_ref "latest-release" "out-latest"
expected_short=$(printf '%s' "$release_commit" | cut -c 1-7)
assert_prepare_commit "out-latest" "$release_commit"
assert_prepare_version "out-latest" "6.0.3+manager.$expected_short"
assert_manifest_path "out-latest" "description" "Upstream manifest description"
assert_manifest_path "out-latest" "skills" "./skills/"
assert_manifest_path "out-latest" "x_future_manifest" '{"items":[1,"two"],"preserved":true}'

run_prepare_for_ref "v6.1.0-beta.1" "out-prerelease"
prerelease_short=$(printf '%s' "$main_commit" | cut -c 1-7)
assert_prepare_commit "out-prerelease" "$main_commit"
assert_prepare_version "out-prerelease" "6.1.0-beta.1+manager.$prerelease_short"

run_prepare_for_ref "main" "out-main"
main_short=$(printf '%s' "$main_commit" | cut -c 1-7)
assert_prepare_commit "out-main" "$main_commit"
assert_prepare_version "out-main" "0.0.0-main+manager.$main_short"
assert_prepare_upstream_manifest_version "out-main" "6.0.3"

run_prepare_for_ref "feature/foo" "out-feature"
feature_short=$(printf '%s' "$feature_commit" | cut -c 1-7)
assert_prepare_commit "out-feature" "$feature_commit"
assert_prepare_version "out-feature" "0.0.0-ref-feature-foo+manager.$feature_short"

run_prepare_for_ref "042" "out-leading-zero"
leading_zero_short=$(printf '%s' "$leading_zero_commit" | cut -c 1-7)
assert_prepare_commit "out-leading-zero" "$leading_zero_commit"
assert_prepare_version "out-leading-zero" "0.0.0-ref-042+manager.$leading_zero_short"

run_prepare_for_ref "v5.0.0" "out-legacy"
legacy_short=$(printf '%s' "$legacy_commit" | cut -c 1-7)
assert_prepare_commit "out-legacy" "$legacy_commit"
assert_prepare_version "out-legacy" "5.0.0+manager.$legacy_short"
assert_prepare_upstream_manifest_version "out-legacy" ""
assert_manifest_path "out-legacy" "skills" "./skills/"
assert_manifest_lacks_key "out-legacy" "hooks"
if [ -e "$tmpdir/out-legacy/hooks" ]; then
  echo "legacy fallback plugin must not contain a hooks/ directory" >&2
  exit 1
fi

run_prepare_for_ref "$feature_commit" "out-raw"
assert_prepare_commit "out-raw" "$feature_commit"
assert_prepare_version "out-raw" "0.0.0+manager.$feature_short"

assert_bad_manifest_error "out-bad-manifest"
assert_rejected_manifest_input "nonstandard-json" "out-nonstandard-json" "invalid JSON in"
assert_rejected_manifest_input "unreadable-manifest" "out-unreadable-manifest" "cannot read JSON in"
assert_rejected_manifest_input "unencodable-manifest-version" "out-unencodable-version" "cannot output JSON value from"
assert_rejected_manifest_input "deeply-nested-json" "out-deeply-nested" "JSON nesting exceeds limit in"

unreadable_json="$tmpdir/json-directory"
mkdir "$unreadable_json"
printf 'sentinel\n' > "$unreadable_json/sentinel"
if ( . "$root/scripts/lib.sh"; spw_json_get "$unreadable_json" version ) \
  >"$tmpdir/unreadable-json.out" 2>"$tmpdir/unreadable-json.err"; then
  echo "JSON helper unexpectedly accepted an unreadable file" >&2
  exit 1
fi
grep -Fq "cannot read JSON in $unreadable_json" "$tmpdir/unreadable-json.err"
if grep -q 'Traceback' "$tmpdir/unreadable-json.err"; then
  echo "unreadable JSON error must not include a Python traceback" >&2
  cat "$tmpdir/unreadable-json.err" >&2
  exit 1
fi

output="$tmpdir/out-latest"
metadata="$output/.superpowers-upstream.json"
manifest="$output/.codex-plugin/plugin.json"

test -f "$output/skills/brainstorming/SKILL.md"
test -f "$output/assets/superpowers-small.svg"
# The fake upstream ships hooks/, but the wrapper's generated-tree contract is
# deliberately hook-free: no manifest hooks key and no physical hooks/ directory.
if [ -e "$output/hooks" ]; then
  echo "generated plugin must not contain a hooks/ directory" >&2
  exit 1
fi
test -f "$output/LICENSE"
test -f "$output/README.md"
test -f "$output/CODE_OF_CONDUCT.md"
# The atomic swap replaces the whole plugin root, so the staged tree must
# carry the committed manifest template forward (it is a tracked file living
# in the plugin root); otherwise a real prepare would delete it.
test -f "$output/.codex-plugin/plugin.template.json"

assert_manifest_lacks_key "out-latest" "hooks"

# Empty HOME and an unset/empty override must use only the shipped validator.
if [ -e "$home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" ]; then
  echo "test HOME must not provide the Codex plugin-creator validator" >&2
  exit 1
fi

# The template must already be in the candidate when validation runs.
: > "$validator_log"
additional_out="$tmpdir/additional.out"
SUPERPOWERS_REF="latest-release" \
SUPERPOWERS_UPSTREAM_URL="$upstream" \
SUPERPOWERS_CACHE_DIR="$tmpdir/cache-additional" \
SUPERPOWERS_PLUGIN_ROOT="$tmpdir/out-additional" \
SUPERPOWERS_VALIDATOR="$additional_validator" \
SUPERPOWERS_FAKE_VALIDATOR_LOG="$validator_log" \
HOME="$home" \
sh "$root/scripts/prepare" >"$additional_out"
builtin_line=$(grep -Fn "generated plugin validation passed" "$additional_out" | head -n1 | cut -d: -f1)
additional_line=$(grep -Fn "additional validator ran" "$additional_out" | head -n1 | cut -d: -f1)
[ "$builtin_line" -lt "$additional_line" ] || {
  echo "built-in validation must run before the additional validator" >&2
  cat "$additional_out" >&2
  exit 1
}
[ -s "$validator_log" ] || { echo "explicit additional validator did not run" >&2; exit 1; }

# A configured additional validator path must exist.
if SUPERPOWERS_REF="latest-release" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_CACHE_DIR="$tmpdir/cache-missing-additional" \
  SUPERPOWERS_PLUGIN_ROOT="$tmpdir/out-missing-additional" \
  SUPERPOWERS_VALIDATOR="$tmpdir/does-not-exist.py" \
  HOME="$home" \
  sh "$root/scripts/prepare" >"$tmpdir/missing-additional.out" 2>&1; then
  echo "prepare unexpectedly accepted a missing additional validator" >&2
  exit 1
fi
grep -Fq "additional plugin validator not found" "$tmpdir/missing-additional.out"

# A built-in failure must prevent the additional validator and the atomic swap.
: > "$validator_log"
cp -R "$tmpdir/out-latest" "$tmpdir/out-invalid-skill"
printf 'preserve me\n' > "$tmpdir/out-invalid-skill/preexisting-sentinel"
unrelated_tmp="$tmpdir/.superpowers.tmp.unrelated"
prepare_pid_file="$tmpdir/invalid-skill.pid"
mkdir -p "$unrelated_tmp"
printf 'leave me\n' > "$unrelated_tmp/sentinel"
if SUPERPOWERS_REF="invalid-skill" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_CACHE_DIR="$tmpdir/cache-invalid-skill" \
  SUPERPOWERS_PLUGIN_ROOT="$tmpdir/out-invalid-skill" \
  SUPERPOWERS_VALIDATOR="$additional_validator" \
  SUPERPOWERS_FAKE_VALIDATOR_LOG="$validator_log" \
  PREPARE_PID_FILE="$prepare_pid_file" \
  HOME="$home" \
  sh -c 'printf "%s\n" "$$" > "$PREPARE_PID_FILE"; exec sh "$1"' \
    sh "$root/scripts/prepare" \
    >"$tmpdir/invalid-skill.out" 2>"$tmpdir/invalid-skill.err"; then
  echo "prepare unexpectedly accepted invalid skill frontmatter" >&2
  exit 1
fi
grep -Fq "exactly one top-level \`description:\`" "$tmpdir/invalid-skill.err"
prepare_pid=$(cat "$prepare_pid_file")
[ ! -e "$tmpdir/.superpowers.tmp.$prepare_pid" ] || {
  echo "built-in failure must remove its staged plugin tree" >&2
  exit 1
}
[ -f "$unrelated_tmp/sentinel" ] || {
  echo "built-in failure must not remove another invocation's staged tree" >&2
  exit 1
}
[ ! -s "$validator_log" ] || {
  echo "additional validator must not run after built-in failure" >&2
  exit 1
}
[ -f "$tmpdir/out-invalid-skill/preexisting-sentinel" ] || {
  echo "built-in failure must preserve the previous generated tree" >&2
  exit 1
}

template_after=$(cksum "$template")
if [ "$template_before" != "$template_after" ]; then
  echo "prepare test must not mutate the committed manifest template" >&2
  exit 1
fi

echo "test_prepare_with_fake_upstream: OK"
