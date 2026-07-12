#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

. "$root/scripts/core/common.sh"
. "$root/scripts/core/provenance.sh"

upstream="$tmpdir/upstream"
mkdir -p "$upstream"
git -C "$tmpdir" init upstream >/dev/null
printf '%s\n' 'upstream' > "$upstream/README.md"
git -C "$upstream" add README.md >/dev/null
git -C "$upstream" -c user.email=superpowers-wrapper@example.invalid -c user.name=superpowers-wrapper -c commit.gpgsign=false commit -m "fake upstream" >/dev/null

pkg="$tmpdir/pkg"
mkdir -p "$pkg"
cp -R "$root/scripts" "$pkg/scripts"
cp -R "$root/config" "$pkg/config"
mkdir -p "$pkg/plugins/superpowers"

installed_root="$tmpdir/codex-home/plugins/cache/superpowers-wrapper/superpowers/1.0.0"
mkdir -p "$installed_root/.codex-plugin"

adapter_log="$tmpdir/adapter.log"
recording_adapter="$tmpdir/recording-adapter"
cat > "$recording_adapter" <<EOF
#!/bin/sh
printf '%s\n' "\$*" > "$adapter_log"
exec "$pkg/scripts/adapters/codex/adapter" "\$@"
EOF
chmod +x "$recording_adapter"

tool_path="$tmpdir/tool-path"
mkdir -p "$tool_path"
for tool in git python3 awk sed find head cut dirname pwd grep rm; do
  real=$(command -v "$tool")
  ln -sf "$real" "$tool_path/$tool"
done

desired_commit=$(git -C "$upstream" rev-parse HEAD)
desired_short=$(printf '%s' "$desired_commit" | cut -c 1-7)

write_generated_metadata() {
  commit="$1"
  cat > "$pkg/plugins/superpowers/.superpowers-upstream.json" <<EOF
{
  "commit": "$commit"
}
EOF
}

write_installed_manifest() {
  version="$1"
  cat > "$installed_root/.codex-plugin/plugin.json" <<EOF
{
  "name": "superpowers",
  "version": "$version"
}
EOF
}

generated_commit_from_pkg() {
  spw_metadata_commit_or_empty "$pkg/plugins/superpowers/.superpowers-upstream.json"
}

assert_probe_porcelain() {
  expected_installed="$1"
  expected_status="$2"
  output="$3"

  printf '%s\n' "$output" | grep -Fxq "desired_commit=$desired_commit"
  printf '%s\n' "$output" | grep -Fxq "generated_commit=$(generated_commit_from_pkg)"
  printf '%s\n' "$output" | grep -Fxq "installed_commit=$expected_installed"
  printf '%s\n' "$output" | grep -Fxq "status=$expected_status"
}

run_probe() {
  PATH="$tool_path" \
  SUPERPOWERS_REF="$desired_commit" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_INSTALLED_SEARCH_ROOT="$tmpdir/codex-home" \
  SPW_ADAPTER="$recording_adapter" \
  /bin/sh "$pkg/scripts/probe" --porcelain
}

# Scenario 1: malformed installed metadata falls back to the manifest short SHA,
# and probe still works with no codex executable on PATH.
write_generated_metadata "$desired_commit"
printf '%s\n' '{' > "$installed_root/.superpowers-upstream.json"
write_installed_manifest "0.0.0+wrapper.$desired_short"
: > "$adapter_log"
output=$(run_probe)
assert_probe_porcelain "$desired_short" "current" "$output"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

# Scenario 1b: semantically invalid metadata falls through to a valid manifest
# fingerprint instead of poisoning the protocol response.
printf '%s\n' '{"commit":"not-a-fingerprint"}' > "$installed_root/.superpowers-upstream.json"
write_installed_manifest "0.0.0+wrapper.$desired_short"
: > "$adapter_log"
output=$(run_probe)
assert_probe_porcelain "$desired_short" "current" "$output"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

# Scenario 2: semantically invalid metadata plus malformed manifest -> null
# fingerprint and needs install when generated is current.
printf '%s\n' '{"commit":"not-a-fingerprint"}' > "$installed_root/.superpowers-upstream.json"
printf '%s\n' '{' > "$installed_root/.codex-plugin/plugin.json"
: > "$adapter_log"
output=$(run_probe)
assert_probe_porcelain "" "needs install" "$output"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

# Scenario 2b: semantically invalid metadata with no manifest also yields null.
rm -f "$installed_root/.codex-plugin/plugin.json"
: > "$adapter_log"
output=$(run_probe)
assert_probe_porcelain "" "needs install" "$output"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

# Scenario 3: stale generated metadata still wins over a null installed
# fingerprint and keeps the status at needs prepare.
write_generated_metadata "0000000000000000000000000000000000000000"
: > "$adapter_log"
output=$(run_probe)
assert_probe_porcelain "" "needs prepare" "$output"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

# Scenario 4: malformed generated provenance is treated as absent so probe can
# report needs prepare instead of aborting the remediation path.
printf '%s\n' '{' > "$pkg/plugins/superpowers/.superpowers-upstream.json"
: > "$adapter_log"
output=$(run_probe)
printf '%s\n' "$output" | grep -Fxq "desired_commit=$desired_commit"
printf '%s\n' "$output" | grep -Fxq "generated_commit="
printf '%s\n' "$output" | grep -Fxq "installed_commit="
printf '%s\n' "$output" | grep -Fxq "status=needs prepare"
grep -Fxq "inspect --view fingerprint" "$adapter_log"

echo "test_probe_commands: OK"
