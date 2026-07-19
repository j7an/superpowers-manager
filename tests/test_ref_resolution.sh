#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/core/common.sh"
. "$root/scripts/core/upstream.sh"
. "$root/scripts/core/selection.sh"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

fixture_config_root="$tmpdir/config-root"
mkdir -p "$fixture_config_root/config"
printf '%s\n' 'v6.0.3' > "$fixture_config_root/config/upstream-ref"
caller_root="$root"
config_root="caller-config-root"
spw_config_ref "$fixture_config_root" > "$tmpdir/config-ref.out"
test "$root" = "$caller_root"
test "$config_root" = "caller-config-root"
test "$(cat "$tmpdir/config-ref.out")" = "v6.0.3"

cat > "$tmpdir/ls-remote-tags.txt" <<'EOF'
1111111111111111111111111111111111111111	refs/tags/v6.0.2
2222222222222222222222222222222222222222	refs/tags/v6.0.2^{}
3333333333333333333333333333333333333333	refs/tags/v6.0.10
4444444444444444444444444444444444444444	refs/tags/v6.0.10^{}
5555555555555555555555555555555555555555	refs/tags/v6.1.0-beta.1
EOF

selected=$(spw_select_latest_release_from_ls_remote < "$tmpdir/ls-remote-tags.txt")
if [ "$selected" != "v6.0.10 4444444444444444444444444444444444444444" ]; then
  echo "unexpected latest release: $selected" >&2
  exit 1
fi

version=$(spw_manifest_version_for_commit "896224c4b1879920ab573417e68fd51d2ccc9072")
if [ "$version" != "0.0.0+manager.896224c" ]; then
  echo "unexpected manifest version: $version" >&2
  exit 1
fi

short_commit="896224c4b1879920ab573417e68fd51d2ccc9072"

test "$(spw_manifest_version_for_ref "latest-release" "latest-release" "v6.0.3" "$short_commit")" = "6.0.3+manager.896224c"
test "$(spw_manifest_version_for_ref "v6.1.0-beta.1" "tag" "v6.1.0-beta.1" "abc1234abc1234abc1234abc1234abc1234abc12")" = "6.1.0-beta.1+manager.abc1234"
test "$(spw_manifest_version_for_ref "main" "ref" "main" "def5678def5678def5678def5678def5678def56")" = "0.0.0-main+manager.def5678"
test "$(spw_manifest_version_for_ref "feature/foo" "ref" "feature/foo" "fedcba9fedcba9fedcba9fedcba9fedcba9fedc")" = "0.0.0-ref-feature-foo+manager.fedcba9"
test "$(spw_manifest_version_for_ref "042" "ref" "042" "0123abc0123abc0123abc0123abc0123abc0123")" = "0.0.0-ref-042+manager.0123abc"
test "$(spw_manifest_version_for_ref "896224c4b1879920ab573417e68fd51d2ccc9072" "raw-commit" "896224c4b1879920ab573417e68fd51d2ccc9072" "$short_commit")" = "0.0.0+manager.896224c"
test "$(spw_manifest_version_for_ref "v1.2.3" "ref" "v1.2.3" "$short_commit")" = "0.0.0-ref-v1-2-3+manager.896224c"
test "$(spw_manifest_version_for_ref "!!!" "ref" "!!!" "$short_commit")" = "0.0.0-ref-unknown+manager.896224c"
test "$(spw_sanitize_ref_for_version "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu/tail")" = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu"

long_ref="feature/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"
long_version=$(spw_manifest_version_for_ref "$long_ref" "ref" "$long_ref" "$short_commit")
test "$long_version" = "0.0.0-ref-feature-abcdefghijklmnopqrstuvwxyzabcdefghijklmn+manager.896224c"

invalid_prerelease=$(spw_manifest_version_for_ref "v1.2.3-042" "tag" "v1.2.3-042" "$short_commit")
test "$invalid_prerelease" = "0.0.0+manager.896224c"

repo="$tmpdir/upstream"
git -C "$tmpdir" init upstream >/dev/null
git -C "$repo" config user.email superpowers-manager@example.invalid
git -C "$repo" config user.name superpowers-manager
printf 'release\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" -c commit.gpgsign=false commit -m "release" >/dev/null
git -C "$repo" -c tag.gpgsign=false tag -a v1.2.3 -m "release"
release_commit=$(git -C "$repo" rev-list -n1 v1.2.3)
release_tag_object=$(git -C "$repo" rev-parse 'v1.2.3^{tag}')
git -C "$repo" branch -M main
printf 'branch\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" -c commit.gpgsign=false commit -m "branch" >/dev/null
main_commit=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" branch v9.9.9
git -C "$repo" tag v1.2.2

latest_resolved=$(spw_resolve_ref "$repo" "latest-release")
test "$latest_resolved" = "latest-release v1.2.3 $release_commit"

tag_resolved=$(spw_resolve_ref "$repo" "v1.2.3")
test "$tag_resolved" = "tag v1.2.3 $release_commit"

lightweight_tag_resolved=$(spw_resolve_ref "$repo" "v1.2.2")
test "$lightweight_tag_resolved" = "tag v1.2.2 $main_commit"

raw_resolved=$(spw_resolve_ref "$repo" "$main_commit")
test "$raw_resolved" = "raw-commit $main_commit $main_commit"

main_resolved=$(spw_resolve_ref "$repo" "main")
test "$main_resolved" = "ref main $main_commit"

# Preparing a saved exact pin must obtain that exact object from the effective
# source and prove it is a commit inside the persistent cache repository.
exact_cache="$tmpdir/exact-cache"
exact_workspace="$tmpdir/exact-workspace"
mkdir "$exact_workspace"
printf 'keep\n' > "$exact_workspace/sibling"
spw_fetch_exact_commit "$repo" "$release_commit" "$exact_cache" "$exact_workspace"
git -C "$exact_cache" cat-file -e "$release_commit^{commit}"
test "$(find "$exact_workspace" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 1
test "$(cat "$exact_workspace/sibling")" = keep

# Source proof must not be satisfiable by an object already present in the
# persistent cache.
empty_repo="$tmpdir/empty-upstream"
git init --bare "$empty_repo" >/dev/null
if spw_fetch_exact_commit "$empty_repo" "$release_commit" "$exact_cache" \
    "$exact_workspace" >"$tmpdir/empty-fetch.out" 2>"$tmpdir/empty-fetch.err"; then
  echo "exact object fetch unexpectedly used a cached object as source proof" >&2
  exit 1
fi
grep -Fq "source cannot supply requested commit: $release_commit" \
  "$tmpdir/empty-fetch.err"
test "$(find "$exact_workspace" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 1
test "$(cat "$exact_workspace/sibling")" = keep

blob_object=$(git -C "$repo" rev-parse "$main_commit:file.txt")
if spw_fetch_exact_commit "$repo" "$blob_object" "$tmpdir/blob-cache" \
    "$exact_workspace" >"$tmpdir/blob-fetch.out" 2>"$tmpdir/blob-fetch.err"; then
  echo "exact object fetch unexpectedly accepted a blob" >&2
  exit 1
fi
grep -Fq "requested object is not a commit: $blob_object" "$tmpdir/blob-fetch.err"

if spw_fetch_exact_commit "$repo" "$release_tag_object" "$tmpdir/tag-object-cache" \
    "$exact_workspace" >"$tmpdir/tag-object-fetch.out" 2>"$tmpdir/tag-object-fetch.err"; then
  echo "exact object fetch unexpectedly accepted an annotated tag object" >&2
  exit 1
fi
grep -Fq "requested object is not a commit: $release_tag_object" \
  "$tmpdir/tag-object-fetch.err"

# A trapped source-proof fetch removes only its invocation-owned repository.
signal_bin="$tmpdir/fetch-signal-bin"
signal_workspace="$tmpdir/signal-workspace"
signal_cache="$tmpdir/signal-cache"
mkdir "$signal_bin" "$signal_workspace"
printf 'keep\n' > "$signal_workspace/sibling"
real_git=$(command -v git)
cat > "$signal_bin/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$tmpdir/signal-git.log"
case " \$* " in
  *' fetch --no-tags -- '*)
    : > "$tmpdir/fetch-started"
    exec /bin/sleep 30
    ;;
  *) exec "$real_git" "\$@" ;;
esac
EOF
chmod +x "$signal_bin/git"
PATH="$signal_bin:$PATH" python3 -S - \
  "$root" "$repo" "$release_commit" "$signal_cache" "$signal_workspace" \
  "$tmpdir/fetch-started" "$tmpdir/signal-fetch.out" "$tmpdir/signal-rc" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root, source, commit, cache, workspace, marker_name, output_name, result_name = sys.argv[1:]
script = """
set -eu
. "$1/scripts/core/common.sh"
. "$1/scripts/core/upstream.sh"
. "$1/scripts/core/selection.sh"
spw_fetch_exact_commit "$2" "$3" "$4" "$5"
"""
marker = Path(marker_name)
with open(output_name, "wb") as output:
    process = subprocess.Popen(
        ["/bin/sh", "-c", script, "sh", root, source, commit, cache, workspace],
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
        raise SystemExit("exact fetch did not reach the signal fixture")
    os.killpg(process.pid, signal.SIGTERM)
    returncode = process.wait(timeout=5)
workspace_path = Path(workspace)
deadline = time.monotonic() + 5
while list(workspace_path.glob("superpowers-manager.fetch.*")) and time.monotonic() < deadline:
    time.sleep(0.01)
if list(workspace_path.glob("superpowers-manager.fetch.*")):
    raise SystemExit("interrupted exact fetch did not clean its proof repository")
Path(result_name).write_text(f"{returncode}\n", encoding="utf-8")
PY
test "$(cat "$tmpdir/signal-rc")" -ne 0
grep -Fq -- "-C $signal_workspace/superpowers-manager.fetch." \
  "$tmpdir/signal-git.log"
test "$(find "$signal_workspace" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" -eq 1
test "$(cat "$signal_workspace/sibling")" = keep

branch_named_like_tag=$(spw_resolve_ref "$repo" "v9.9.9")
test "$branch_named_like_tag" = "ref v9.9.9 $main_commit"

if spw_select_latest_release_from_ls_remote < /dev/null >/dev/null 2>&1; then
  echo "expected empty tag list to fail" >&2
  exit 1
fi

echo "test_ref_resolution: OK"
