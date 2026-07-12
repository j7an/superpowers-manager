#!/bin/sh
set -eu

case "$HOME" in /home/spw|/tmp/*) ;; *) echo "error: refusing non-isolated HOME: $HOME" >&2; exit 1 ;; esac

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
market="$root/market-a"
moved="$root/market-b"
plugin_id="wrapper-probe@superpowers-wrapper-probe"
commit_a=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commit_b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

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
  mkdir -p "$target/.agents/plugins" "$target/plugins/wrapper-probe/.codex-plugin" "$target/plugins/wrapper-probe/skills/probe"
  cat > "$target/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "superpowers-wrapper-probe",
  "interface": {"displayName": "Superpowers Wrapper Probe"},
  "plugins": [{
    "name": "wrapper-probe",
    "source": {"source": "local", "path": "./plugins/wrapper-probe"},
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX"]
    },
    "category": "Developer Tools"
  }]
}
JSON
  cat > "$target/plugins/wrapper-probe/.codex-plugin/plugin.json" <<JSON
{
  "name": "wrapper-probe",
  "version": "0.0.0+probe.$short",
  "description": "Throwaway offline Codex probe.",
  "skills": "./skills/",
  "interface": {
    "displayName": "Wrapper Probe",
    "shortDescription": "Offline marketplace probe.",
    "longDescription": "Temporary local plugin used only in an isolated container.",
    "developerName": "superpowers-wrapper",
    "category": "Developer Tools",
    "capabilities": ["skills"],
    "defaultPrompt": ["Use wrapper-probe only for local marketplace testing."]
  }
}
JSON
  printf '%s\n' '---' 'name: probe' 'description: offline probe' '---' '# Probe' > "$target/plugins/wrapper-probe/skills/probe/SKILL.md"
  printf '{"commit":"%s"}\n' "$commit" > "$target/plugins/wrapper-probe/.superpowers-upstream.json"
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
    if item.get("name") == "superpowers-wrapper-probe":
        actual_root = item.get("root")
        if isinstance(actual_root, str) and os.path.realpath(actual_root) == os.path.realpath(expected_root):
            raise SystemExit(0)
raise SystemExit("wrapper probe marketplace does not point at the expected root")
PY
}

assert_installed_commit() {
  expected_commit="$1"
  python3 - "$HOME/.codex" "$expected_commit" <<'PY'
import json
from pathlib import Path
import sys

search_root = Path(sys.argv[1])
expected_commit = sys.argv[2]
for path in search_root.rglob(".superpowers-upstream.json"):
    if "wrapper-probe" not in path.parts:
        continue
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError, ValueError):
        continue
    if isinstance(data, dict) and data.get("commit") == expected_commit:
        raise SystemExit(0)
raise SystemExit("wrapper probe installed provenance does not match the expected commit")
PY
}

write_market "$market" "$commit_a"
run_codex plugin marketplace add "$market"
run_codex plugin add "$plugin_id"
assert_marketplace_root "$market"
assert_installed_commit "$commit_a"

write_market "$moved" "$commit_b"
run_codex plugin marketplace remove superpowers-wrapper-probe
run_codex plugin marketplace add "$moved"
run_codex plugin add "$plugin_id"
assert_marketplace_root "$moved"
assert_installed_commit "$commit_b"

run_codex plugin remove "$plugin_id"
run_codex plugin marketplace remove superpowers-wrapper-probe

if run_codex plugin list --json | grep -Fq "$plugin_id"; then exit 1; fi
if run_codex plugin marketplace list --json | grep -Fq 'superpowers-wrapper-probe'; then exit 1; fi
echo "codex offline probe: OK"
