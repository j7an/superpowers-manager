#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$root/scripts/core/common.sh"
. "$root/scripts/core/upstream.sh"

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

branch_named_like_tag=$(spw_resolve_ref "$repo" "v9.9.9")
test "$branch_named_like_tag" = "ref v9.9.9 $main_commit"

if spw_select_latest_release_from_ls_remote < /dev/null >/dev/null 2>&1; then
  echo "expected empty tag list to fail" >&2
  exit 1
fi
