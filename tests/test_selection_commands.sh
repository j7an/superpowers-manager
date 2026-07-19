#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/core/common.sh"
. "$root/scripts/core/upstream.sh"
. "$root/scripts/core/selection.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

state_helper="$root/scripts/core/selection-state.py"
config="$tmpdir/config"
normalized="$tmpdir/normalized.json"
upstream="$tmpdir/upstream"

git -C "$tmpdir" init upstream >/dev/null
git -C "$upstream" config user.email superpowers-manager@example.invalid
git -C "$upstream" config user.name superpowers-manager
printf '%s\n' first > "$upstream/file.txt"
git -C "$upstream" add file.txt
git -C "$upstream" -c commit.gpgsign=false commit -m first >/dev/null
v1_commit=$(git -C "$upstream" rev-parse HEAD)
git -C "$upstream" tag v1.0.0
printf '%s\n' second > "$upstream/file.txt"
git -C "$upstream" add file.txt
git -C "$upstream" -c commit.gpgsign=false commit -m second >/dev/null
head_commit=$(git -C "$upstream" rev-parse HEAD)
git -C "$upstream" -c tag.gpgsign=false tag -a v1.1.0-rc.1 -m candidate
annotated_tag_object=$(git -C "$upstream" rev-parse 'v1.1.0-rc.1^{tag}')
git -C "$upstream" branch v9.9.9
blob_commit=$(git -C "$upstream" rev-parse HEAD:file.txt)

run_pin() {
  SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
    sh "$root/scripts/pin" "$@"
  python3 -S "$state_helper" read --path "$config/selection.json" --output "$normalized"
}

json_get() {
  python3 -S - "$normalized" "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)[sys.argv[2]])
PY
}

assert_pin_usage_failure() {
  ref="$1"
  rc=0
  SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
    sh "$root/scripts/pin" "$ref" >"$tmpdir/out" 2>&1 || rc=$?
  test "$rc" -eq 2
}

assert_path_empty() {
  path="$1"
  if find "$path" -mindepth 1 -print | grep -q .; then
    echo "temporary workspace leaked content under $path" >&2
    find "$path" -mindepth 1 -print >&2
    exit 1
  fi
}

assert_state_unchanged() {
  expected="$1"
  test "$(cat "$config/selection.json")" = "$expected"
}

# Public argument shape is status 2.
rc=0
SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" >"$tmpdir/out" 2>&1 || rc=$?
if [ "$rc" -ne 2 ]; then
  echo "pin with no arguments returned $rc instead of usage status 2" >&2
  cat "$tmpdir/out" >&2
  exit 1
fi
rc=0
SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" v1.0.0 extra >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 2

# A malformed single argument is classified before state, source, or Git access.
early_guard_config="$tmpdir/early-guard-config"
mkdir "$early_guard_config"
printf '%s\n' '{bad json' > "$early_guard_config/selection.json"
early_guard_bin="$tmpdir/early-guard-bin"
mkdir "$early_guard_bin"
real_git=$(command -v git)
cat > "$early_guard_bin/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$tmpdir/early-git.log"
exec "$real_git" "\$@"
EOF
chmod +x "$early_guard_bin/git"
bad_tag_cr=$(printf 'v1.0.0\r')
bad_tag_lf=$(printf 'v1.0.0\ninvalid')
bad_commit_lf=$(printf '%s\ninvalid' "$head_commit")
for ref in "$bad_tag_cr" "$bad_tag_lf" "$bad_commit_lf"; do
  rc=0
  PATH="$early_guard_bin:$PATH" SUPERPOWERS_CONFIG_DIR="$early_guard_config" \
    SUPERPOWERS_UPSTREAM_URL='https://token@example.invalid/repo' \
    sh "$root/scripts/pin" "$ref" >"$tmpdir/out" 2>&1 || rc=$?
  test "$rc" -eq 2
  grep -Fq 'pin REF must be an exact v-prefixed SemVer tag or full 40-hex commit' \
    "$tmpdir/out"
  test ! -e "$tmpdir/early-git.log"
  test "$(cat "$early_guard_config/selection.json")" = '{bad json'
done

# Lightweight and annotated tags use only the exact tag namespace, with peeling.
run_pin v1.0.0 >"$tmpdir/out"
grep -Fxq "pinned upstream selection to v1.0.0 at $v1_commit" "$tmpdir/out"
test "$(json_get saved_mode)" = pinned
test "$(json_get saved_source)" = "$upstream"
test "$(json_get saved_requested_ref)" = v1.0.0
test "$(json_get saved_resolved_ref)" = v1.0.0
test "$(json_get saved_commit)" = "$v1_commit"

run_pin v1.1.0-rc.1 >/dev/null
test "$(json_get saved_requested_ref)" = v1.1.0-rc.1
test "$(json_get saved_resolved_ref)" = v1.1.0-rc.1
test "$(json_get saved_commit)" = "$head_commit"

# Full commit input is normalized before verification and persistence.
raw_tmp="$tmpdir/raw-success"
mkdir "$raw_tmp"
TMPDIR="$raw_tmp" run_pin "$(printf '%s' "$head_commit" | tr '[:lower:]' '[:upper:]')" >/dev/null
test "$(json_get saved_requested_ref)" = "$head_commit"
test "$(json_get saved_resolved_ref)" = "$head_commit"
test "$(json_get saved_commit)" = "$head_commit"
assert_path_empty "$raw_tmp"

# Raw verification retains the caller's context for relative and dash-prefixed
# local sources while using an option terminator before the repository argument.
relative_config="$tmpdir/relative-config"
(
  cd "$tmpdir"
  SUPERPOWERS_CONFIG_DIR="$relative_config" SUPERPOWERS_UPSTREAM_URL=upstream \
    sh "$root/scripts/pin" "$head_commit" >"$tmpdir/out"
)
python3 -S "$state_helper" read \
  --path "$relative_config/selection.json" --output "$normalized"
test "$(json_get saved_source)" = upstream
test "$(json_get saved_commit)" = "$head_commit"

ln -s upstream "$tmpdir/-upstream"
dash_config="$tmpdir/dash-config"
(
  cd "$tmpdir"
  SUPERPOWERS_CONFIG_DIR="$dash_config" SUPERPOWERS_UPSTREAM_URL=-upstream \
    sh "$root/scripts/pin" "$head_commit" >"$tmpdir/out"
)
python3 -S "$state_helper" read \
  --path "$dash_config/selection.json" --output "$normalized"
test "$(json_get saved_source)" = -upstream
test "$(json_get saved_commit)" = "$head_commit"

# Exact-tag verification supports the same relative and dash-prefixed local
# source forms, with the repository separated from ls-remote options.
tag_relative_config="$tmpdir/tag-relative-config"
(
  cd "$tmpdir"
  SUPERPOWERS_CONFIG_DIR="$tag_relative_config" SUPERPOWERS_UPSTREAM_URL=upstream \
    sh "$root/scripts/pin" v1.0.0 >"$tmpdir/out"
)
python3 -S "$state_helper" read \
  --path "$tag_relative_config/selection.json" --output "$normalized"
test "$(json_get saved_source)" = upstream
test "$(json_get saved_commit)" = "$v1_commit"

tag_dash_config="$tmpdir/tag-dash-config"
(
  cd "$tmpdir"
  SUPERPOWERS_CONFIG_DIR="$tag_dash_config" SUPERPOWERS_UPSTREAM_URL=-upstream \
    sh "$root/scripts/pin" v1.0.0 >"$tmpdir/out"
)
python3 -S "$state_helper" read \
  --path "$tag_dash_config/selection.json" --output "$normalized"
test "$(json_get saved_source)" = -upstream
test "$(json_get saved_commit)" = "$v1_commit"

for ref in 1.2.3 v1.2 v1.2.3+build.4 latest-release main "${head_commit%????????}"; do
  assert_pin_usage_failure "$ref"
done

# A branch named like a tag cannot satisfy an exact persistent tag pin.
before=$(cat "$config/selection.json")
rc=0
SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" v9.9.9 >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'upstream tag not found: v9.9.9' "$tmpdir/out"
assert_state_unchanged "$before"

# Transport, unavailable-object, and non-commit failures occur before writing.
rc=0
SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$tmpdir/missing-upstream" \
  sh "$root/scripts/pin" v1.0.0 >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'cannot query exact upstream tag v1.0.0' "$tmpdir/out"
assert_state_unchanged "$before"

missing_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
raw_tmp="$tmpdir/raw-missing"
mkdir "$raw_tmp"
rc=0
TMPDIR="$raw_tmp" SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" "$missing_commit" >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'source cannot supply requested commit' "$tmpdir/out"
assert_state_unchanged "$before"
assert_path_empty "$raw_tmp"

raw_tmp="$tmpdir/raw-blob"
mkdir "$raw_tmp"
rc=0
TMPDIR="$raw_tmp" SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" "$blob_commit" >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'requested object is not a commit' "$tmpdir/out"
assert_state_unchanged "$before"
assert_path_empty "$raw_tmp"

raw_tmp="$tmpdir/raw-tag-object"
mkdir "$raw_tmp"
rc=0
TMPDIR="$raw_tmp" SUPERPOWERS_CONFIG_DIR="$config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
  sh "$root/scripts/pin" "$annotated_tag_object" >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'requested object is not a commit' "$tmpdir/out"
assert_state_unchanged "$before"
assert_path_empty "$raw_tmp"

# Other fetch failures name only a safe source display and still clean up.
real_git=$(command -v git)
fakebin="$tmpdir/fetch-failure-bin"
mkdir "$fakebin"
cat > "$fakebin/git" <<EOF
#!/bin/sh
case " \$* " in
  *' fetch '*) echo 'simulated transport failure' >&2; exit 1 ;;
  *) exec "$real_git" "\$@" ;;
esac
EOF
chmod +x "$fakebin/git"
raw_tmp="$tmpdir/raw-transport"
mkdir "$raw_tmp"
rc=0
PATH="$fakebin:$PATH" TMPDIR="$raw_tmp" SUPERPOWERS_CONFIG_DIR="$config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" sh "$root/scripts/pin" "$head_commit" \
  >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq "cannot fetch requested commit from $upstream" "$tmpdir/out"
assert_state_unchanged "$before"
assert_path_empty "$raw_tmp"

# The raw verifier redacts an unsafe display even if called below public validation.
rc=0
trace_was_enabled=false
case "$-" in
  *x*) trace_was_enabled=true; set +x ;;
esac
PATH="$fakebin:$PATH" spw_verify_raw_commit \
  'https://token@example.invalid/repo' "$head_commit" "$tmpdir" \
  >"$tmpdir/out" 2>&1 || rc=$?
[ "$trace_was_enabled" = false ] || set -x
test "$rc" -eq 1
if ! grep -Fq 'cannot fetch requested commit from <redacted-source>' "$tmpdir/out"; then
  echo 'raw-commit verifier did not use the redacted source display' >&2
  cat "$tmpdir/out" >&2
  exit 1
fi
if grep -Fq 'token@example.invalid' "$tmpdir/out"; then
  echo 'raw-commit diagnostic leaked unsafe source' >&2
  exit 1
fi

# A trapped exit cleans only the verifier workspace.
signal_bin="$tmpdir/fetch-signal-bin"
mkdir "$signal_bin"
cat > "$signal_bin/git" <<EOF
#!/bin/sh
case " \$* " in
  *' fetch '*)
    : > "$tmpdir/fetch-started"
    exec /bin/sleep 30
    ;;
  *) exec "$real_git" "\$@" ;;
esac
EOF
chmod +x "$signal_bin/git"
raw_tmp="$tmpdir/raw-signal"
mkdir "$raw_tmp"
printf '%s\n' keep > "$raw_tmp/sibling"
PATH="$signal_bin:$PATH" TMPDIR="$raw_tmp" SUPERPOWERS_CONFIG_DIR="$config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" python3 -S - \
  "$root/scripts/pin" "$head_commit" "$tmpdir/fetch-started" \
  "$tmpdir/out" "$tmpdir/signal-rc" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

script, commit, marker_name, output_name, result_name = sys.argv[1:]
marker = Path(marker_name)
with open(output_name, "wb") as output:
    process = subprocess.Popen(
        ["/bin/sh", script, commit],
        env=os.environ.copy(),
        stdout=output,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.monotonic() + 5
    while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    if not marker.exists():
        process.kill()
        raise SystemExit("raw fetch did not reach the signal fixture")
    os.killpg(process.pid, signal.SIGTERM)
    returncode = process.wait(timeout=5)
Path(result_name).write_text(f"{returncode}\n", encoding="utf-8")
PY
rc=$(cat "$tmpdir/signal-rc")
if [ "$rc" -ne 143 ]; then
  echo "signal-interrupted raw verification returned $rc instead of 143" >&2
  cat "$tmpdir/out" >&2
  exit 1
fi
test "$(cat "$raw_tmp/sibling")" = keep
test "$(find "$raw_tmp" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 1
assert_state_unchanged "$before"

# The writer revalidates state after Git verification and preserves a conflict
# introduced after the initial read.
race_config="$tmpdir/race-config"
race_git_bin="$tmpdir/race-git-bin"
mkdir "$race_git_bin"
cat > "$race_git_bin/git" <<EOF
#!/bin/sh
case " \$* " in
  *' ls-remote '*)
    case "\${SPW_TEST_CONFLICT:-}" in
      malformed) printf '%s\n' '{changed during verification' > "$race_config/selection.json" ;;
      newer) printf '%s\n' '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' > "$race_config/selection.json" ;;
    esac
    ;;
esac
exec "$real_git" "\$@"
EOF
chmod +x "$race_git_bin/git"

for conflict in malformed newer; do
  rm -rf "$race_config"
  mkdir "$race_config"
  rc=0
  PATH="$race_git_bin:$PATH" SPW_TEST_CONFLICT="$conflict" \
    SUPERPOWERS_CONFIG_DIR="$race_config" SUPERPOWERS_UPSTREAM_URL="$upstream" \
    sh "$root/scripts/pin" v1.0.0 >"$tmpdir/out" 2>&1 || rc=$?
  test "$rc" -eq 1
  case "$conflict" in
    malformed) conflict_expected='{changed during verification' ;;
    newer) conflict_expected='{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' ;;
  esac
  test "$(cat "$race_config/selection.json")" = "$conflict_expected"
done

# Existing malformed and newer state fail closed before any Git process runs.
git_log="$tmpdir/git.log"
state_guard_bin="$tmpdir/state-guard-bin"
mkdir "$state_guard_bin"
cat > "$state_guard_bin/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$git_log"
exec "$real_git" "\$@"
EOF
chmod +x "$state_guard_bin/git"
mkdir -p "$config"
printf '%s\n' '{bad json' > "$config/selection.json"
malformed_before=$(cat "$config/selection.json")
rc=0
PATH="$state_guard_bin:$PATH" SUPERPOWERS_CONFIG_DIR="$config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" sh "$root/scripts/pin" v1.0.0 \
  >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
test ! -e "$git_log"
assert_state_unchanged "$malformed_before"

printf '%s\n' '{"schema_version":2,"mode":"track-latest","source":"https://example.invalid/repo"}' \
  > "$config/selection.json"
newer_before=$(cat "$config/selection.json")
rc=0
PATH="$state_guard_bin:$PATH" SUPERPOWERS_CONFIG_DIR="$config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" sh "$root/scripts/pin" v1.0.0 \
  >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
test ! -e "$git_log"
assert_state_unchanged "$newer_before"

# Source validation is also pre-Git and refuses HTTP(S) userinfo.
rm -f "$config/selection.json"
rc=0
PATH="$state_guard_bin:$PATH" SUPERPOWERS_CONFIG_DIR="$config" \
  SUPERPOWERS_UPSTREAM_URL='https://token@example.invalid/repo' \
  sh "$root/scripts/pin" v1.0.0 >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
grep -Fq 'HTTP(S) source must not include userinfo' "$tmpdir/out"
test ! -e "$git_log"

# track-latest captures explicit and official sources, validates old state, and needs no Git.
track_config="$tmpdir/track-config"
nogit_bin="$tmpdir/no-git-bin"
mkdir "$nogit_bin"
real_python3=$(python3 -c 'import os, sys; print(os.path.realpath(sys.executable))')
ln -s "$(command -v dirname)" "$nogit_bin/dirname"
ln -s "$(command -v mktemp)" "$nogit_bin/mktemp"
ln -s "$(command -v rm)" "$nogit_bin/rm"
ln -s "$real_python3" "$nogit_bin/python3"
PATH="$nogit_bin" TMPDIR="$tmpdir" SUPERPOWERS_CONFIG_DIR="$track_config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" /bin/sh "$root/scripts/track-latest" \
  >"$tmpdir/out"
grep -Fxq 'saved upstream selection: latest stable release' "$tmpdir/out"
python3 -S "$state_helper" read --path "$track_config/selection.json" --output "$normalized"
test "$(json_get saved_mode)" = track-latest
test "$(json_get saved_source)" = "$upstream"

official_config="$tmpdir/official-config"
PATH="$nogit_bin" TMPDIR="$tmpdir" SUPERPOWERS_CONFIG_DIR="$official_config" \
  SUPERPOWERS_UPSTREAM_URL= /bin/sh "$root/scripts/track-latest" >/dev/null
python3 -S "$state_helper" read --path "$official_config/selection.json" --output "$normalized"
test "$(json_get saved_source)" = 'https://github.com/obra/superpowers'

printf '%s\n' '{"schema_version":3,"mode":"track-latest","source":"https://example.invalid/repo"}' \
  > "$track_config/selection.json"
track_before=$(cat "$track_config/selection.json")
rc=0
PATH="$nogit_bin" TMPDIR="$tmpdir" SUPERPOWERS_CONFIG_DIR="$track_config" \
  /bin/sh "$root/scripts/track-latest" >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 1
test "$(cat "$track_config/selection.json")" = "$track_before"

rc=0
SUPERPOWERS_CONFIG_DIR="$track_config" sh "$root/scripts/track-latest" extra \
  >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 2

# unpin is parse-free and idempotent, removes only the exact regular file, and
# names the packaged fallback plus active invocation overrides.
unpin_config="$tmpdir/unpin-config"
mkdir "$unpin_config"
printf '%s\n' malformed > "$unpin_config/selection.json"
printf '%s\n' sibling > "$unpin_config/keep"
SUPERPOWERS_CONFIG_DIR="$unpin_config" SUPERPOWERS_REF=main \
  SUPERPOWERS_UPSTREAM_URL="$upstream" sh "$root/scripts/unpin" >"$tmpdir/out"
grep -Fxq 'removed saved upstream selection; packaged fallback is latest-release' "$tmpdir/out"
grep -Fq 'SUPERPOWERS_REF' "$tmpdir/out"
grep -Fq 'SUPERPOWERS_UPSTREAM_URL' "$tmpdir/out"
test ! -e "$unpin_config/selection.json"
test "$(cat "$unpin_config/keep")" = sibling

SUPERPOWERS_CONFIG_DIR="$unpin_config" sh "$root/scripts/unpin" >"$tmpdir/out"
grep -Fxq 'no saved upstream selection; packaged fallback is latest-release' "$tmpdir/out"
test "$(cat "$unpin_config/keep")" = sibling

assert_unpin_refuses() {
  kind="$1"
  rc=0
  SUPERPOWERS_CONFIG_DIR="$unpin_config" sh "$root/scripts/unpin" \
    >"$tmpdir/out" 2>&1 || rc=$?
  test "$rc" -eq 1
  grep -Fq 'remove it manually after inspecting' "$tmpdir/out"
  test -e "$unpin_config/selection.json" || test -L "$unpin_config/selection.json"
  case "$kind" in
    symlink) test -L "$unpin_config/selection.json" ;;
    directory) test -d "$unpin_config/selection.json" ;;
    special) test -p "$unpin_config/selection.json" ;;
  esac
}

ln -s "$unpin_config/keep" "$unpin_config/selection.json"
assert_unpin_refuses symlink
rm "$unpin_config/selection.json"
mkdir "$unpin_config/selection.json"
assert_unpin_refuses directory
rmdir "$unpin_config/selection.json"
mkfifo "$unpin_config/selection.json"
assert_unpin_refuses special
rm "$unpin_config/selection.json"

rc=0
SUPERPOWERS_CONFIG_DIR="$unpin_config" sh "$root/scripts/unpin" extra \
  >"$tmpdir/out" 2>&1 || rc=$?
test "$rc" -eq 2

printf '%s\n' OK
