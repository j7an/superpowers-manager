#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
spw_test_tmpdir
tmpdir_physical=$(CDPATH= cd -- "$tmpdir" && pwd -P)

upstream="$tmpdir/upstream"
output="$tmpdir/out"
home="$tmpdir/home"
pkg="$root"
template="$root/plugins/superpowers/.codex-plugin/plugin.template.json"
template_before=$(cksum "$template")
adapter_log="$tmpdir/adapter.log"
recording_adapter="$tmpdir/recording-adapter"
git_log="$tmpdir/git.log"
git_tool_path="$tmpdir/git-tool-path"
python3_log="$tmpdir/python3.log"
real_python3=$(command -v python3)
real_git=$(command -v git)

cat > "$recording_adapter" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SPW_TEST_ADAPTER_LOG"
exec "$SPW_TEST_REAL_ADAPTER" "$@"
EOF
chmod +x "$recording_adapter"

mkdir -p "$git_tool_path"
cat > "$git_tool_path/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SPW_TEST_GIT_LOG"
exec "$SPW_TEST_REAL_GIT" "$@"
EOF
chmod +x "$git_tool_path/git"

cat > "$tmpdir/python3" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$SPW_TEST_PYTHON3_LOG"
done
exec "$SPW_TEST_REAL_PYTHON3" "$@"
EOF
chmod +x "$tmpdir/python3"

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
if any(name.startswith(".adapter-build") for _, dirs, _ in os.walk(plugin_root) for name in dirs):
    print("adapter build scratch leaked into the exact candidate", file=sys.stderr)
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
spw_git_commit "$upstream" "fake upstream without manifest"
spw_git_tag "$upstream" v5.0.0 "fake legacy release"
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
spw_git_commit "$upstream" "fake upstream with manifest"
spw_git_tag "$upstream" v6.0.3 "fake release"

release_commit=$(git -C "$upstream" rev-list -n1 v6.0.3)
git -C "$upstream" branch -M main

printf 'branch data\n' > "$upstream/skills/brainstorming/branch.txt"
git -C "$upstream" add skills/brainstorming/branch.txt
spw_git_commit "$upstream" "main branch update"
main_commit=$(git -C "$upstream" rev-parse HEAD)
spw_git_tag "$upstream" v6.1.0-beta.1 "fake prerelease"

git -C "$upstream" checkout -b invalid-skill >/dev/null
cat > "$upstream/skills/brainstorming/SKILL.md" <<'EOF'
---
name: brainstorming
---
# Missing description
EOF
git -C "$upstream" add skills/brainstorming/SKILL.md
spw_git_commit "$upstream" "invalid skill frontmatter"
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
spw_git_commit "$upstream" "nonstandard manifest JSON"
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b unreadable-manifest >/dev/null
printf '\377' > "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "non-UTF-8 manifest"
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
spw_git_commit "$upstream" "unencodable manifest version"
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
spw_git_commit "$upstream" "deeply nested manifest JSON"
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b feature/foo >/dev/null
printf 'feature data\n' > "$upstream/skills/brainstorming/feature.txt"
git -C "$upstream" add skills/brainstorming/feature.txt
spw_git_commit "$upstream" "feature branch update"
feature_commit=$(git -C "$upstream" rev-parse HEAD)

git -C "$upstream" checkout -b 042 >/dev/null
printf 'leading zero ref\n' > "$upstream/skills/brainstorming/leading-zero.txt"
git -C "$upstream" add skills/brainstorming/leading-zero.txt
spw_git_commit "$upstream" "leading zero branch"
leading_zero_commit=$(git -C "$upstream" rev-parse HEAD)
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b bad-manifest >/dev/null
printf '{ "name": "superpowers", "version": ' > "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "bad upstream manifest"
git -C "$upstream" checkout main >/dev/null

json_string() {
  python3 -S -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"
}

assert_json_string() {
  spw_assert_json equal "$1" "$2" "$(json_string "$3")"
}

assert_manifest_json() {
  destination=$1
  pointer=$2
  expected_json=$3
  spw_assert_json equal \
    "$tmpdir/$destination/.codex-plugin/plugin.json" \
    "$pointer" "$expected_json"
}

assert_manifest_lacks_key() {
  destination=$1
  key=$2
  spw_assert_json absent \
    "$tmpdir/$destination/.codex-plugin/plugin.json" "/$key"
}

run_prepare_for_ref_with_env() {
  ref="$1"
  destination="$2"
  shift 2
  env \
    SUPERPOWERS_REF="$ref" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
    SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
    SUPERPOWERS_CODEX="$tmpdir/missing-codex" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    "$@" \
    sh "$root/scripts/prepare" >/dev/null
}

run_prepare_for_ref() {
  run_prepare_for_ref_with_env "$1" "$2"
}

assert_bad_manifest_error() {
  destination="$1"
  err="$tmpdir/$destination.err"
  mkdir -p "$tmpdir/$destination"
  printf 'preserve me\n' > "$tmpdir/$destination/preexisting-sentinel"
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
  [ -f "$tmpdir/$destination/preexisting-sentinel" ] || {
    echo "malformed upstream manifest must fail before swapping the live tree" >&2
    exit 1
  }
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
  assert_json_string \
    "$tmpdir/$destination/.codex-plugin/plugin.json" "/version" "$expected"
}

assert_prepare_commit() {
  destination="$1"
  expected="$2"
  assert_json_string \
    "$tmpdir/$destination/.superpowers-upstream.json" "/commit" "$expected"
}

assert_prepare_upstream_manifest_version() {
  destination="$1"
  expected="$2"
  assert_json_string \
    "$tmpdir/$destination/.superpowers-upstream.json" \
    "/upstream_manifest_version" "$expected"
}

assert_prepare_metadata_value() {
  destination="$1"
  key="$2"
  expected="$3"
  assert_json_string \
    "$tmpdir/$destination/.superpowers-upstream.json" "/$key" "$expected"
}

run_prepare_with_saved_selection() {
  config_dir="$1"
  destination="$2"
  shift 2
  env -u SUPERPOWERS_REF -u SUPERPOWERS_UPSTREAM_URL \
    PATH="$git_tool_path:$PATH" \
    SUPERPOWERS_CONFIG_DIR="$config_dir" \
    SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
    SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    SPW_ADAPTER="$recording_adapter" \
    SPW_TEST_ADAPTER_LOG="$adapter_log" \
    SPW_TEST_REAL_ADAPTER="$root/scripts/adapters/codex/adapter" \
    SPW_TEST_GIT_LOG="$git_log" \
    SPW_TEST_REAL_GIT="$real_git" \
    "$@" \
    sh "$root/scripts/prepare" >/dev/null
}

# A saved exact pin supplies the requested/resolved/commit record directly.
# Prepare must fetch that exact object from the effective source without
# re-resolving the saved tag, then pass the same record into provenance/build.
saved_config="$tmpdir/saved-config"
python3 -S "$root/scripts/core/selection-state.py" write-pinned \
  --path "$saved_config/selection.json" --source "$upstream" \
  --requested-ref v6.0.3 --resolved-ref v6.0.3 --commit "$release_commit"
: > "$adapter_log"
: > "$git_log"
run_prepare_with_saved_selection "$saved_config" "out-saved-pin"
assert_prepare_commit "out-saved-pin" "$release_commit"
assert_prepare_metadata_value "out-saved-pin" source "$upstream"
assert_prepare_metadata_value "out-saved-pin" requested_ref v6.0.3
assert_prepare_metadata_value "out-saved-pin" resolved_ref v6.0.3
if grep -Fq 'ls-remote' "$git_log"; then
  echo "saved exact pin must not be re-resolved" >&2
  cat "$git_log" >&2
  exit 1
fi
grep -Fq -- "fetch --no-tags -- $upstream $release_commit" "$git_log"
grep -Fq -- "--requested-ref v6.0.3 --resolved-ref v6.0.3 --commit $release_commit" "$adapter_log"

# A source override that cannot supply the saved commit must fail even when the
# persistent cache was primed by the original source. Failure precedes adapter
# access and generated-tree replacement.
empty_upstream="$tmpdir/empty-upstream"
git init --bare "$empty_upstream" >/dev/null
test "$(git -C "$tmpdir/cache-out-saved-pin/superpowers" cat-file -t "$release_commit")" = commit
printf 'preserve me\n' > "$tmpdir/out-saved-pin/preexisting-sentinel"
: > "$adapter_log"
: > "$git_log"
if run_prepare_with_saved_selection "$saved_config" "out-saved-pin" \
    SUPERPOWERS_UPSTREAM_URL="$empty_upstream" \
    >"$tmpdir/source-proof.out" 2>"$tmpdir/source-proof.err"; then
  echo "prepare unexpectedly used a cached object as source proof" >&2
  exit 1
fi
grep -Fq "source cannot supply requested commit: $release_commit" \
  "$tmpdir/source-proof.err"
test -f "$tmpdir/out-saved-pin/preexisting-sentinel"
test ! -s "$adapter_log"

# Ref/source overrides remain independent. An environment ref uses the saved
# source; an environment source can supply the still-authoritative saved pin.
: > "$git_log"
run_prepare_with_saved_selection "$saved_config" "out-mixed-ref" \
  SUPERPOWERS_REF=main
assert_prepare_commit "out-mixed-ref" "$main_commit"
assert_prepare_metadata_value "out-mixed-ref" source "$upstream"
assert_prepare_metadata_value "out-mixed-ref" requested_ref main

alternate_upstream="$tmpdir/alternate-upstream"
git clone --bare "$upstream" "$alternate_upstream" >/dev/null 2>&1
: > "$git_log"
run_prepare_with_saved_selection "$saved_config" "out-mixed-source" \
  SUPERPOWERS_UPSTREAM_URL="$alternate_upstream"
assert_prepare_commit "out-mixed-source" "$release_commit"
assert_prepare_metadata_value "out-mixed-source" source "$alternate_upstream"
assert_prepare_metadata_value "out-mixed-source" requested_ref v6.0.3
if grep -Fq 'ls-remote' "$git_log"; then
  echo "environment source must not cause a saved pin to be re-resolved" >&2
  exit 1
fi

# A dash-prefixed local source saved by track-latest remains usable by prepare
# for both the initial clone and a later cache fetch.
ln -s upstream "$tmpdir/-upstream"
dash_config="$tmpdir/dash-config"
(
  cd "$tmpdir"
  SUPERPOWERS_CONFIG_DIR="$dash_config" SUPERPOWERS_UPSTREAM_URL=-upstream \
    sh "$root/scripts/track-latest" >/dev/null
)
: > "$git_log"
(
  cd "$tmpdir"
  run_prepare_with_saved_selection "$dash_config" "out-dash-source"
  run_prepare_with_saved_selection "$dash_config" "out-dash-source"
)
assert_prepare_commit "out-dash-source" "$release_commit"
assert_prepare_metadata_value "out-dash-source" source -upstream
grep -Fq -- "ls-remote --tags -- $tmpdir_physical/-upstream refs/tags/v*" "$git_log"
grep -Fq -- "clone -- $tmpdir_physical/-upstream $tmpdir/cache-out-dash-source/superpowers" \
  "$git_log"
grep -Fq -- \
  "fetch --tags --prune -- $tmpdir_physical/-upstream" "$git_log"

# Unsafe or invalid selection state fails before any Git or adapter access and
# preserves the previous generated tree.
assert_prepare_preflight_failure() {
  config_dir="$1"
  destination="$2"
  expected="$3"
  shift 3
  mkdir -p "$tmpdir/$destination"
  printf '%s\n' 'preserve me' > "$tmpdir/$destination/preexisting-sentinel"
  : > "$adapter_log"
  : > "$git_log"
  if run_prepare_with_saved_selection "$config_dir" "$destination" "$@" \
      >"$tmpdir/$destination.out" 2>"$tmpdir/$destination.err"; then
    echo "prepare unexpectedly accepted invalid selection preflight" >&2
    exit 1
  fi
  grep -Fq "$expected" "$tmpdir/$destination.err"
  test ! -s "$git_log"
  test ! -s "$adapter_log"
  test -f "$tmpdir/$destination/preexisting-sentinel"
}

malformed_config="$tmpdir/malformed-config"
mkdir -p "$malformed_config"
printf '%s\n' '{' > "$malformed_config/selection.json"
assert_prepare_preflight_failure "$malformed_config" "out-malformed-selection" \
  'invalid JSON' SUPERPOWERS_REF="$release_commit" SUPERPOWERS_UPSTREAM_URL="$upstream"

unsupported_config="$tmpdir/unsupported-config"
mkdir -p "$unsupported_config"
printf '%s\n' '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' \
  > "$unsupported_config/selection.json"
assert_prepare_preflight_failure "$unsupported_config" "out-unsupported-selection" \
  'schema_version must equal integer 1' \
  SUPERPOWERS_REF="$release_commit" SUPERPOWERS_UPSTREAM_URL="$upstream"

assert_prepare_preflight_failure "$tmpdir/no-selection" "out-unsafe-source" \
  'HTTP(S) source must not include userinfo' \
  SUPERPOWERS_REF="$release_commit" \
  SUPERPOWERS_UPSTREAM_URL='https://token@example.invalid/repo'

: > "$adapter_log"
run_prepare_for_ref_with_env "latest-release" "out-recorded" \
  SPW_ADAPTER="$recording_adapter" \
  SPW_TEST_ADAPTER_LOG="$adapter_log" \
  SPW_TEST_REAL_ADAPTER="$root/scripts/adapters/codex/adapter"
recorded_upstream_root="$tmpdir/cache-out-recorded/superpowers"
grep -Fq "build --upstream-root $recorded_upstream_root" "$adapter_log"
grep -Fq -- "--upstream-manifest-version 6.0.3" "$adapter_log"
grep -Fq -- "--fallback-manifest $pkg/plugins/superpowers/.codex-plugin/plugin.template.json" "$adapter_log"

relative_workdir="$tmpdir/relative-workdir"
relative_adapter_log="$tmpdir/relative-adapter.log"
mkdir -p "$relative_workdir"
relative_workdir_physical=$(CDPATH= cd -- "$relative_workdir" && pwd -P)
: > "$relative_adapter_log"
(
  cd "$relative_workdir"
  env \
    SUPERPOWERS_REF="latest-release" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CACHE_DIR="cache-relative" \
    SUPERPOWERS_PLUGIN_ROOT="out-relative" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    SPW_ADAPTER="$recording_adapter" \
    SPW_TEST_ADAPTER_LOG="$relative_adapter_log" \
    SPW_TEST_REAL_ADAPTER="$root/scripts/adapters/codex/adapter" \
    sh "$root/scripts/prepare" >/dev/null
)
grep -Fq \
  "build --upstream-root $relative_workdir_physical/cache-relative/superpowers --candidate-root $relative_workdir_physical/.superpowers.prepare." \
  "$relative_adapter_log"
grep -Fq "/superpowers --requested-ref" "$relative_adapter_log"
test -f "$relative_workdir/out-relative/.codex-plugin/plugin.json"
test -f "$relative_workdir/out-relative/.superpowers-upstream.json"

: > "$python3_log"
run_prepare_for_ref_with_env "latest-release" "out-latest" \
  PATH="$tmpdir:$PATH" \
  SPW_TEST_PYTHON3_LOG="$python3_log" \
  SPW_TEST_REAL_PYTHON3="$real_python3"
latest_upstream_root="$tmpdir/cache-out-latest/superpowers"
manifest_read_count=$(grep -Fxc "$latest_upstream_root/.codex-plugin/plugin.json" "$python3_log" || true)
[ "$manifest_read_count" -eq 1 ] || {
  echo "core must read $latest_upstream_root/.codex-plugin/plugin.json exactly once" >&2
  cat "$python3_log" >&2
  exit 1
}
expected_short=$(printf '%s' "$release_commit" | cut -c 1-7)
assert_prepare_commit "out-latest" "$release_commit"
assert_prepare_version "out-latest" "6.0.3+manager.$expected_short"
assert_manifest_json \
  "out-latest" "/description" "$(json_string "Upstream manifest description")"
assert_manifest_json "out-latest" "/skills" "$(json_string "./skills/")"
assert_manifest_json \
  "out-latest" "/x_future_manifest" '{"items":[1,"two"],"preserved":true}'

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
assert_manifest_json "out-legacy" "/skills" "$(json_string "./skills/")"
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
if ( . "$root/scripts/core/common.sh"; . "$root/scripts/core/provenance.sh"; spw_json_get "$unreadable_json" version ) \
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
# The fake upstream ships hooks/, but the manager's generated-tree contract is
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
if find "$tmpdir" -maxdepth 1 -name '.superpowers.prepare.*' -print | grep -q .; then
  echo "built-in failure must remove its staged plugin tree" >&2
  exit 1
fi
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
