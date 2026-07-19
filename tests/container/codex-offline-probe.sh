#!/bin/sh
set -eu

case "$HOME" in /home/spw|/tmp/*) ;; *) echo "error: refusing non-isolated HOME: $HOME" >&2; exit 1 ;; esac

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
package="$root/package"
upstream="$root/upstream"
state="$root/state"
survivor="$root/unrelated-provider"

cp -R /workspace "$package"
chmod +x "$package/bin/superpowers-manager.js"
mkdir -p "$upstream/skills/probe" "$upstream/.codex-plugin" "$state" \
  "$survivor/.agents/plugins" "$survivor/plugins/unrelated/skills/probe" \
  "$survivor/plugins/unrelated/.codex-plugin"

if command -v timeout >/dev/null 2>&1; then
  timeout_bin=$(command -v timeout)
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin=$(command -v gtimeout)
else
  echo "error: timeout command is required for the offline Codex probe" >&2
  exit 1
fi

run_manager() {
  SUPERPOWERS_CONFIG_DIR="$state/config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_CACHE_DIR="$state/cache" \
  SUPERPOWERS_CODEX=codex \
  SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex" \
    "$package/bin/superpowers-manager.js" "$@"
}

run_codex() {
  "$timeout_bin" 30 codex "$@"
}

assert_marketplace_root() {
  expected="$1"
  listing=$(run_codex plugin marketplace list --json)
  python3 -S - "$listing" "$expected" <<'PY'
import json, os, sys
data = json.loads(sys.argv[1])
expected = os.path.realpath(sys.argv[2])
roots = [item.get("root") for item in data.get("marketplaces", [])
         if isinstance(item, dict) and item.get("name") == "superpowers-manager"]
if len(roots) != 1 or not isinstance(roots[0], str) or os.path.realpath(roots[0]) != expected:
    raise SystemExit("manager marketplace root mismatch")
PY
}

assert_active_installed_commit() {
  listing="$1"
  expected_version="$2"
  expected_commit="$3"
  unexpected_commit="$4"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"
  python3 -S - "$listing" "$expected_root" "$expected_version" "$expected_commit" "$unexpected_commit" <<'PY'
import json
from pathlib import Path
import sys

listing, root_arg, expected_version, expected_commit, unexpected_commit = sys.argv[1:]
data = json.loads(listing)
installed = data.get("installed") if isinstance(data, dict) else None
if not isinstance(installed, list):
    raise SystemExit("Codex plugin listing does not contain an installed array")
matches = [
    item for item in installed
    if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"
]
if len(matches) != 1:
    raise SystemExit("Codex listing must contain exactly one manager plugin")
if matches[0].get("version") != expected_version:
    raise SystemExit("Codex active manager version does not match the expected version")

active_root = Path(root_arg).resolve(strict=True)
with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:
    provenance = json.load(handle)
with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:
    manifest = json.load(handle)
if provenance.get("commit") != expected_commit:
    raise SystemExit("active installed provenance does not match the expected commit")
if provenance.get("commit") == unexpected_commit:
    raise SystemExit("active installed provenance resolved to the stale commit")
if manifest.get("version") != expected_version:
    raise SystemExit("active installed manifest version does not match its cache root")
PY
}

cat > "$upstream/skills/probe/SKILL.md" <<'EOF'
---
name: probe
description: Offline manager A/B probe
---
# Probe A
EOF
printf '%s\n' 'license' > "$upstream/LICENSE"
printf '%s\n' 'readme' > "$upstream/README.md"
printf '%s\n' 'code of conduct' > "$upstream/CODE_OF_CONDUCT.md"
cat > "$upstream/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "1.0.0",
  "description": "Offline manager A/B acceptance plugin.",
  "skills": "./skills/",
  "interface": {
    "displayName": "Superpowers",
    "shortDescription": "Offline manager acceptance plugin.",
    "longDescription": "Local upstream used to prove manager-controlled Codex updates.",
    "developerName": "superpowers-manager",
    "category": "Developer Tools",
    "capabilities": ["skills"],
    "defaultPrompt": ["Use the local probe skill when requested."]
  }
}
JSON
git init -q "$upstream"
git -C "$upstream" config user.name superpowers-manager
git -C "$upstream" config user.email superpowers-manager@example.invalid
git -C "$upstream" add .
git -C "$upstream" commit -qm 'probe A'
git -C "$upstream" tag v1.0.0
commit_a=$(git -C "$upstream" rev-parse HEAD)
short_a=$(printf '%s' "$commit_a" | cut -c 1-7)
version_a="1.0.0+manager.$short_a"

cat > "$survivor/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "unrelated-provider",
  "interface": {"displayName": "Unrelated Provider"},
  "plugins": [{
    "name": "unrelated",
    "source": {"source": "local", "path": "./plugins/unrelated"},
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX"]
    },
    "category": "Developer Tools"
  }]
}
JSON
cat > "$survivor/plugins/unrelated/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "unrelated",
  "version": "1.0.0",
  "description": "Unrelated provider retained across manager uninstall.",
  "skills": "./skills/",
  "interface": {
    "displayName": "Unrelated",
    "shortDescription": "Unrelated provider survivor.",
    "longDescription": "Fixture proving manager uninstall preserves another provider.",
    "developerName": "unrelated-provider",
    "category": "Developer Tools",
    "capabilities": ["skills"],
    "defaultPrompt": ["Use the unrelated probe only when requested."]
  }
}
JSON
printf '%s\n' '---' 'name: probe' 'description: Unrelated probe skill' '---' '# Probe' \
  > "$survivor/plugins/unrelated/skills/probe/SKILL.md"
run_codex plugin marketplace add "$survivor"

run_manager track-latest
run_manager install
initial_listing=$(run_codex plugin list --json)
assert_marketplace_root "$package"
assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""

printf '%s\n' '# Probe B' >> "$upstream/skills/probe/SKILL.md"
git -C "$upstream" add skills/probe/SKILL.md
git -C "$upstream" commit -qm 'probe B'
git -C "$upstream" tag v1.1.0
commit_b=$(git -C "$upstream" rev-parse HEAD)
short_b=$(printf '%s' "$commit_b" | cut -c 1-7)
version_b="1.1.0+manager.$short_b"

reload_listing=$(run_codex plugin list --json)
printf '%s\n' "$reload_listing" | grep -Fq 'superpowers@superpowers-manager'
assert_marketplace_root "$package"
assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"

run_manager update
updated_listing=$(run_codex plugin list --json)
assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"

before_uninstall_marketplaces=$(run_codex plugin marketplace list --json)
run_manager uninstall
final_plugins=$(run_codex plugin list --json)
final_marketplaces=$(run_codex plugin marketplace list --json)
python3 -S - "$final_plugins" "$before_uninstall_marketplaces" "$final_marketplaces" <<'PY'
import json
import sys

final_plugins, before_marketplaces, final_marketplaces = map(json.loads, sys.argv[1:])
installed = final_plugins.get("installed") if isinstance(final_plugins, dict) else None
if not isinstance(installed, list):
    raise SystemExit("final Codex plugin listing does not contain an installed array")
if any(isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"
       for item in installed):
    raise SystemExit("manager plugin remains installed after uninstall")

def marketplace_names(data):
    items = data.get("marketplaces") if isinstance(data, dict) else None
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise SystemExit("Codex marketplace listing has an invalid shape")
    names = [item.get("name") for item in items]
    if not all(isinstance(name, str) and name for name in names):
        raise SystemExit("Codex marketplace listing contains an invalid name")
    return names

before_names = marketplace_names(before_marketplaces)
final_names = marketplace_names(final_marketplaces)
if "superpowers-manager" in final_names:
    raise SystemExit("manager marketplace remains registered after uninstall")
if sorted(name for name in before_names if name != "superpowers-manager") != sorted(final_names):
    raise SystemExit("manager uninstall changed an unrelated provider")
if "unrelated-provider" not in final_names:
    raise SystemExit("unrelated provider was removed by manager uninstall")
PY

echo "codex offline probe: OK"
