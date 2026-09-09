#!/bin/sh
set -eu

# Optional native-only Codex compatibility probe.
# This script is intentional compatibility residue for path/cache behavior that
# still benefits from a real developer-managed Codex install. It is not part of
# the acceptance contract: `sh tests/container.sh` is the blocking automated
# gate, and that isolated container path is the only automated flow allowed to
# mutate Codex state.

marketplace_name="superpowers-manager-probe"
plugin_name="manager-probe"
plugin_id="${plugin_name}@${marketplace_name}"
probe_root="${TMPDIR:-/tmp}/superpowers-manager-codex-probe"

codex_bin="${CODEX_BIN:-codex}"

cleanup() {
  "$codex_bin" plugin remove "$plugin_id" >/dev/null 2>&1 || true
  "$codex_bin" plugin marketplace remove "$marketplace_name" >/dev/null 2>&1 || true
}

write_probe_plugin() {
  commit="$1"
  version="$2"
  rm -rf "$probe_root"
  mkdir -p "$probe_root/.agents/plugins"
  mkdir -p "$probe_root/plugins/$plugin_name/.codex-plugin"
  mkdir -p "$probe_root/plugins/$plugin_name/skills/probe"

  cat > "$probe_root/.agents/plugins/marketplace.json" <<JSON
{
  "name": "$marketplace_name",
  "interface": {
    "displayName": "Superpowers Manager Probe"
  },
  "plugins": [
    {
      "name": "$plugin_name",
      "source": {
        "source": "local",
        "path": "./plugins/$plugin_name"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
        "products": ["CODEX"]
      },
      "category": "Developer Tools"
    }
  ]
}
JSON

  cat > "$probe_root/plugins/$plugin_name/.codex-plugin/plugin.json" <<JSON
{
  "name": "$plugin_name",
  "version": "$version",
  "description": "Throwaway Codex local marketplace behavior probe.",
  "author": {
    "name": "superpowers-manager"
  },
  "skills": "./skills/",
  "interface": {
    "displayName": "Manager Probe",
    "shortDescription": "Local marketplace behavior probe.",
    "longDescription": "A temporary plugin used to observe Codex local marketplace refresh, cache, and version-precedence behavior.",
    "developerName": "superpowers-manager",
    "category": "Developer Tools",
    "capabilities": ["skills"],
    "defaultPrompt": [
      "Use manager-probe only for local marketplace testing."
    ]
  }
}
JSON

  cat > "$probe_root/plugins/$plugin_name/skills/probe/SKILL.md" <<EOF
---
name: probe
description: Temporary local marketplace probe skill
---

# Probe Skill

This temporary skill records Codex local marketplace behavior.
EOF

  cat > "$probe_root/plugins/$plugin_name/.manager-probe-upstream.json" <<JSON
{
  "commit": "$commit"
}
JSON

}

find_installed_metadata() {
  find "$HOME/.codex" -path "*/$plugin_name/.manager-probe-upstream.json" -type f 2>/dev/null | head -n 1
}

metadata_commit() {
  file="$1"
  python3 - "$file" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f).get("commit", ""))
PY
}

cleanup
trap cleanup EXIT INT TERM

echo "Q1/Q2/Q3 probe root: $probe_root"
write_probe_plugin "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "0.0.0+probe.a"

echo "Register marketplace and install commit A"
"$codex_bin" plugin marketplace add "$probe_root"
"$codex_bin" plugin add "$plugin_id"

installed_metadata="$(find_installed_metadata || true)"
if [ -n "$installed_metadata" ]; then
  echo "Installed metadata path: $installed_metadata"
  echo "Installed commit after first add: $(metadata_commit "$installed_metadata")"
else
  echo "Installed metadata path: not found"
fi

echo "Mutate source to commit B"
write_probe_plugin "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "0.0.0+probe.b"

echo "Run plugin add without marketplace re-add"
"$codex_bin" plugin add "$plugin_id" || true
installed_metadata="$(find_installed_metadata || true)"
if [ -n "$installed_metadata" ]; then
  echo "Installed commit after add-only refresh: $(metadata_commit "$installed_metadata")"
else
  echo "Installed metadata path after add-only refresh: not found"
fi

echo "Run marketplace add, then plugin add"
"$codex_bin" plugin marketplace add "$probe_root" || true
"$codex_bin" plugin add "$plugin_id" || true
installed_metadata="$(find_installed_metadata || true)"
if [ -n "$installed_metadata" ]; then
  echo "Installed commit after marketplace re-add and plugin add: $(metadata_commit "$installed_metadata")"
fi

echo "Run manager-plugin remove, then plugin add"
"$codex_bin" plugin remove "$plugin_id" || true
"$codex_bin" plugin add "$plugin_id"
installed_metadata="$(find_installed_metadata || true)"
if [ -n "$installed_metadata" ]; then
  echo "Installed commit after remove/add: $(metadata_commit "$installed_metadata")"
fi

echo "Stable-to-branch version precedence probe"
cache_root="$HOME/.codex/plugins/cache/$marketplace_name/$plugin_name"
stable_root="$cache_root/6.0.3+manager.ccccccc"
branch_root="$cache_root/0.0.0-main+manager.ddddddd"

write_probe_plugin "cccccccccccccccccccccccccccccccccccccccc" "6.0.3+manager.ccccccc"
"$codex_bin" plugin marketplace add "$probe_root" >/dev/null 2>&1 || true
"$codex_bin" plugin add "$plugin_id" || true
echo "Installed root after stable-looking add:"
if [ -d "$stable_root" ]; then
  printf '%s\n' "$stable_root"
else
  echo "not found"
fi

write_probe_plugin "dddddddddddddddddddddddddddddddddddddddd" "0.0.0-main+manager.ddddddd"
"$codex_bin" plugin add "$plugin_id" || true
echo "Installed root after stable-to-branch add-only refresh:"
if [ -d "$branch_root" ]; then
  printf '%s\n' "$branch_root"
else
  echo "not found"
fi

"$codex_bin" plugin remove "$plugin_id" || true
"$codex_bin" plugin add "$plugin_id"
echo "Installed root after stable-to-branch remove/add refresh:"
if [ -d "$branch_root" ]; then
  printf '%s\n' "$branch_root"
else
  echo "not found"
fi
