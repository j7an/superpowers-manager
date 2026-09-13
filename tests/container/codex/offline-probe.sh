#!/bin/sh
set -eu

case "$HOME" in /home/spw|/tmp/*) ;; *) echo "error: refusing non-isolated HOME: $HOME" >&2; exit 1 ;; esac

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
package="$root/package"
upstream="$root/upstream"
state="$root/state"
survivor="$root/unrelated-provider"
schema_root="$root/app-server-schema"
hooks_response="$root/hooks-list.response.json"
hooks_stderr="$root/hooks-list.stderr"
skills_capture=0
sentinel="/tmp/superpowers-manager-hook-sentinel"
requirements="$HOME/.codex/requirements.toml"

cp -R /workspace "$package"
chmod +x "$package/src/cli.ts"
mkdir -p "$upstream/skills/probe" "$upstream/skills/using-superpowers" \
  "$upstream/.codex-plugin" \
  "$upstream/hooks/support" "$state" "$HOME/.codex" \
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
  run_packaged_manager "$@"
}

run_packaged_manager() {
  SUPERPOWERS_CONFIG_DIR="$state/config" \
  SUPERPOWERS_UPSTREAM_URL="$upstream" \
  SUPERPOWERS_CACHE_DIR="$state/cache" \
  SUPERPOWERS_CODEX=codex \
  SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex" \
    "$SPW_PACKAGE_NODE" "$manager_entry" "$@"
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

assert_active_installed_payload() {
  listing="$1"
  expected_marketplace="$2"
  expected_version="$3"
  expected_commit="$4"
  python3 -S - "$listing" "$expected_marketplace" "$expected_version" "$expected_commit" <<'PY'
import json
from pathlib import Path
import sys

listing, marketplace_arg, expected_version, expected_commit = sys.argv[1:]
data = json.loads(listing)
installed = data.get("installed") if isinstance(data, dict) else None
if not isinstance(installed, list):
    raise SystemExit("Codex plugin listing does not contain an installed array")
matches = [
    item for item in installed
    if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"
]
if len(matches) != 1 or matches[0].get("version") != expected_version:
    raise SystemExit("Codex active manager version changed during same-version refresh")
if matches[0].get("enabled") is not True:
    raise SystemExit("Codex manager plugin is not enabled during same-version refresh")

active_root = Path.home() / ".codex" / "plugins" / "cache" / "superpowers-manager" / "superpowers" / expected_version
active_root = active_root.resolve(strict=True)
source_root = (Path(marketplace_arg) / "plugins" / "superpowers").resolve(strict=True)
for relative in [Path(".codex-plugin/plugin.json"), Path(".superpowers-upstream.json")]:
    if (active_root / relative).read_bytes() != (source_root / relative).read_bytes():
        raise SystemExit(f"same-version refresh did not replace {relative.as_posix()}")
with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:
    provenance = json.load(handle)
if provenance.get("commit") != expected_commit:
    raise SystemExit("same-version refresh installed the wrong provenance commit")

def regular_files(root):
    if not root.is_dir() or root.is_symlink():
        raise SystemExit(f"same-version refresh skills root is not a directory: {root}")
    return sorted(
        path.relative_to(root)
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink()
    )

active_skills = active_root / "skills"
source_skills = source_root / "skills"
if regular_files(active_skills) != regular_files(source_skills):
    raise SystemExit("same-version refresh installed skill paths do not match the intact marketplace")
for relative in regular_files(source_skills):
    if (active_skills / relative).read_bytes() != (source_skills / relative).read_bytes():
        raise SystemExit(f"same-version refresh installed skill payload differs: {relative.as_posix()}")
PY
}

damage_active_skill() {
  listing="$1"
  expected_marketplace="$2"
  expected_version="$3"
  expected_commit="$4"
  python3 -S - "$listing" "$expected_marketplace" "$expected_version" "$expected_commit" <<'PY'
import json
from pathlib import Path
import sys

listing, marketplace_arg, expected_version, expected_commit = sys.argv[1:]
data = json.loads(listing)
installed = data.get("installed") if isinstance(data, dict) else None
if not isinstance(installed, list):
    raise SystemExit("Codex plugin listing does not contain an installed array")
matches = [
    item for item in installed
    if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"
]
if len(matches) != 1 or matches[0].get("version") != expected_version:
    raise SystemExit("Codex active manager version changed before same-version repair")
if matches[0].get("enabled") is not True:
    raise SystemExit("Codex manager plugin is not enabled before same-version repair")

active_root = Path.home() / ".codex" / "plugins" / "cache" / "superpowers-manager" / "superpowers" / expected_version
active_root = active_root.resolve(strict=True)
source_root = (Path(marketplace_arg) / "plugins" / "superpowers").resolve(strict=True)
with (active_root / ".superpowers-upstream.json").open(encoding="utf-8") as handle:
    provenance = json.load(handle)
if provenance.get("commit") != expected_commit:
    raise SystemExit("same-version repair started with the wrong provenance commit")
damaged = active_root / "skills" / "probe" / "SKILL.md"
expected = source_root / "skills" / "probe" / "SKILL.md"
if damaged.read_bytes() != expected.read_bytes():
    raise SystemExit("same-version repair fixture is not intact before damage")
damaged.write_text("damaged same-version payload\n", encoding="utf-8")
if damaged.read_bytes() == expected.read_bytes():
    raise SystemExit("same-version repair fixture did not damage the installed skill payload")
PY
}

snapshot_hook_state() {
  python3 -S - "$HOME/.codex/hooks.state" <<'PY'
import hashlib
import os
from pathlib import Path
import sys

path = Path(sys.argv[1])
if not os.path.lexists(path):
    print("absent")
elif path.is_symlink() or not path.is_file():
    raise SystemExit("Codex hooks.state must remain absent or a regular file")
else:
    print("file:" + hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

assert_hook_state_unchanged() {
  before="$1"
  after="$2"
  if [ "$before" != "$after" ]; then
    echo "manager mutation changed Codex hooks.state: $before -> $after" >&2
    exit 1
  fi
}

assert_requirements_unchanged() {
  python3 -S - "$requirements" "$requirements_digest" <<'PY'
import hashlib
from pathlib import Path
import sys

path = Path(sys.argv[1])
expected = sys.argv[2]
if not path.is_file() or path.is_symlink():
    raise SystemExit("manager mutation changed requirements.toml presence or type")
actual = hashlib.sha256(path.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit("manager mutation changed requirements.toml contents")
PY
}

assert_sentinel_absent() {
  if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
    echo "synthetic plugin hook executed unexpectedly" >&2
    exit 1
  fi
}

uninstall_missing_legacy_source() {
  hook_state_before=$(snapshot_hook_state)
  run_packaged_manager uninstall
  hook_state_after=$(snapshot_hook_state)
  assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
  assert_requirements_unchanged
  assert_sentinel_absent
}

assert_exact_empty_hooks_fixture() {
  listing="$1"
  expected_version="$2"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"
  python3 -S - "$listing" "$expected_root" <<'PY'
import json
import os
from pathlib import Path
import sys

listing, root_arg = sys.argv[1:]
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

active_root = Path(root_arg).resolve(strict=True)
with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("hooks") != {}:
    raise SystemExit("installed exact-empty hooks value is not {}")
if os.path.lexists(active_root / "hooks"):
    raise SystemExit("exact-empty hook fixture installed a hooks subtree")
PY
}

assert_active_hooks_fixture() {
  listing="$1"
  expected_version="$2"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"
  python3 -S - "$listing" "$expected_root" <<'PY'
import json
import os
from pathlib import Path
import sys

listing, root_arg = sys.argv[1:]
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

active_root = Path(root_arg).resolve(strict=True)
with (active_root / ".codex-plugin" / "plugin.json").open(encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("hooks") != "./hooks/hooks-codex.json":
    raise SystemExit("installed active hook manifest has the wrong hooks path")

hooks_root = active_root / "hooks"
expected_files = [
    "hooks-codex.json",
    "session-start-codex",
    "support/helper.txt",
]
actual_files = sorted(
    path.relative_to(hooks_root).as_posix()
    for path in hooks_root.rglob("*")
    if path.is_file()
)
if actual_files != expected_files:
    raise SystemExit(f"installed active hook subtree mismatch: {actual_files!r}")
with (hooks_root / "hooks-codex.json").open(encoding="utf-8") as handle:
    config = json.load(handle)
expected_config = {
    "hooks": {
        "SessionStart": [{
            "hooks": [{
                "type": "command",
                "command": 'sh "${PLUGIN_ROOT}/hooks/session-start-codex"',
            }]
        }]
    }
}
if config != expected_config:
    raise SystemExit("installed active hook config does not match upstream")
script = hooks_root / "session-start-codex"
if "/tmp/superpowers-manager-hook-sentinel" not in script.read_text(encoding="utf-8"):
    raise SystemExit("installed active hook script lost the sentinel payload")
if (hooks_root / "support" / "helper.txt").read_text(encoding="utf-8") != "support\n":
    raise SystemExit("installed active hook support subtree changed")
PY
}

assert_hooks_schema_compatible() {
  python3 -S - "$schema_root/ClientRequest.json" "$schema_root/v2/HooksListResponse.json" <<'PY'
import json
from pathlib import Path
import sys


def fail(message):
    raise SystemExit(f"Codex hooks/list protocol changed: {message}")


try:
    with Path(sys.argv[1]).open(encoding="utf-8") as handle:
        client_request = json.load(handle)
    with Path(sys.argv[2]).open(encoding="utf-8") as handle:
        hooks_response = json.load(handle)
except (OSError, json.JSONDecodeError) as exc:
    fail(f"schema could not be read: {exc}")


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def resolve(root, schema):
    seen = set()
    while isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        reference = schema["$ref"]
        if not reference.startswith("#/") or reference in seen:
            fail(f"unsupported schema reference: {reference}")
        seen.add(reference)
        target = root
        try:
            for component in reference[2:].split("/"):
                target = target[component.replace("~1", "/").replace("~0", "~")]
        except (KeyError, TypeError):
            fail(f"unresolved schema reference: {reference}")
        schema = target
    return schema


def scalar_values(root, schema):
    values = set()
    for node in walk(resolve(root, schema)):
        if not isinstance(node, dict):
            continue
        node = resolve(root, node)
        if "const" in node:
            values.add(node["const"])
        enum = node.get("enum")
        if isinstance(enum, list):
            values.update(enum)
    return values


def allowed_types(root, schema):
    types = set()
    for node in walk(resolve(root, schema)):
        if not isinstance(node, dict):
            continue
        node = resolve(root, node)
        declared = node.get("type")
        if isinstance(declared, str):
            types.add(declared)
        elif isinstance(declared, list):
            types.update(item for item in declared if isinstance(item, str))
    return types


method_found = False
for node in walk(client_request):
    if not isinstance(node, dict):
        continue
    properties = node.get("properties")
    if isinstance(properties, dict) and "method" in properties:
        if "hooks/list" in scalar_values(client_request, properties["method"]):
            method_found = True
            break
if not method_found:
    fail('ClientRequest does not contain method "hooks/list"')

metadata_candidates = []
for node in walk(hooks_response):
    if not isinstance(node, dict):
        continue
    named = node.get("HookMetadata")
    if isinstance(named, dict):
        metadata_candidates.append(named)
    if node.get("title") == "HookMetadata":
        metadata_candidates.append(node)
if not metadata_candidates:
    fail("HooksListResponse does not define HookMetadata")
metadata = resolve(hooks_response, metadata_candidates[0])
properties = metadata.get("properties") if isinstance(metadata, dict) else None
required = metadata.get("required") if isinstance(metadata, dict) else None
required_fields = {"source", "enabled", "isManaged", "trustStatus"}
if not isinstance(properties, dict) or not isinstance(required, list):
    fail("HookMetadata is not an object schema")
if not required_fields.issubset(required):
    fail("HookMetadata required fields changed")
if not required_fields.issubset(properties):
    fail("HookMetadata properties changed")
if "plugin" not in scalar_values(hooks_response, properties["source"]):
    fail('HookMetadata source no longer includes "plugin"')
if "untrusted" not in scalar_values(hooks_response, properties["trustStatus"]):
    fail('HookMetadata trustStatus no longer includes "untrusted"')
if "pluginId" not in properties:
    fail("HookMetadata no longer exposes pluginId")
if "pluginId" in required:
    fail("HookMetadata pluginId unexpectedly became required")
plugin_id_types = allowed_types(hooks_response, properties["pluginId"])
if plugin_id_types != {"string", "null"}:
    fail("HookMetadata pluginId is not string-or-null")
PY
}

capture_hooks_response() {
  probe_cwd=$(pwd -P)
  if ! "$timeout_bin" 30 python3 -S \
    "$package/tests/container/codex/hooks-list-rpc.py" \
    "$probe_cwd" "$hooks_response" "$hooks_stderr"; then
    cat "$hooks_stderr" >&2
    return 1
  fi
}

capture_manager_skills() {
  skills_capture=$((skills_capture + 1))
  skills_response="$root/skills-list-$skills_capture.response.json"
  skills_stderr="$root/skills-list-$skills_capture.stderr"
  if ! "$timeout_bin" 30 python3 -S \
    "$package/tests/container/codex/hooks-list-rpc.py" \
    "$package" "$skills_response" "$skills_stderr" skills/list; then
    cat "$skills_stderr" >&2
    return 1
  fi
  skills_listing=$(run_codex plugin list --json)
  python3 -S - "$skills_response" "$skills_listing" "$upstream" "$package" <<'PY'
import json
from pathlib import Path
import sys

response_name, listing_json, upstream_arg, requested_cwd = sys.argv[1:]
with Path(response_name).open(encoding="utf-8") as handle:
    response = json.load(handle)
if not isinstance(response, dict) or response.get("id") != 1:
    raise SystemExit("skills/list response is missing id 1")
result = response.get("result")
if not isinstance(result, dict) or not isinstance(result.get("data"), list):
    raise SystemExit("skills/list response has no data array")
entries = [item for item in result["data"] if isinstance(item, dict) and item.get("cwd") == requested_cwd]
if len(entries) != 1:
    raise SystemExit("skills/list must contain exactly one requested cwd entry")
entry = entries[0]
if entry.get("errors") != [] or not isinstance(entry.get("skills"), list):
    raise SystemExit("skills/list reports errors or malformed skills")

listing = json.loads(listing_json)
installed = listing.get("installed") if isinstance(listing, dict) else None
if not isinstance(installed, list):
    raise SystemExit("Codex plugin listing does not contain an installed array")
matches = [
    item for item in installed
    if isinstance(item, dict) and item.get("pluginId") == "superpowers@superpowers-manager"
]
if len(matches) != 1:
    raise SystemExit("Codex listing must contain exactly one manager plugin")
version = matches[0].get("version")
if not isinstance(version, str) or not version:
    raise SystemExit("Codex active manager version is missing or malformed")
if matches[0].get("enabled") is not True:
    raise SystemExit("Codex manager plugin is not enabled")

active = (Path.home() / ".codex/plugins/cache/superpowers-manager/superpowers" / version).resolve(strict=True)
upstream = Path(upstream_arg).resolve(strict=True)
expected = {
    "superpowers:probe": upstream / "skills/probe/SKILL.md",
    "superpowers:using-superpowers": upstream / "skills/using-superpowers/SKILL.md",
}
found = {name: [] for name in expected}
for skill in entry["skills"]:
    if not isinstance(skill, dict):
        continue
    name, path = skill.get("name"), skill.get("path")
    if name not in expected:
        continue
    if skill.get("enabled") is not True or not isinstance(path, str):
        raise SystemExit("manager skill metadata is malformed or disabled")
    if "pluginId" in skill and skill["pluginId"] != "superpowers@superpowers-manager":
        raise SystemExit("manager skill pluginId does not match the manager identity")
    resolved = Path(path).resolve(strict=True)
    if active not in resolved.parents:
        raise SystemExit("manager skill is not loaded from the active manager cache")
    if resolved.read_bytes() != expected[name].read_bytes():
        raise SystemExit(f"manager skill fixture bytes mismatch: {name}")
    found[name].append(resolved)
if any(len(paths) != 1 for paths in found.values()):
    raise SystemExit("each expected manager fixture skill must occur exactly once")
PY
}

assert_manager_hooks_absent() {
  response_name="$1"
  python3 -S - "$response_name" <<'PY'
import json
from pathlib import Path
import sys

response_name = sys.argv[1]
with Path(response_name).open(encoding="utf-8") as handle:
    response = json.load(handle)
if not isinstance(response, dict) or response.get("id") != 1:
    raise SystemExit("hooks/list response is missing id 1")
if "error" in response:
    raise SystemExit(f"hooks/list returned an RPC error: {response['error']!r}")
result = response.get("result")
if not isinstance(result, dict):
    raise SystemExit("hooks/list response has no result object")
data = result.get("data")
if not isinstance(data, list):
    raise SystemExit("hooks/list result has no data array")
hooks = []
for item in data:
    if not isinstance(item, dict) or not isinstance(item.get("hooks"), list):
        raise SystemExit("hooks/list data entry is malformed")
    if not all(isinstance(hook, dict) for hook in item["hooks"]):
        raise SystemExit("hooks/list hook metadata is malformed")
    hooks.extend(item["hooks"])
manager_hooks = [
    hook for hook in hooks
    if hook.get("pluginId") == "superpowers@superpowers-manager"
]
if manager_hooks:
    raise SystemExit("exact-empty manager plugin unexpectedly exposes a hook")
PY
}

assert_manager_hook_active() {
  response_name="$1"
  python3 -S - "$response_name" <<'PY'
import json
from pathlib import Path
import sys

response_name = sys.argv[1]
with Path(response_name).open(encoding="utf-8") as handle:
    response = json.load(handle)
if not isinstance(response, dict) or response.get("id") != 1:
    raise SystemExit("hooks/list response is missing id 1")
if "error" in response:
    raise SystemExit(f"hooks/list returned an RPC error: {response['error']!r}")
result = response.get("result")
if not isinstance(result, dict):
    raise SystemExit("hooks/list response has no result object")
data = result.get("data")
if not isinstance(data, list):
    raise SystemExit("hooks/list result has no data array")
hooks = []
for item in data:
    if not isinstance(item, dict) or not isinstance(item.get("hooks"), list):
        raise SystemExit("hooks/list data entry is malformed")
    if not all(isinstance(hook, dict) for hook in item["hooks"]):
        raise SystemExit("hooks/list hook metadata is malformed")
    hooks.extend(item["hooks"])
manager_hooks = [
    hook for hook in hooks
    if hook.get("pluginId") == "superpowers@superpowers-manager"
]
if len(manager_hooks) != 1:
    raise SystemExit("active manager plugin must expose exactly one hook")
expected = {
    "source": "plugin",
    "pluginId": "superpowers@superpowers-manager",
    "trustStatus": "untrusted",
}
actual = manager_hooks[0]
for key, value in expected.items():
    if actual.get(key) != value:
        raise SystemExit(f"active manager hook metadata mismatch for {key}: {actual.get(key)!r}")
if actual.get("enabled") is not True:
    raise SystemExit(f"active manager hook enabled is not true: {actual.get('enabled')!r}")
if actual.get("isManaged") is not False:
    raise SystemExit(f"active manager hook isManaged is not false: {actual.get('isManaged')!r}")
PY
}

cat > "$upstream/skills/probe/SKILL.md" <<'EOF'
---
name: probe
description: Offline manager A/B probe
---
# Probe A
EOF
cat > "$upstream/skills/using-superpowers/SKILL.md" <<'EOF'
---
name: using-superpowers
description: Offline native bootstrap skill
---
# Using Superpowers
EOF
printf '%s\n' 'license' > "$upstream/LICENSE"
printf '%s\n' 'readme' > "$upstream/README.md"
printf '%s\n' 'code of conduct' > "$upstream/CODE_OF_CONDUCT.md"
printf '%s\n' 'support' > "$upstream/hooks/support/helper.txt"
cat > "$upstream/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "1.0.0",
  "description": "Offline manager A/B acceptance plugin.",
  "skills": "./skills/",
  "hooks": {},
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

set -- /opt/spw-package/*.tgz
test "$#" -eq 1 && test -f "$1" || exit 1
manager_tarball="$1"
first_extraction="$root/extracted-first"
second_extraction="$root/extracted-second"
mkdir -p "$first_extraction" "$second_extraction"
tar -xzf "$manager_tarball" -C "$first_extraction"
tar -xzf "$manager_tarball" -C "$second_extraction"
manager_entry="$first_extraction/package/dist/cli.js"
test -f "$manager_entry" || exit 1

printf '%s\n' '# Comment-only hook requirements remain manager-independent.' > "$requirements"
requirements_digest=$(python3 -S -c \
  'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' \
  "$requirements")

hook_state_before=$(snapshot_hook_state)
run_manager track-latest
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
hook_state_before=$(snapshot_hook_state)
run_manager install
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
initial_listing=$(run_codex plugin list --json)
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$initial_listing" "$version_a" "$commit_a" ""
assert_exact_empty_hooks_fixture "$initial_listing" "$version_a"
run_codex app-server generate-json-schema --out "$schema_root"
assert_hooks_schema_compatible
capture_hooks_response
assert_manager_hooks_absent "$hooks_response"
capture_manager_skills
assert_sentinel_absent

case "$first_extraction" in "$root"/*) ;; *) echo "error: refusing extraction removal outside probe root" >&2; exit 1 ;; esac
rm -rf "$first_extraction/package"
manager_entry="$second_extraction/package/dist/cli.js"
test -f "$manager_entry" || exit 1
capture_manager_skills
run_packaged_manager probe --harness codex
mkdir -p "$first_extraction"
tar -xzf "$manager_tarball" -C "$first_extraction"
manager_entry="$first_extraction/package/dist/cli.js"
capture_manager_skills
run_codex plugin list --json >/dev/null

codex_version=$(run_codex --version)
printf '%s\n' "codex native refresh prerequisite: $codex_version"
original_marketplace="$root/original-marketplace"
cp -R "$HOME/.codex/superpowers-manager/marketplace" "$original_marketplace"
same_version_marketplace="$root/same-version-marketplace"
cp -R "$original_marketplace" "$same_version_marketplace"
assert_active_installed_payload "$initial_listing" "$same_version_marketplace" "$version_a" "$commit_a"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$same_version_marketplace"
run_codex plugin add superpowers@superpowers-manager
migration_listing=$(run_codex plugin list --json)
assert_marketplace_root "$same_version_marketplace"
assert_active_installed_payload "$migration_listing" "$same_version_marketplace" "$version_a" "$commit_a"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$original_marketplace"
run_codex plugin add superpowers@superpowers-manager
reset_listing=$(run_codex plugin list --json)
assert_marketplace_root "$original_marketplace"
assert_active_installed_payload "$reset_listing" "$original_marketplace" "$version_a" "$commit_a"
damage_active_skill "$reset_listing" "$original_marketplace" "$version_a" "$commit_a"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$same_version_marketplace"
run_codex plugin add superpowers@superpowers-manager
damaged_migration_listing=$(run_codex plugin list --json)
assert_marketplace_root "$same_version_marketplace"
assert_active_installed_payload "$damaged_migration_listing" "$same_version_marketplace" "$version_a" "$commit_a"
damage_active_skill "$damaged_migration_listing" "$same_version_marketplace" "$version_a" "$commit_a"
run_codex plugin add superpowers@superpowers-manager
repair_listing=$(run_codex plugin list --json)
assert_active_installed_payload "$repair_listing" "$same_version_marketplace" "$version_a" "$commit_a"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$original_marketplace"
run_codex plugin add superpowers@superpowers-manager
restored_listing=$(run_codex plugin list --json)
assert_marketplace_root "$original_marketplace"
assert_active_installed_payload "$restored_listing" "$original_marketplace" "$version_a" "$commit_a"
hook_state_before=$(snapshot_hook_state)
run_packaged_manager update
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
durable_seed_listing=$(run_codex plugin list --json)
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$durable_seed_listing" "$version_a" "$commit_a" ""

# Seed old local registrations with an already-valid native cache, then make
# the old source progressively less useful. The manager must use the native
# artifact and publish its own durable marketplace without removing the old
# source directory.
legacy_uninstall="$root/legacy-uninstall"
cp -R "$HOME/.codex/superpowers-manager/marketplace" "$legacy_uninstall"
legacy_healthy="$root/legacy-healthy"
cp -R "$HOME/.codex/superpowers-manager/marketplace" "$legacy_healthy"
printf '%s\n' preserved > "$legacy_uninstall/legacy-source-preserved"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$legacy_uninstall"
run_codex plugin add superpowers@superpowers-manager
case "$legacy_uninstall" in "$root"/*) ;; *) echo "error: refusing legacy fixture mutation outside probe root" >&2; exit 1 ;; esac
rm -rf "$legacy_uninstall/plugins/superpowers/skills"
mkdir -p "$legacy_uninstall/plugins/superpowers/skills"
hook_state_before=$(snapshot_hook_state)
run_packaged_manager uninstall
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
legacy_uninstall_plugins=$(run_codex plugin list --json)
legacy_uninstall_marketplaces=$(run_codex plugin marketplace list --json)
python3 -S - "$legacy_uninstall_plugins" "$legacy_uninstall_marketplaces" <<'PY'
import json
import sys
plugins, marketplaces = map(json.loads, sys.argv[1:])
if any(item.get("pluginId") == "superpowers@superpowers-manager" for item in plugins.get("installed", []) if isinstance(item, dict)):
    raise SystemExit("legacy uninstall left the manager plugin registered")
if any(item.get("name") == "superpowers-manager" for item in marketplaces.get("marketplaces", []) if isinstance(item, dict)):
    raise SystemExit("legacy uninstall left the manager marketplace registered")
PY
test -f "$legacy_uninstall/.agents/plugins/marketplace.json" || exit 1
test -f "$legacy_uninstall/legacy-source-preserved" || exit 1

legacy_missing_uninstall="$root/legacy-missing-uninstall"
cp -R "$original_marketplace" "$legacy_missing_uninstall"
run_codex plugin marketplace add "$legacy_missing_uninstall"
run_codex plugin add superpowers@superpowers-manager
test -f "$state/config/selection.json" || exit 1
test -d "$HOME/.codex/superpowers-manager/prepared" || exit 1
cp "$state/config/selection.json" "$root/missing-uninstall-selection.before"
cp -R "$HOME/.codex/superpowers-manager/prepared" "$root/missing-uninstall-prepared.before"
case "$legacy_missing_uninstall" in "$root"/*) ;; *) echo "error: refusing legacy fixture removal outside probe root" >&2; exit 1 ;; esac
rm -rf "$legacy_missing_uninstall"
uninstall_missing_legacy_source
test ! -e "$legacy_missing_uninstall" && test ! -L "$legacy_missing_uninstall" || exit 1
cmp "$root/missing-uninstall-selection.before" "$state/config/selection.json"
diff -r "$root/missing-uninstall-prepared.before" "$HOME/.codex/superpowers-manager/prepared"
legacy_missing_uninstall_plugins=$(run_codex plugin list --json)
legacy_missing_uninstall_marketplaces=$(run_codex plugin marketplace list --json)
python3 -S - "$legacy_missing_uninstall_plugins" "$legacy_missing_uninstall_marketplaces" <<'PY'
import json
import sys
plugins, marketplaces = map(json.loads, sys.argv[1:])
if any(item.get("pluginId") == "superpowers@superpowers-manager" for item in plugins.get("installed", []) if isinstance(item, dict)):
    raise SystemExit("missing-source uninstall left the manager plugin registered")
names = [item.get("name") for item in marketplaces.get("marketplaces", []) if isinstance(item, dict)]
if "superpowers-manager" in names:
    raise SystemExit("missing-source uninstall left the manager marketplace registered")
if "unrelated-provider" not in names:
    raise SystemExit("missing-source uninstall removed the unrelated provider")
PY

run_codex plugin marketplace add "$legacy_healthy"
run_codex plugin add superpowers@superpowers-manager
hook_state_before=$(snapshot_hook_state)
run_packaged_manager update
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
legacy_healthy_listing=$(run_codex plugin list --json)
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$legacy_healthy_listing" "$version_a" "$commit_a" ""
capture_manager_skills

legacy_template_only="$root/legacy-template-only"
cp -R "$HOME/.codex/superpowers-manager/marketplace" "$legacy_template_only"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$legacy_template_only"
run_codex plugin add superpowers@superpowers-manager
case "$legacy_template_only" in "$root"/*) ;; *) echo "error: refusing legacy fixture mutation outside probe root" >&2; exit 1 ;; esac
rm -rf "$legacy_template_only/plugins/superpowers/skills"
mkdir -p "$legacy_template_only/plugins/superpowers/skills"
hook_state_before=$(snapshot_hook_state)
run_packaged_manager update
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
legacy_template_listing=$(run_codex plugin list --json)
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$legacy_template_listing" "$version_a" "$commit_a" ""
capture_manager_skills

legacy_missing="$root/legacy-missing"
cp -R "$HOME/.codex/superpowers-manager/marketplace" "$legacy_missing"
run_codex plugin marketplace remove superpowers-manager
run_codex plugin marketplace add "$legacy_missing"
run_codex plugin add superpowers@superpowers-manager
case "$legacy_missing" in "$root"/*) ;; *) echo "error: refusing legacy fixture removal outside probe root" >&2; exit 1 ;; esac
rm -rf "$legacy_missing"
hook_state_before=$(snapshot_hook_state)
run_packaged_manager update
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
legacy_missing_listing=$(run_codex plugin list --json)
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$legacy_missing_listing" "$version_a" "$commit_a" ""
capture_manager_skills

driver="$root/codex-publication-reader.ts"
cat > "$driver" <<'EOF'
import { execFile } from "node:child_process";
import { rename } from "node:fs/promises";
import { promisify } from "node:util";
import { beginDirectoryPublication } from "/workspace/src/atomic.ts";
import { codexInspectControl, codexInspectOwnership, codexInstall, codexReadNativeState } from "/workspace/src/harnesses/codex/adapter.ts";
import { readCodexPrepared } from "/workspace/src/harnesses/codex/prepare.ts";
import { codexPaths } from "/workspace/src/harnesses/codex/paths.ts";
import { installCodexMarketplace } from "/workspace/src/harnesses/codex/publication.ts";
import { readCodexRecovery } from "/workspace/src/harnesses/codex/recovery.ts";

const run = promisify(execFile);
const [packageRoot, helper, response, stderr] = process.argv.slice(2);
if (![packageRoot, helper, response, stderr].every((value) => typeof value === "string")) throw new Error("driver arguments");
const env = { ...process.env, SUPERPOWERS_CONFIG_DIR: process.env.SUPERPOWERS_CONFIG_DIR!, SUPERPOWERS_UPSTREAM_URL: process.env.SUPERPOWERS_UPSTREAM_URL!, SUPERPOWERS_CACHE_DIR: process.env.SUPERPOWERS_CACHE_DIR!, SUPERPOWERS_CODEX: "codex", SUPERPOWERS_INSTALLED_SEARCH_ROOT: process.env.SUPERPOWERS_INSTALLED_SEARCH_ROOT! };
const ctx = { root: packageRoot, env };
const prepared = await readCodexPrepared(ctx);
if (!prepared.outcome.ok || prepared.outcome.result === null) throw new Error("prepared artifact unavailable");
const paths = codexPaths(env, process.cwd());
let observed = false;
const result = await installCodexMarketplace(
  prepared.outcome.result,
  ctx,
  codexInstall,
  {
    readNative: codexReadNativeState,
    inspectOwnership: codexInspectOwnership,
    inspectControl: codexInspectControl,
    beginPublication: async (candidate, live, options) => await beginDirectoryPublication(candidate, live, {
      ...options,
      hooks: {
        rename: async (from, to) => {
          await rename(from, to);
          if (from === paths.marketplaceRoot && to === options.backupPath) {
            observed = true;
            const readers = await Promise.allSettled([
              run("codex", ["plugin", "list", "--json"], { timeout: 10_000 }),
              run("python3", ["-S", helper, packageRoot, response, stderr, "skills/list"], { timeout: 10_000 }),
            ]);
            for (const reader of readers) {
              if (reader.status === "rejected") {
                const reason = reader.reason as { code?: unknown; killed?: unknown };
                console.error(`boundary reader failed code=${String(reason.code)} killed=${String(reason.killed)}`);
              } else {
                console.error(`boundary reader completed stdout=${reader.value.stdout.length} stderr=${reader.value.stderr.length}`);
              }
            }
          }
        },
      },
    }),
  },
);
if (!observed) throw new Error("live-to-backup publication boundary was not observed");
if (!result.outcome.ok || result.status !== 0 || result.outcome.result === null) {
  if (result.outcome.ok || result.status === 0) throw new Error("failed boundary publication reported success");
  const recovered = await codexReadNativeState(ctx);
  if (!recovered.outcome.ok) throw new Error("failed publication left unverifiable recovery state");
  if ((await readCodexRecovery(paths)) === null) throw new Error("failed publication left no validated recovery record");
  console.error("publication boundary outcome: retained validated recovery");
  process.exitCode = 0;
} else {
  const settled = await result.outcome.result.transaction.finalize();
  if (!settled.outcome.ok || settled.status !== 0) throw new Error("published transaction did not finalize");
  console.error("publication boundary outcome: finalized");
}
EOF
boundary_response="$root/boundary-skills.response.json"
boundary_stderr="$root/boundary-skills.stderr"
SUPERPOWERS_CONFIG_DIR="$state/config" SUPERPOWERS_UPSTREAM_URL="$upstream" SUPERPOWERS_CACHE_DIR="$state/cache" SUPERPOWERS_INSTALLED_SEARCH_ROOT="$HOME/.codex" \
  node "$driver" "$package" "$package/tests/container/codex/hooks-list-rpc.py" "$boundary_response" "$boundary_stderr"
capture_manager_skills

printf '%s\n' '# Probe B' >> "$upstream/skills/probe/SKILL.md"
cat > "$upstream/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "superpowers",
  "version": "1.1.0",
  "description": "Offline manager A/B acceptance plugin.",
  "skills": "./skills/",
  "hooks": "./hooks/hooks-codex.json",
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
cat > "$upstream/hooks/hooks-codex.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "sh \"${PLUGIN_ROOT}/hooks/session-start-codex\""
      }]
    }]
  }
}
JSON
cat > "$upstream/hooks/session-start-codex" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' 'executed' > /tmp/superpowers-manager-hook-sentinel
EOF
chmod +x "$upstream/hooks/session-start-codex"
git -C "$upstream" add .
git -C "$upstream" commit -qm 'probe B'
git -C "$upstream" tag v1.1.0
commit_b=$(git -C "$upstream" rev-parse HEAD)
short_b=$(printf '%s' "$commit_b" | cut -c 1-7)
version_b="1.1.0+manager.$short_b"

reload_listing=$(run_codex plugin list --json)
printf '%s\n' "$reload_listing" | grep -Fq 'superpowers@superpowers-manager'
assert_marketplace_root "$HOME/.codex/superpowers-manager/marketplace"
assert_active_installed_commit "$reload_listing" "$version_a" "$commit_a" "$commit_b"

manager_entry="$second_extraction/package/dist/cli.js"
hook_state_before=$(snapshot_hook_state)
run_manager update
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
updated_listing=$(run_codex plugin list --json)
assert_active_installed_commit "$updated_listing" "$version_b" "$commit_b" "$commit_a"
assert_active_hooks_fixture "$updated_listing" "$version_b"
capture_hooks_response
assert_manager_hook_active "$hooks_response"
capture_manager_skills
assert_sentinel_absent

before_uninstall_marketplaces=$(run_codex plugin marketplace list --json)
hook_state_before=$(snapshot_hook_state)
run_manager uninstall
hook_state_after=$(snapshot_hook_state)
assert_hook_state_unchanged "$hook_state_before" "$hook_state_after"
assert_requirements_unchanged
assert_sentinel_absent
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
