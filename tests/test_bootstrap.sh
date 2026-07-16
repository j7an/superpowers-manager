#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

assert_file() {
  path="$1"
  if [ ! -f "$root/$path" ]; then
    echo "missing file: $path" >&2
    exit 1
  fi
}

assert_contains() {
  path="$1"
  text="$2"
  if ! grep -Fq "$text" "$root/$path"; then
    echo "missing text in $path: $text" >&2
    exit 1
  fi
}

assert_not_contains() {
  path="$1"
  text="$2"
  if grep -Fq "$text" "$root/$path"; then
    echo "unexpected text in $path: $text" >&2
    exit 1
  fi
}

assert_file ".gitignore"
assert_file "config/upstream-ref"
assert_file ".agents/plugins/marketplace.json"
assert_file "bin/superpowers-manager.js"
assert_file "plugins/superpowers/.codex-plugin/plugin.template.json"

if [ -e "$root/bin/superpowers-wrapper.js" ]; then
  echo "deprecated executable must not ship" >&2
  exit 1
fi
if grep -Fq '"superpowers-wrapper"' "$root/package.json"; then
  echo "old npm/bin identity remains in package.json" >&2
  exit 1
fi

assert_contains "config/upstream-ref" "latest-release"
assert_contains "package.json" '"name": "superpowers-manager"'
assert_contains "package.json" '"version": "0.1.2"'
assert_contains "package.json" '"superpowers-manager": "bin/superpowers-manager.js"'
assert_contains ".agents/plugins/marketplace.json" '"name": "superpowers-manager"'
assert_contains ".agents/plugins/marketplace.json" '"products": ["CODEX"]'
assert_contains ".gitignore" "plugins/superpowers/.codex-plugin/plugin.json"
assert_contains "scripts/lib.sh" 'SPW_PLUGIN_ID="superpowers@superpowers-manager"'
assert_contains "scripts/lib.sh" 'SPW_MARKETPLACE_NAME="superpowers-manager"'
assert_contains "scripts/update" 'echo "manager is current"'
assert_contains "scripts/probe" 'installed manager commit or fingerprint:'
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"name": "superpowers"'
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"version": "0.0.0+manager.template"'
assert_contains "plugins/superpowers/.codex-plugin/plugin.template.json" '"skills": "./skills/"'
assert_contains "README.md" "Install and update the latest stable"
assert_contains "README.md" "Codex supported today"
assert_contains "README.md" "Unofficial community integration"
assert_contains "README.md" "Use the official marketplace"
assert_contains "README.md" "per-invocation"
assert_contains "README.md" "does not persist"
assert_contains "README.md" "Codex-specific hook-free"
assert_contains "README.md" 'Codex CLI is required for `probe`, `install`, `update`, and `uninstall`'
assert_contains "README.md" "Install and update prepare and validate before changing Codex state."
assert_contains "README.md" "Uninstall inspects and removes only manager-owned Codex state."
assert_not_contains "README.md" "automatically updates"
assert_not_contains "README.md" "Claude Code supported"

manual_probe="tests/manual/codex-behavior-probe.sh"
assert_contains "$manual_probe" 'marketplace_name="superpowers-manager-probe"'
assert_contains "$manual_probe" 'plugin_name="manager-probe"'
assert_contains "$manual_probe" '/superpowers-manager-codex-probe'
assert_contains "$manual_probe" '/superpowers-manager-hook-probe-ran'
assert_contains "$manual_probe" '"displayName": "Superpowers Manager Probe"'
assert_contains "$manual_probe" '"displayName": "Manager Probe"'
assert_contains "$manual_probe" '"developerName": "superpowers-manager"'
assert_contains "$manual_probe" 'Use manager-probe only for local marketplace testing.'
assert_contains "$manual_probe" '.manager-probe-upstream.json'
assert_contains "$manual_probe" 'Run manager-plugin remove, then plugin add'
assert_contains "$manual_probe" 'Respond with manager probe check.'
assert_contains "$manual_probe" '+manager.'
assert_not_contains "$manual_probe" 'superpowers-wrapper'
assert_not_contains "$manual_probe" 'wrapper-probe'
assert_not_contains "$manual_probe" '+wrapper.'
