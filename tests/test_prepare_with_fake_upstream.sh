#!/bin/sh
set -eu

test_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
. "$test_dir/lib/harness.sh"
spw_test_root
spw_test_tmpdir
tmpdir_physical=$(CDPATH= cd -- "$tmpdir" && pwd -P)

# BASELINE CASE: BUILDER-SYMLINK-01 deterministic broken and escaping symlinks
for symlink_scenario in broken-symlink escaping-symlink; do
  builder_out=$(
    sh "$root/tests/builders/baseline-scenario.sh" "$symlink_scenario" \
      "$tmpdir/$symlink_scenario"
  )
  scenario_root=$(printf '%s\n' "$builder_out" | sed -n 's/^ROOT=//p')
  scenario_target=$(printf '%s\n' "$builder_out" | sed -n 's/^TARGET=//p')
  test -d "$scenario_root"
  test -L "$scenario_target"
done

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
materializer="$root/scripts/adapters/codex/materialize-hooks.py"
grep -Fxq 'from __future__ import annotations' "$materializer"

system_python=/usr/bin/python3
if [ -x "$system_python" ]; then
  system_python_version=$(
    "$system_python" -S -c 'import sys; print("%d.%d" % sys.version_info[:2])'
  )
  if [ "$system_python_version" = "3.9" ]; then
    "$system_python" -S -c '
import runpy
import sys

assert sys.version_info[:2] == (3, 9)
materializer = sys.argv[1]
sys.argv = [materializer, "--help"]
runpy.run_path(materializer, run_name="__main__")
' "$materializer" >/dev/null
  fi
fi

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
mkdir -p "$upstream/hooks/support"
printf 'hook support\n' > "$upstream/hooks/support/helper.txt"
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
cat > "$upstream/hooks/hooks-codex.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{"type": "command", "command": "sh \"${PLUGIN_ROOT}/hooks/session-start-codex\""}]
    }]
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

set_manifest_hooks() {
  mode="$1"
  value="${2:-}"
  python3 -S - "$upstream/.codex-plugin/plugin.json" "$mode" "$value" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
mode = sys.argv[2]
with path.open(encoding="utf-8") as handle:
    manifest = json.load(handle)
if mode == "absent":
    manifest.pop("hooks", None)
else:
    manifest["hooks"] = json.loads(sys.argv[3])
with path.open("w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, allow_nan=False)
    handle.write("\n")
PY
}

write_depth_256_manifest() {
  source="$1"
  destination="$2"
  python3 -S - "$source" "$destination" <<'PY'
import json
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:])
data = json.loads(source.read_text(encoding="utf-8"))
value = 0
for _ in range(255):
    value = [value]
data["x_future_manifest"] = value
destination.write_text(json.dumps(data) + "\n", encoding="utf-8")
PY
}

commit_hook_ref() {
  ref="$1"
  message="$2"
  git -C "$upstream" add -A
  spw_git_commit "$upstream" "$message"
  git -C "$upstream" checkout main >/dev/null
}

git -C "$upstream" checkout -b hooks-empty-object >/dev/null
cp "$root/tests/fixtures/baseline/manifests/upstream-empty-hooks.json" \
  "$upstream/.codex-plugin/plugin.json"
commit_hook_ref hooks-empty-object "manifest explicitly disables hooks"

git -C "$upstream" checkout -b hooks-empty-array >/dev/null
cp "$root/tests/fixtures/baseline/manifests/upstream-default-hooks.json" \
  "$upstream/.codex-plugin/plugin.json"
cp "$upstream/hooks/hooks-codex.json" "$upstream/hooks/hooks.json"
commit_hook_ref hooks-empty-array "empty hook array uses default discovery"

git -C "$upstream" checkout -b hooks-active-fixture >/dev/null
cp "$root/tests/fixtures/baseline/manifests/upstream-active-hooks.json" \
  "$upstream/.codex-plugin/plugin.json"
commit_hook_ref hooks-active-fixture "manifest uses declared upstream hooks"

git -C "$upstream" checkout -b hooks-string-array >/dev/null
set_manifest_hooks value '["./config/hooks-first.json","./alternate/hooks-second.json"]'
mkdir -p "$upstream/config" "$upstream/alternate"
printf '%s\n' '{"fixture":"first"}' > "$upstream/config/hooks-first.json"
printf '%s\n' '{"fixture":"second"}' > "$upstream/alternate/hooks-second.json"
commit_hook_ref hooks-string-array "manifest declares multiple hook paths"

git -C "$upstream" checkout -b hooks-inline >/dev/null
set_manifest_hooks value '{"SessionStart":[{"hooks":[{"type":"command","command":"echo inline"}]}]}'
commit_hook_ref hooks-inline "manifest declares inline hooks"

git -C "$upstream" checkout -b hooks-inline-array >/dev/null
set_manifest_hooks value '[{"SessionStart":[{"hooks":[{"type":"command","command":"echo inline array"}]}]}]'
commit_hook_ref hooks-inline-array "manifest declares an inline hook array"

git -C "$upstream" checkout -b hooks-default >/dev/null
cp "$root/tests/fixtures/baseline/manifests/upstream-no-hooks.json" \
  "$upstream/.codex-plugin/plugin.json"
cp "$upstream/hooks/hooks-codex.json" "$upstream/hooks/hooks.json"
commit_hook_ref hooks-default "manifest uses default hook discovery"

git -C "$upstream" checkout -b hooks-absent >/dev/null
set_manifest_hooks absent
commit_hook_ref hooks-absent "manifest omits hooks without a default config"

git -C "$upstream" checkout -b hooks-outside-path >/dev/null
set_manifest_hooks value '"./config/hooks-codex.json"'
mkdir -p "$upstream/config"
cp "$upstream/hooks/hooks-codex.json" "$upstream/config/hooks-codex.json"
commit_hook_ref hooks-outside-path "manifest declares hook config outside hooks subtree"

git -C "$upstream" checkout -b hooks-scalar >/dev/null
set_manifest_hooks value '42'
commit_hook_ref hooks-scalar "manifest declares scalar hooks"

git -C "$upstream" checkout -b hooks-mixed-array >/dev/null
set_manifest_hooks value '["./hooks/hooks-codex.json",{}]'
commit_hook_ref hooks-mixed-array "manifest declares mixed hooks array"

git -C "$upstream" checkout -b hooks-unprefixed >/dev/null
set_manifest_hooks value '"hooks/hooks-codex.json"'
commit_hook_ref hooks-unprefixed "manifest declares unprefixed hook path"

git -C "$upstream" checkout -b hooks-absolute >/dev/null
set_manifest_hooks value '"/tmp/hooks-codex.json"'
commit_hook_ref hooks-absolute "manifest declares absolute hook path"

git -C "$upstream" checkout -b hooks-traversal >/dev/null
set_manifest_hooks value '"./../outside-hooks.json"'
commit_hook_ref hooks-traversal "manifest declares traversing hook path"

git -C "$upstream" checkout -b hooks-missing >/dev/null
set_manifest_hooks value '"./hooks/missing.json"'
commit_hook_ref hooks-missing "manifest declares missing hook file"

git -C "$upstream" checkout -b hooks-directory >/dev/null
set_manifest_hooks value '"./hooks"'
commit_hook_ref hooks-directory "manifest declares hook directory as file"

git -C "$upstream" checkout -b hooks-declared-symlink-escape >/dev/null
set_manifest_hooks value '"./hooks/declared-escape"'
ln -s "$tmpdir/outside-declared-hook" "$upstream/hooks/declared-escape"
printf 'outside declared hook\n' > "$tmpdir/outside-declared-hook"
commit_hook_ref hooks-declared-symlink-escape "declared hook symlink escapes upstream"

git -C "$upstream" checkout -b hooks-subtree-symlink-escape >/dev/null
ln -s ../../outside "$upstream/hooks/escape"
commit_hook_ref hooks-subtree-symlink-escape "hook subtree contains escaping symlink"

git -C "$upstream" checkout -b hooks-contained-symlink >/dev/null
mkdir -p "$upstream/bin"
printf 'contained target\n' > "$upstream/bin/target"
ln -s ../bin/target "$upstream/hooks/contained"
commit_hook_ref hooks-contained-symlink "hook subtree contains source-contained symlink"

git -C "$upstream" checkout -b hooks-dangling-symlink >/dev/null
ln -s missing-target "$upstream/hooks/dangling"
commit_hook_ref hooks-dangling-symlink "hook subtree contains dangling symlink"

git -C "$upstream" checkout -b hooks-root-contained-materialized >/dev/null
rm -rf "$upstream/hooks"
mkdir -p "$upstream/assets/hook-root"
printf 'materialized root target\n' > "$upstream/assets/hook-root/root-hook.txt"
ln -s assets/hook-root "$upstream/hooks"
set_manifest_hooks value '{"SessionStart":[]}'
commit_hook_ref hooks-root-contained-materialized \
  "hook root targets candidate materialized content"

git -C "$upstream" checkout -b hooks-root-contained-source-only >/dev/null
rm -rf "$upstream/hooks"
ln -s .git "$upstream/hooks"
set_manifest_hooks value '{"SessionStart":[]}'
commit_hook_ref hooks-root-contained-source-only \
  "hook root targets source only checkout content"

git -C "$upstream" checkout -b hooks-root-absolute-symlink >/dev/null
rm -rf "$upstream/hooks"
ln -s "$tmpdir" "$upstream/hooks"
set_manifest_hooks value '{"SessionStart":[]}'
commit_hook_ref hooks-root-absolute-symlink "hook root is an absolute symlink"

git -C "$upstream" checkout -b hooks-root-broken-symlink >/dev/null
rm -rf "$upstream/hooks"
ln -s missing-hooks "$upstream/hooks"
set_manifest_hooks value '{"SessionStart":[]}'
commit_hook_ref hooks-root-broken-symlink "hook root is a broken relative symlink"

git -C "$upstream" checkout -b hooks-root-escape-symlink >/dev/null
rm -rf "$upstream/hooks"
ln -s .. "$upstream/hooks"
set_manifest_hooks value '{"SessionStart":[]}'
commit_hook_ref hooks-root-escape-symlink "hook root is an escaping relative symlink"

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

git -C "$upstream" checkout -b reader-depth-257 >/dev/null
cp "$root/tests/fixtures/baseline/selection/depth-257.json" \
  "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "manifest reader depth 257"
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b reader-depth-256 >/dev/null
write_depth_256_manifest \
  "$root/tests/fixtures/baseline/manifests/upstream-active-hooks.json" \
  "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "manifest reader depth 256"
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b reader-duplicate >/dev/null
cp "$root/tests/fixtures/baseline/manifests/candidate-duplicate-key.json" \
  "$upstream/.codex-plugin/plugin.json"
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "manifest reader duplicate key"
git -C "$upstream" checkout main >/dev/null

git -C "$upstream" checkout -b reader-large >/dev/null
python3 -S - "$upstream/.codex-plugin/plugin.json" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text(
    path.read_text(encoding="utf-8") + " " * (1_048_576 + 1),
    encoding="utf-8",
)
PY
git -C "$upstream" add .codex-plugin/plugin.json
spw_git_commit "$upstream" "manifest reader large valid input"
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

assert_generated_tree_matches() {
  destination=$1
  fixture=$2
  actual="$tmpdir/$destination.tree.txt"
  python3 -S - "$tmpdir/$destination" "$actual" <<'PY'
from pathlib import Path
import sys

root, output = map(Path, sys.argv[1:])
paths = []
for path in root.rglob("*"):
    relative = path.relative_to(root).as_posix()
    paths.append(relative + "/" if path.is_dir() else relative)
output.write_text("\n".join(sorted(paths)) + "\n", encoding="utf-8")
PY
  if ! cmp -s "$fixture" "$actual"; then
    echo "generated tree does not match fixture: $fixture" >&2
    diff -u "$fixture" "$actual" >&2 || true
    exit 1
  fi
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

assert_hook_prepare_failure() {
  ref="$1"
  destination="$2"
  expected="$3"
  err="$tmpdir/$destination.err"
  mkdir -p "$tmpdir/$destination"
  printf 'preserve me\n' > "$tmpdir/$destination/preexisting-sentinel"
  if SUPERPOWERS_REF="$ref" \
    SUPERPOWERS_UPSTREAM_URL="$upstream" \
    SUPERPOWERS_CACHE_DIR="$tmpdir/cache-$destination" \
    SUPERPOWERS_PLUGIN_ROOT="$tmpdir/$destination" \
    SUPERPOWERS_VALIDATOR= \
    HOME="$home" \
    sh "$root/scripts/prepare" >"$tmpdir/$destination.out" 2>"$err"; then
    echo "prepare unexpectedly accepted invalid hook packaging: $ref" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$err"; then
    echo "hook packaging error did not contain expected diagnostic: $expected" >&2
    cat "$err" >&2
    exit 1
  fi
  if grep -q 'Traceback' "$err"; then
    echo "hook packaging error must not include a Python traceback" >&2
    cat "$err" >&2
    exit 1
  fi
  [ -f "$tmpdir/$destination/preexisting-sentinel" ] || {
    echo "hook packaging failure must preserve the previous generated tree" >&2
    exit 1
  }
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

# BASELINE CASE: MANIFEST-READER-MATERIALIZE-01 hook materializer profile
materialize_root="$tmpdir/materialize-reader"
materialize_upstream="$materialize_root/upstream"
materialize_candidate="$materialize_root/candidate"
materialize_manifest="$materialize_candidate/.codex-plugin/plugin.json"
mkdir -p "$materialize_upstream" \
  "$materialize_candidate/.codex-plugin"
run_materializer() {
  python3 -S "$root/scripts/adapters/codex/materialize-hooks.py" \
    --manifest "$materialize_manifest" \
    --manifest-source upstream \
    --upstream-root "$materialize_upstream" \
    --candidate-root "$materialize_candidate"
}
cp "$root/tests/fixtures/baseline/manifests/candidate-non-standard-constant.json" \
  "$materialize_manifest"
if run_materializer >"$materialize_root/constant.out" 2>&1; then
  echo "hook materializer accepted a non-standard constant" >&2
  exit 1
fi
grep -Fq 'non-standard numeric constant' "$materialize_root/constant.out"
cp "$root/tests/fixtures/baseline/selection/depth-257.json" \
  "$materialize_manifest"
if run_materializer >"$materialize_root/depth.out" 2>&1; then
  echo "hook materializer accepted depth 257" >&2
  exit 1
fi
grep -Fq 'JSON nesting exceeds limit' "$materialize_root/depth.out"
write_depth_256_manifest \
  "$root/tests/fixtures/baseline/manifests/candidate-unknown-field.json" \
  "$materialize_manifest"
run_materializer
cp "$root/tests/fixtures/baseline/manifests/candidate-duplicate-key.json" \
  "$materialize_manifest"
run_materializer
python3 -S - \
  "$root/tests/fixtures/baseline/manifests/candidate-unknown-field.json" \
  "$materialize_manifest" <<'PY'
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:])
destination.write_text(
    source.read_text(encoding="utf-8") + " " * (1_048_576 + 1),
    encoding="utf-8",
)
PY
run_materializer

# BASELINE CASE: MANIFEST-READER-OVERLAY-01 manifest overlay profile
. "$root/scripts/adapters/codex/lib.sh"
overlay_manifest="$tmpdir/overlay-reader.json"
cp "$root/tests/fixtures/baseline/manifests/candidate-non-standard-constant.json" \
  "$overlay_manifest"
if spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456" \
    >"$tmpdir/overlay-constant.out" 2>&1; then
  echo "manifest overlay accepted a non-standard constant" >&2
  exit 1
fi
grep -Fq 'non-standard numeric constant' "$tmpdir/overlay-constant.out"
printf '%s\n' '[]' > "$overlay_manifest"
if spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456" \
    >"$tmpdir/overlay-object.out" 2>&1; then
  echo "manifest overlay accepted a non-object" >&2
  exit 1
fi
grep -Fq 'manifest must be a JSON object' "$tmpdir/overlay-object.out"
cp "$root/tests/fixtures/baseline/selection/depth-257.json" \
  "$overlay_manifest"
if spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456" \
    >"$tmpdir/overlay-depth.out" 2>&1; then
  echo "manifest overlay accepted depth 257" >&2
  exit 1
fi
grep -Fq 'JSON nesting exceeds limit' "$tmpdir/overlay-depth.out"
write_depth_256_manifest \
  "$root/tests/fixtures/baseline/manifests/candidate-unknown-field.json" \
  "$overlay_manifest"
spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456"
spw_assert_json equal "$overlay_manifest" /version '"9.8.7+manager.0123456"'
cp "$root/tests/fixtures/baseline/manifests/candidate-duplicate-key.json" \
  "$overlay_manifest"
spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456"
spw_assert_json equal "$overlay_manifest" /name '"renamed"'
spw_assert_json equal "$overlay_manifest" /version '"9.8.7+manager.0123456"'
spw_assert_json equal "$overlay_manifest" /skills '"./skills/"'
python3 -S - \
  "$root/tests/fixtures/baseline/manifests/candidate-unknown-field.json" \
  "$overlay_manifest" <<'PY'
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:])
destination.write_text(
    source.read_text(encoding="utf-8") + " " * (1_048_576 + 1),
    encoding="utf-8",
)
PY
spw_apply_manifest_overlay "$overlay_manifest" "9.8.7+manager.0123456"
spw_assert_json equal \
  "$overlay_manifest" /x_future_manifest/nested/2 '"preserve-me"'
spw_assert_json equal "$overlay_manifest" /version '"9.8.7+manager.0123456"'

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

# BASELINE CASE: CLI-ENV-PREPARE-PATHS-01 relative prepare paths use invocation cwd
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
assert_manifest_json \
  "out-latest" "/hooks" "$(json_string "./hooks/hooks-codex.json")"
test -f "$tmpdir/out-latest/hooks/hooks-codex.json"
test -f "$tmpdir/out-latest/hooks/session-start-codex"
test -f "$tmpdir/out-latest/hooks/support/helper.txt"

# BASELINE CASE: GENERATED-HOOKS-FORBID-01 explicit empty and fallback stay hook-free
run_prepare_for_ref "hooks-empty-object" "out-hooks-empty-object"
assert_manifest_json "out-hooks-empty-object" "/hooks" '{}'
if [ -e "$tmpdir/out-hooks-empty-object/hooks" ]; then
  echo "an exact empty hooks object must not copy the hooks subtree" >&2
  exit 1
fi

# BASELINE CASE: GENERATED-HOOKS-DEFAULT-01 absent and empty-array default discovery
run_prepare_for_ref "hooks-empty-array" "out-hooks-empty-array"
assert_manifest_json "out-hooks-empty-array" "/hooks" '[]'
test -f "$tmpdir/out-hooks-empty-array/hooks/hooks.json"
test -f "$tmpdir/out-hooks-empty-array/hooks/hooks-codex.json"
test -f "$tmpdir/out-hooks-empty-array/hooks/session-start-codex"
test -f "$tmpdir/out-hooks-empty-array/hooks/support/helper.txt"
# Layout fixtures contain only relative paths, so no dynamic commit, version, or
# source values require normalization.
assert_generated_tree_matches \
  "out-hooks-empty-array" \
  "$root/tests/fixtures/baseline/generated-tree/default-hooks.txt"

# BASELINE CASE: GENERATED-HOOKS-DECLARED-01 declared path and inline hook forms
run_prepare_for_ref "hooks-active-fixture" "out-hooks-active-fixture"
assert_manifest_json \
  "out-hooks-active-fixture" "/hooks" \
  "$(json_string "./hooks/hooks-codex.json")"
assert_manifest_json \
  "out-hooks-active-fixture" "/x_future_manifest" \
  '{"nested":[true,null,"preserve-me"]}'
test -f "$tmpdir/out-hooks-active-fixture/hooks/hooks-codex.json"

run_prepare_for_ref "hooks-string-array" "out-hooks-string-array"
assert_manifest_json \
  "out-hooks-string-array" "/hooks" \
  '["./config/hooks-first.json","./alternate/hooks-second.json"]'
grep -Fxq \
  '{"fixture":"first"}' \
  "$tmpdir/out-hooks-string-array/config/hooks-first.json"
grep -Fxq \
  '{"fixture":"second"}' \
  "$tmpdir/out-hooks-string-array/alternate/hooks-second.json"
assert_generated_tree_matches \
  "out-hooks-string-array" \
  "$root/tests/fixtures/baseline/generated-tree/declared-hooks.txt"

run_prepare_for_ref "hooks-inline" "out-hooks-inline"
assert_manifest_json \
  "out-hooks-inline" "/hooks" \
  '{"SessionStart":[{"hooks":[{"command":"echo inline","type":"command"}]}]}'
test -f "$tmpdir/out-hooks-inline/hooks/hooks-codex.json"
test -f "$tmpdir/out-hooks-inline/hooks/session-start-codex"
test -f "$tmpdir/out-hooks-inline/hooks/support/helper.txt"

run_prepare_for_ref "hooks-inline-array" "out-hooks-inline-array"
assert_manifest_json \
  "out-hooks-inline-array" "/hooks" \
  '[{"SessionStart":[{"hooks":[{"command":"echo inline array","type":"command"}]}]}]'
test -f "$tmpdir/out-hooks-inline-array/hooks/hooks-codex.json"
test -f "$tmpdir/out-hooks-inline-array/hooks/session-start-codex"
test -f "$tmpdir/out-hooks-inline-array/hooks/support/helper.txt"

run_prepare_for_ref "hooks-default" "out-hooks-default"
assert_manifest_lacks_key "out-hooks-default" "hooks"
test -f "$tmpdir/out-hooks-default/hooks/hooks.json"
test -f "$tmpdir/out-hooks-default/hooks/hooks-codex.json"
test -f "$tmpdir/out-hooks-default/hooks/session-start-codex"
test -f "$tmpdir/out-hooks-default/hooks/support/helper.txt"

run_prepare_for_ref "hooks-absent" "out-hooks-absent"
assert_manifest_lacks_key "out-hooks-absent" "hooks"
if [ -e "$tmpdir/out-hooks-absent/hooks" ]; then
  echo "an absent declaration without hooks/hooks.json must not copy hooks" >&2
  exit 1
fi

run_prepare_for_ref "hooks-outside-path" "out-hooks-outside-path"
assert_manifest_json \
  "out-hooks-outside-path" "/hooks" \
  "$(json_string "./config/hooks-codex.json")"
test -f "$tmpdir/out-hooks-outside-path/config/hooks-codex.json"
test -f "$tmpdir/out-hooks-outside-path/hooks/hooks-codex.json"
test -f "$tmpdir/out-hooks-outside-path/hooks/session-start-codex"
test -f "$tmpdir/out-hooks-outside-path/hooks/support/helper.txt"

run_prepare_for_ref \
  "hooks-root-contained-materialized" "out-hooks-root-contained-materialized"
assert_manifest_json \
  "out-hooks-root-contained-materialized" "/hooks" '{"SessionStart":[]}'
if [ ! -L "$tmpdir/out-hooks-root-contained-materialized/hooks" ]; then
  echo "a contained hooks root must remain a symlink in the candidate" >&2
  exit 1
fi
if [ "$(readlink "$tmpdir/out-hooks-root-contained-materialized/hooks")" != \
  "assets/hook-root" ]; then
  echo "a contained hooks root must preserve its relative target" >&2
  exit 1
fi
grep -Fxq \
  'materialized root target' \
  "$tmpdir/out-hooks-root-contained-materialized/hooks/root-hook.txt"

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

# BASELINE CASE: GENERATED-FALLBACK-01 manifest-less upstream uses manager fallback
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

# BASELINE CASE: GENERATED-WRONG-NAME-01 wrong upstream name is rejected
assert_bad_manifest_error "out-bad-manifest"

# BASELINE CASE: MANIFEST-READER-UPSTREAM-01 upstream manifest reader profile
assert_rejected_manifest_input "nonstandard-json" "out-nonstandard-json" "invalid JSON in"
assert_rejected_manifest_input \
  "reader-depth-257" "out-reader-depth-257" "JSON nesting exceeds limit in"
run_prepare_for_ref "reader-depth-256" "out-reader-depth-256"
reader_depth_256_commit=$(git -C "$upstream" rev-parse reader-depth-256)
reader_depth_256_short=$(printf '%s' "$reader_depth_256_commit" | cut -c 1-7)
assert_prepare_version \
  "out-reader-depth-256" "6.1.1+manager.$reader_depth_256_short"
assert_rejected_manifest_input \
  "reader-duplicate" "out-reader-duplicate" \
  'field `name` must equal `superpowers`'
run_prepare_for_ref "reader-large" "out-reader-large"
assert_manifest_json \
  "out-reader-large" "/x_future_manifest" \
  '{"items":[1,"two"],"preserved":true}'

assert_rejected_manifest_input "unreadable-manifest" "out-unreadable-manifest" "cannot read JSON in"
assert_rejected_manifest_input "unencodable-manifest-version" "out-unencodable-version" "cannot output JSON value from"
assert_rejected_manifest_input "deeply-nested-json" "out-deeply-nested" "JSON nesting exceeds limit in"

# BASELINE CASE: FS-HOOK-CONTAINMENT-01 unsafe hook paths and symlinks fail closed
assert_hook_prepare_failure \
  "hooks-scalar" "out-hooks-scalar" \
  "hook classification failed: unsupported or mixed hooks declaration"
assert_hook_prepare_failure \
  "hooks-mixed-array" "out-hooks-mixed-array" \
  "hook classification failed: unsupported or mixed hooks declaration"
assert_hook_prepare_failure \
  "hooks-unprefixed" "out-hooks-unprefixed" \
  "hook classification failed: declared hook path must start with ./"
assert_hook_prepare_failure \
  "hooks-absolute" "out-hooks-absolute" \
  "hook classification failed: declared hook path must start with ./"
assert_hook_prepare_failure \
  "hooks-traversal" "out-hooks-traversal" \
  "hook classification failed: declared hook source escapes or could not be resolved"
assert_hook_prepare_failure \
  "hooks-missing" "out-hooks-missing" \
  "hook classification failed: declared hook source escapes or could not be resolved"
assert_hook_prepare_failure \
  "hooks-directory" "out-hooks-directory" \
  "hook classification failed: declared hook source is not a regular file"
assert_hook_prepare_failure \
  "hooks-declared-symlink-escape" "out-hooks-declared-symlink-escape" \
  "hook classification failed: declared hook source escapes or could not be resolved"
assert_hook_prepare_failure \
  "hooks-subtree-symlink-escape" "out-hooks-subtree-symlink-escape" \
  "hook materialization failed: symlink escapes or is broken"
assert_hook_prepare_failure \
  "hooks-contained-symlink" "out-hooks-contained-symlink" \
  "hook materialization failed: symlink escapes or is broken"
assert_hook_prepare_failure \
  "hooks-dangling-symlink" "out-hooks-dangling-symlink" \
  "hook materialization failed: symlink escapes or is broken"
assert_hook_prepare_failure \
  "hooks-root-contained-source-only" "out-hooks-root-contained-source-only" \
  "hook materialization failed: hook subtree escapes or is broken"
assert_hook_prepare_failure \
  "hooks-root-absolute-symlink" "out-hooks-root-absolute-symlink" \
  "hook materialization failed: absolute subtree symlink is not allowed"
assert_hook_prepare_failure \
  "hooks-root-broken-symlink" "out-hooks-root-broken-symlink" \
  "hook materialization failed: hook subtree escapes or is broken"
assert_hook_prepare_failure \
  "hooks-root-escape-symlink" "out-hooks-root-escape-symlink" \
  "hook materialization failed: hook subtree escapes or is broken"

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
test -f "$output/hooks/hooks-codex.json"
test -f "$output/hooks/session-start-codex"
test -f "$output/hooks/support/helper.txt"
test -f "$output/LICENSE"
test -f "$output/README.md"
test -f "$output/CODE_OF_CONDUCT.md"
# The atomic swap replaces the whole plugin root, so the staged tree must
# carry the committed manifest template forward (it is a tracked file living
# in the plugin root); otherwise a real prepare would delete it.
test -f "$output/.codex-plugin/plugin.template.json"

assert_manifest_json \
  "out-latest" "/hooks" "$(json_string "./hooks/hooks-codex.json")"

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

# BASELINE CASE: FS-ATOMIC-SWAP-01 failed activation restores the prior tree
atomic_parent="$tmpdir/atomic-swap"
atomic_live="$atomic_parent/live"
atomic_candidate="$atomic_parent/candidate"
atomic_bin="$atomic_parent/bin"
atomic_count="$atomic_parent/mv-count"
mkdir -p "$atomic_live" "$atomic_candidate" "$atomic_bin"
printf '%s\n' 'prior tree' > "$atomic_live/sentinel"
printf '%s\n' 'candidate tree' > "$atomic_candidate/sentinel"
real_mv=$(command -v mv)
cat > "$atomic_bin/mv" <<'SH'
#!/bin/sh
set -eu
count=0
if [ -f "$SPW_TEST_MV_COUNT" ]; then
  count=$(cat "$SPW_TEST_MV_COUNT")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$SPW_TEST_MV_COUNT"
if [ "$count" -eq 2 ]; then
  exit 1
fi
exec "$SPW_TEST_REAL_MV" "$@"
SH
chmod +x "$atomic_bin/mv"
atomic_rc=0
PATH="$atomic_bin:$PATH" \
SPW_TEST_MV_COUNT="$atomic_count" \
SPW_TEST_REAL_MV="$real_mv" \
  sh -c '
    set -eu
    . "$1/scripts/core/common.sh"
    . "$1/scripts/core/lifecycle.sh"
    spw_replace_generated_tree "$2" "$3"
  ' sh "$root" "$atomic_candidate" "$atomic_live" \
  >"$atomic_parent/out" 2>"$atomic_parent/err" || atomic_rc=$?
[ "$atomic_rc" -eq 1 ]
grep -Fq 'previous tree restored' "$atomic_parent/err"
[ "$(cat "$atomic_live/sentinel")" = 'prior tree' ]
[ ! -e "$atomic_candidate" ]
if find "$atomic_parent" -maxdepth 1 -name '.superpowers.bak.*' -print | grep -q .; then
  echo "failed activation left a backup tree" >&2
  exit 1
fi

template_after=$(cksum "$template")
if [ "$template_before" != "$template_after" ]; then
  echo "prepare test must not mutate the committed manifest template" >&2
  exit 1
fi

echo "test_prepare_with_fake_upstream: OK"
