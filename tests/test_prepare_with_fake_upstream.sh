#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

upstream="$tmpdir/upstream"
output="$tmpdir/out"
home="$tmpdir/home"
validator_log="$tmpdir/validator.log"
template="$root/plugins/superpowers/.codex-plugin/plugin.template.json"
template_before=$(cksum "$template")

mkdir -p "$upstream/skills/brainstorming" "$upstream/assets" "$upstream/hooks"
mkdir -p "$home/.codex/skills/.system/plugin-creator/scripts"
cat > "$home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" <<'PY'
import os
import sys

plugin_root = sys.argv[1]
manifest = os.path.join(plugin_root, ".codex-plugin", "plugin.json")
if not os.path.isfile(manifest):
    print(f"missing manifest: {manifest}", file=sys.stderr)
    sys.exit(1)

log = os.environ["SUPERPOWERS_FAKE_VALIDATOR_LOG"]
with open(log, "a", encoding="utf-8") as f:
    f.write(plugin_root + "\n")
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
  SUPERPOWERS_FAKE_VALIDATOR_LOG="$validator_log" \
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
    SUPERPOWERS_FAKE_VALIDATOR_LOG="$validator_log" \
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
assert_prepare_version "out-latest" "6.0.3+wrapper.$expected_short"
assert_manifest_path "out-latest" "description" "Upstream manifest description"
assert_manifest_path "out-latest" "skills" "./skills/"
assert_manifest_path "out-latest" "x_future_manifest" '{"items":[1,"two"],"preserved":true}'

run_prepare_for_ref "v6.1.0-beta.1" "out-prerelease"
prerelease_short=$(printf '%s' "$main_commit" | cut -c 1-7)
assert_prepare_commit "out-prerelease" "$main_commit"
assert_prepare_version "out-prerelease" "6.1.0-beta.1+wrapper.$prerelease_short"

run_prepare_for_ref "main" "out-main"
main_short=$(printf '%s' "$main_commit" | cut -c 1-7)
assert_prepare_commit "out-main" "$main_commit"
assert_prepare_version "out-main" "0.0.0-main+wrapper.$main_short"
assert_prepare_upstream_manifest_version "out-main" "6.0.3"

run_prepare_for_ref "feature/foo" "out-feature"
feature_short=$(printf '%s' "$feature_commit" | cut -c 1-7)
assert_prepare_commit "out-feature" "$feature_commit"
assert_prepare_version "out-feature" "0.0.0-ref-feature-foo+wrapper.$feature_short"

run_prepare_for_ref "042" "out-leading-zero"
leading_zero_short=$(printf '%s' "$leading_zero_commit" | cut -c 1-7)
assert_prepare_commit "out-leading-zero" "$leading_zero_commit"
assert_prepare_version "out-leading-zero" "0.0.0-ref-042+wrapper.$leading_zero_short"

run_prepare_for_ref "v5.0.0" "out-legacy"
legacy_short=$(printf '%s' "$legacy_commit" | cut -c 1-7)
assert_prepare_commit "out-legacy" "$legacy_commit"
assert_prepare_version "out-legacy" "5.0.0+wrapper.$legacy_short"
assert_prepare_upstream_manifest_version "out-legacy" ""
assert_manifest_path "out-legacy" "skills" "./skills/"
assert_manifest_lacks_key "out-legacy" "hooks"
if [ -e "$tmpdir/out-legacy/hooks" ]; then
  echo "legacy fallback plugin must not contain a hooks/ directory" >&2
  exit 1
fi

run_prepare_for_ref "$feature_commit" "out-raw"
assert_prepare_commit "out-raw" "$feature_commit"
assert_prepare_version "out-raw" "0.0.0+wrapper.$feature_short"

assert_bad_manifest_error "out-bad-manifest"

output="$tmpdir/out-latest"
metadata="$output/.superpowers-upstream.json"
manifest="$output/.codex-plugin/plugin.json"

test -f "$output/skills/brainstorming/SKILL.md"
test -f "$output/assets/superpowers-small.svg"
# The fake upstream ships hooks/ (see fixture above), but the generated Codex
# plugin must exclude it entirely: Codex's plugin validator rejects a hooks
# manifest field, and shipping no hooks/ directory means Codex's hooks.json
# auto-discovery has nothing to register.
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

if [ ! -s "$validator_log" ]; then
  echo "prepare did not use the default validator from HOME/.codex" >&2
  exit 1
fi

template_after=$(cksum "$template")
if [ "$template_before" != "$template_after" ]; then
  echo "prepare test must not mutate the committed manifest template" >&2
  exit 1
fi
