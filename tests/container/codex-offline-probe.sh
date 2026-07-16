#!/bin/sh
set -eu

case "$HOME" in /home/spw|/tmp/*) ;; *) echo "error: refusing non-isolated HOME: $HOME" >&2; exit 1 ;; esac

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
market="$root/market-a"
moved="$root/market-b"
plugin_id="manager-probe@superpowers-manager-probe"
commit_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commit_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
version_a=0.0.0+probe.aaaaaaa
version_b=0.0.0+probe.bbbbbbb

if command -v timeout >/dev/null 2>&1; then
  timeout_bin=$(command -v timeout)
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin=$(command -v gtimeout)
else
  echo "error: timeout command is required for the offline Codex probe" >&2
  exit 1
fi

run_codex() {
  "$timeout_bin" 30 codex "$@"
}

write_market() {
  target="$1"
  commit="$2"
  short=$(printf '%s' "$commit" | cut -c 1-7)
  mkdir -p "$target/.agents/plugins" "$target/plugins/manager-probe/.codex-plugin" "$target/plugins/manager-probe/skills/probe"
  cat > "$target/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "superpowers-manager-probe",
  "interface": {"displayName": "Superpowers Manager Probe"},
  "plugins": [{
    "name": "manager-probe",
    "source": {"source": "local", "path": "./plugins/manager-probe"},
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX"]
    },
    "category": "Developer Tools"
  }]
}
JSON
  cat > "$target/plugins/manager-probe/.codex-plugin/plugin.json" <<JSON
{
  "name": "manager-probe",
  "version": "0.0.0+probe.$short",
  "description": "Throwaway offline Codex probe.",
  "skills": "./skills/",
  "interface": {
    "displayName": "Manager Probe",
    "shortDescription": "Offline marketplace probe.",
    "longDescription": "Temporary local plugin used only in an isolated container.",
    "developerName": "superpowers-manager",
    "category": "Developer Tools",
    "capabilities": ["skills"],
    "defaultPrompt": ["Use manager-probe only for local marketplace testing."]
  }
}
JSON
  printf '%s\n' '---' 'name: probe' 'description: offline probe' '---' '# Probe' > "$target/plugins/manager-probe/skills/probe/SKILL.md"
  printf '{"commit":"%s"}\n' "$commit" > "$target/plugins/manager-probe/.superpowers-upstream.json"
}

assert_marketplace_root() {
  expected_root="$1"
  listing=$(run_codex plugin marketplace list --json)
  python3 - "$listing" "$expected_root" <<'PY'
import json
import os
import sys

listing, expected_root = sys.argv[1:]
data = json.loads(listing)
for item in data.get("marketplaces", []):
    if item.get("name") == "superpowers-manager-probe":
        actual_root = item.get("root")
        if isinstance(actual_root, str) and os.path.realpath(actual_root) == os.path.realpath(expected_root):
            raise SystemExit(0)
raise SystemExit("manager probe marketplace does not point at the expected root")
PY
}

assert_plugin_listed() {
  listing=$(run_codex plugin list --json)
  python3 - "$listing" "$plugin_id" <<'PY'
import json
import sys

listing, expected_plugin_id = sys.argv[1:]
data = json.loads(listing)
installed = data.get("installed")
if not isinstance(installed, list):
    raise SystemExit("Codex plugin listing does not contain an installed array")
if not any(
    isinstance(item, dict) and item.get("pluginId") == expected_plugin_id
    for item in installed
):
    raise SystemExit("manager probe is not active in the Codex plugin listing")
PY
}

install_plugin_and_assert_active() {
  expected_version="$1"
  expected_commit="$2"
  unexpected_commit="$3"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager-probe/manager-probe/$expected_version"

  install_output=$(run_codex plugin add "$plugin_id")
  printf '%s\n' "$install_output"
  active_root=$(printf '%s\n' "$install_output" | sed -n 's/^Installed plugin root: //p')
  if [ -z "$active_root" ] || [ "$(printf '%s\n' "$install_output" | grep -c '^Installed plugin root: ')" -ne 1 ]; then
    echo "error: Codex did not report exactly one active installed plugin root" >&2
    exit 1
  fi

  python3 - "$active_root" "$expected_root" "$expected_version" "$expected_commit" "$unexpected_commit" <<'PY'
import json
from pathlib import Path
import sys

active_arg, expected_arg, expected_version, expected_commit, unexpected_commit = sys.argv[1:]
active_root = Path(active_arg).resolve(strict=True)
expected_root = Path(expected_arg).resolve(strict=True)
if active_root != expected_root:
    raise SystemExit(f"Codex selected unexpected installed plugin root: {active_root}")

with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:
    provenance = json.load(handle)
with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:
    manifest = json.load(handle)

if not isinstance(provenance, dict) or provenance.get("commit") != expected_commit:
    raise SystemExit("active installed provenance does not match the expected commit")
if provenance.get("commit") == unexpected_commit:
    raise SystemExit("Codex selected the stale installed provenance")
if not isinstance(manifest, dict) or manifest.get("version") != expected_version:
    raise SystemExit("active installed manifest version does not match its cache root")
PY

  assert_plugin_listed
}

write_market "$market" "$commit_a"
run_codex plugin marketplace add "$market"
install_plugin_and_assert_active "$version_a" "$commit_a" "$commit_b"
assert_marketplace_root "$market"

write_market "$moved" "$commit_b"
run_codex plugin marketplace remove superpowers-manager-probe
run_codex plugin marketplace add "$moved"
install_plugin_and_assert_active "$version_b" "$commit_b" "$commit_a"
assert_marketplace_root "$moved"

run_codex plugin remove "$plugin_id"
run_codex plugin marketplace remove superpowers-manager-probe

final_plugins=$(run_codex plugin list --json)
final_marketplaces=$(run_codex plugin marketplace list --json)
if printf '%s\n' "$final_plugins" | grep -Fq "$plugin_id"; then exit 1; fi
if printf '%s\n' "$final_marketplaces" | grep -Fq 'superpowers-manager-probe'; then exit 1; fi
echo "codex offline probe: OK"
