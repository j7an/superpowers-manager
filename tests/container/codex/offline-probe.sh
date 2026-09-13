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
  node "$package/tests/container/codex/assert-state.ts" marketplace-root "$listing" "$expected"
}

assert_active_installed_commit() {
  listing="$1"
  expected_version="$2"
  expected_commit="$3"
  unexpected_commit="$4"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"
  node "$package/tests/container/codex/assert-state.ts" installed-commit     "$listing" "$expected_root" "$expected_version" "$expected_commit" "$unexpected_commit"
}

assert_active_installed_payload() {
  node "$package/tests/container/codex/assert-state.ts" installed-payload "$@"
}

damage_active_skill() {
  node "$package/tests/container/codex/assert-state.ts" damage-skill "$@"
}

snapshot_hook_state() {
  node "$package/tests/container/codex/assert-state.ts" hook-state "$HOME/.codex/hooks.state"
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
  node "$package/tests/container/codex/assert-state.ts" requirements-unchanged "$requirements" "$requirements_digest"
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
  node "$package/tests/container/codex/assert-state.ts" empty-hooks "$listing" "$expected_root"
}

assert_active_hooks_fixture() {
  listing="$1"
  expected_version="$2"
  expected_root="$HOME/.codex/plugins/cache/superpowers-manager/superpowers/$expected_version"
  node "$package/tests/container/codex/assert-state.ts" active-hooks "$listing" "$expected_root"
}

assert_hooks_schema_compatible() {
  node "$package/tests/container/codex/assert-schema.ts"     "$schema_root/ClientRequest.json" "$schema_root/v2/HooksListResponse.json"
}

capture_hooks_response() {
  probe_cwd=$(pwd -P)
  if ! "$timeout_bin" 30 node     "$package/tests/container/codex/hooks-list-rpc.ts"     "$probe_cwd" "$hooks_response" "$hooks_stderr"; then
    cat "$hooks_stderr" >&2
    return 1
  fi
}

capture_manager_skills() {
  skills_capture=$((skills_capture + 1))
  skills_response="$root/skills-list-$skills_capture.response.json"
  skills_stderr="$root/skills-list-$skills_capture.stderr"
  if ! "$timeout_bin" 30 node     "$package/tests/container/codex/hooks-list-rpc.ts"     "$package" "$skills_response" "$skills_stderr" skills/list; then
    cat "$skills_stderr" >&2
    return 1
  fi
  skills_listing=$(run_codex plugin list --json)
  node "$package/tests/container/codex/assert-state.ts" skills     "$skills_response" "$skills_listing" "$upstream" "$package"
}

assert_manager_hooks_absent() {
  node "$package/tests/container/codex/assert-state.ts" hooks-absent "$1"
}

assert_manager_hook_active() {
  node "$package/tests/container/codex/assert-state.ts" hook-active "$1"
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
requirements_digest=$(node "$package/tests/container/codex/assert-state.ts" digest "$requirements")

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
node "$package/tests/container/codex/assert-state.ts" legacy-uninstall \
  "$legacy_uninstall_plugins" "$legacy_uninstall_marketplaces"
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
node "$package/tests/container/codex/assert-state.ts" missing-source-uninstall \
  "$legacy_missing_uninstall_plugins" "$legacy_missing_uninstall_marketplaces"

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
              run(process.execPath, [helper, packageRoot, response, stderr, "skills/list"], { timeout: 10_000 }),
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
  node "$driver" "$package" "$package/tests/container/codex/hooks-list-rpc.ts" "$boundary_response" "$boundary_stderr"
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
node "$package/tests/container/codex/assert-state.ts" final-uninstall \
  "$final_plugins" "$before_uninstall_marketplaces" "$final_marketplaces"

echo "codex offline probe: OK"
