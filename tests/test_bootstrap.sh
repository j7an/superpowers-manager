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

assert_not_matches() {
  path="$1"
  pattern="$2"
  if grep -Eq "$pattern" "$root/$path"; then
    echo "unexpected pattern in $path: $pattern" >&2
    exit 1
  fi
}

assert_count() {
  path="$1"
  text="$2"
  expected="$3"
  actual=$(grep -Fc "$text" "$root/$path" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "unexpected count in $path for $text: $actual (expected $expected)" >&2
    exit 1
  fi
}

assert_line() {
  path="$1"
  text="$2"
  if ! grep -Fxq "$text" "$root/$path"; then
    echo "missing exact line in $path: $text" >&2
    exit 1
  fi
}

assert_before() {
  path="$1"
  first="$2"
  second="$3"
  if ! awk -v first="$first" -v second="$second" '
    index($0, first) && !first_line { first_line = NR }
    index($0, second) && !second_line { second_line = NR }
    END { exit !(first_line && second_line && first_line < second_line) }
  ' "$root/$path"; then
    echo "text out of order in $path: $first before $second" >&2
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
assert_contains "package.json" '"version": "0.1.4"'
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
assert_contains "README.md" "npx superpowers-manager@0.1.4 install"
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

release_runbook="RELEASING.md"
assert_contains "$release_runbook" "Releasing Superpowers Manager 0.1.4"
assert_contains "$release_runbook" "failed run 29501874951"
assert_contains "$release_runbook" "v0.1.2 must not be moved, deleted, or recreated"
assert_contains "$release_runbook" "release/0.1.4-manager"
assert_contains "$release_runbook" "v0.1.3"
assert_contains "$release_runbook" "v0.1.4"
assert_contains "$release_runbook" "npm@11.16.0"
assert_contains "$release_runbook" 'test "$(npm --version)" = "11.16.0"'
assert_contains "$release_runbook" "superpowers-manager@0.1.4"
assert_contains "$release_runbook" "Reuse the existing one-day granular npm token"
assert_contains "$release_runbook" "Do not create another npm token"
assert_contains "$release_runbook" "29547694362"
assert_contains "$release_runbook" "87783582029"
assert_contains "$release_runbook" 'npm publish "dist/superpowers-manager-0.1.3.tgz"'
assert_contains "$release_runbook" 'npm publish "./dist/superpowers-manager-0.1.3.tgz"'
assert_contains "$release_runbook" 'TARBALL: ./dist/${{ needs.build.outputs.filename }}'
merge_gate="### Recovery Gate pre-R1: authorize the squash merge"
r1_gate="## 5. Recovery Gate R1: push exact lightweight v0.1.4"
merge_authorization='After separate explicit pre-R1 merge authorization only, squash-merge'
assert_line "$release_runbook" "$merge_gate"
assert_line "$release_runbook" "$r1_gate"
assert_contains "$release_runbook" '**STOP — EXTERNAL MUTATION GATE PRE-R1 MERGE**'
assert_contains "$release_runbook" 'Content review and PR approval do not authorize the squash merge.'
assert_contains "$release_runbook" 'Obtain separate just-in-time authorization immediately before the squash merge.'
assert_contains "$release_runbook" "$merge_authorization"
assert_not_contains "$release_runbook" 'After explicit PR approval, squash-merge'
assert_before "$release_runbook" 'Content review and PR approval do not authorize the squash merge.' "$merge_gate"
assert_before "$release_runbook" "$merge_gate" 'Obtain separate just-in-time authorization immediately before the squash merge.'
assert_before "$release_runbook" "$merge_gate" "$merge_authorization"
assert_before "$release_runbook" "$merge_authorization" "$r1_gate"
trusted_gate="## 11. Recovery Gate R4: configure permanent trusted publishing"
token_gate="## 12. Recovery Gate R5: disallow token publishing"
deprecation_gate="## 13. Recovery Gate R6: deprecate the exact old package"
assert_line "$release_runbook" "$trusted_gate"
assert_line "$release_runbook" "$token_gate"
assert_line "$release_runbook" "$deprecation_gate"
assert_contains "$release_runbook" 'R4 authorizes only permanent trusted-publisher configuration for'
assert_contains "$release_runbook" 'R5 authorizes only the package token-disallow policy for'
assert_contains "$release_runbook" 'R6 authorizes only package-wide deprecation metadata for'
assert_contains "$release_runbook" 'After separate explicit R4 approval only'
assert_contains "$release_runbook" 'After separate explicit R5 approval only'
assert_contains "$release_runbook" 'After separate explicit R6 approval only'
assert_before "$release_runbook" "$trusted_gate" "$token_gate"
assert_before "$release_runbook" "$token_gate" "$deprecation_gate"
assert_contains "$release_runbook" 'npm_root=$(mktemp -d)'
assert_contains "$release_runbook" 'NPM_CONFIG_PREFIX="$npm_prefix"'
assert_contains "$release_runbook" 'NPM_CONFIG_CACHE="$npm_cache"'
assert_contains "$release_runbook" 'PATH="$npm_prefix/bin:$PATH"'
assert_contains "$release_runbook" 'test "$(command -v npm)" = "$npm_prefix/bin/npm"'
assert_contains "$release_runbook" 'trap cleanup_npm EXIT HUP INT TERM'
assert_contains "$release_runbook" 'npm pack --dry-run --json > "$pack_report"'
assert_count "$release_runbook" 'npm install --global --ignore-scripts "npm@11.16.0"' 1
assert_count "$release_runbook" 'npm install --global "npm@11.16.0"' 1
assert_count "$release_runbook" 'expected_files="$boundary_dir/expected"' 2
assert_count "$release_runbook" 'actual_files="$boundary_dir/actual"' 2
assert_count "$release_runbook" 'cmp -s "$expected_files" "$actual_files"' 2
assert_count "$release_runbook" 'diff -u "$expected_files" "$actual_files"' 2
assert_contains "$release_runbook" 'git diff --name-only v0.1.3...HEAD'
assert_contains "$release_runbook" 'git diff --name-only v0.1.3..."$frozen_sha"'
assert_count "$release_runbook" 'git rev-list --parents -n 1 "$frozen_sha"' 3
assert_count "$release_runbook" '"$frozen_sha $(git rev-parse v0.1.3)"' 3
assert_not_contains "$release_runbook" 'git rev-parse "$frozen_sha^"'
assert_contains "$release_runbook" 'git show "$frozen_sha:tests/container/codex-offline-probe.sh"'
assert_contains "$release_runbook" 'snapshot=$(spw_codex_identity_snapshot run_codex)'
assert_contains "$release_runbook" 'test "$(spw_snapshot_get "$snapshot" identity_state)" = "neither"'
assert_contains "$release_runbook" 'codex offline probe: OK'
assert_contains "$release_runbook" 'artifact_integrity=$(node - "$artifact"'
assert_contains "$release_runbook" "createHash('sha512')"
assert_contains "$release_runbook" 'printf '\''artifact_integrity=%s\n'\'' "$artifact_integrity"'
assert_contains "$release_runbook" 'test "$registry_integrity" = "$artifact_integrity"'
assert_contains "$release_runbook" 'python3 - "$artifact" tests/expected_tarball_contents.txt <<'\''PY'\'''
assert_contains "$release_runbook" '# BEGIN PRE_R2_TARBALL_VERIFIER'
assert_contains "$release_runbook" '# END PRE_R2_TARBALL_VERIFIER'
assert_not_contains "$release_runbook" 'PRE_R3_TARBALL_VERIFIER'
assert_contains "$release_runbook" 'with tarfile.open(artifact_path, "r:gz") as archive:'
assert_contains "$release_runbook" 'member.name.removeprefix("package/")'
assert_contains "$release_runbook" 'assert actual_files == expected_files'
assert_contains "$release_runbook" 'assert package["name"] == "superpowers-manager"'
assert_contains "$release_runbook" 'assert package["version"] == "0.1.4"'
assert_contains "$release_runbook" 'assert package["repository"]["url"] == "git+https://github.com/j7an/superpowers-manager.git"'
assert_not_contains "$release_runbook" 'tar -tzf "$artifact"'
assert_not_contains "$release_runbook" 'tar -xOf "$artifact" package/package.json'
assert_count "$release_runbook" 'approved_reviewer = "j7an"' 2
assert_count "$release_runbook" 'assert "j7an" in reviewer_logins' 2
assert_count "$release_runbook" 'assert environment_secret_names == {"NPM_BOOTSTRAP_TOKEN"}' 2
assert_count "$release_runbook" 'assert "NPM_BOOTSTRAP_TOKEN" not in repository_secret_names' 3
assert_count "$release_runbook" 'repos/j7an/superpowers-manager/environments/npm-bootstrap/secrets' 2
assert_count "$release_runbook" 'repos/j7an/superpowers-manager/actions/secrets' 3
assert_contains "$release_runbook" 'require_environment_absent npm-bootstrap'
assert_contains "$release_runbook" 'assert {"npm", "release"}.issubset(environment_names)'
assert_contains "$release_runbook" 'registry_json=$(mktemp)'
assert_contains "$release_runbook" 'npm view superpowers-manager@0.1.4 \'
assert_contains "$release_runbook" 'assert metadata["name"] == "superpowers-manager"'
assert_contains "$release_runbook" 'assert metadata["version"] == "0.1.4"'
assert_contains "$release_runbook" 'assert metadata["repository"]["url"] == "git+https://github.com/j7an/superpowers-manager.git"'
assert_contains "$release_runbook" 'assert metadata["dist-tags"]["latest"] == "0.1.4"'
assert_contains "$release_runbook" 'assert metadata["dist.integrity"] == expected_integrity'
assert_contains "$release_runbook" 'assert metadata["dist.attestations"]["url"] == expected_attestations_url'
assert_contains "$release_runbook" 'assert metadata["dist.attestations"]["provenance"] == {'
assert_contains "$release_runbook" '"predicateType": "https://slsa.dev/provenance/v1"'
assert_contains "$release_runbook" 'test "$(NPM_CONFIG_CACHE="$tmp_cache" npx --yes superpowers-manager@0.1.4 --version)" = "0.1.4"'
assert_contains "$release_runbook" 'trap cleanup_post_publish EXIT HUP INT TERM'
assert_contains "$release_runbook" 'release_json=$(mktemp)'
assert_contains "$release_runbook" 'assert release["tagName"] == "v0.1.4"'
assert_contains "$release_runbook" 'assert release["name"] == "Superpowers Manager 0.1.4"'
assert_contains "$release_runbook" 'assert len(release["assets"]) == 1'
assert_contains "$release_runbook" 'assert asset["name"] == "superpowers-manager-0.1.4.tgz"'
assert_contains "$release_runbook" 'assert asset["digest"] == expected_digest'
assert_count "$release_runbook" 'require_npm_absent() {' 3
assert_count "$release_runbook" 'case "$npm_absence_output" in' 6
assert_count "$release_runbook" '*E404*) ;;' 3
assert_count "$release_runbook" '*"$package_spec"*) ;;' 3
assert_count "$release_runbook" 'require_release_absent() {' 3
assert_count "$release_runbook" 'gh api "repos/j7an/superpowers-manager/releases/tags/$release_tag" --silent' 3
assert_count "$release_runbook" '*"HTTP 404"*) ;;' 4
assert_count "$release_runbook" 'require_remote_tag_absent() {' 2
assert_count "$release_runbook" 'git ls-remote --exit-code origin "refs/tags/$remote_tag"' 2
assert_count "$release_runbook" 'if [ "$remote_tag_status" -ne 2 ]; then' 2
assert_line "$release_runbook" 'require_npm_absent superpowers-manager@0.1.2'
assert_line "$release_runbook" 'require_npm_absent superpowers-manager'
assert_contains "$release_runbook" 'require_npm_absent superpowers-manager@0.1.3'
assert_count "$release_runbook" 'require_npm_absent superpowers-manager@0.1.4' 2
assert_line "$release_runbook" 'require_release_absent v0.1.2'
assert_contains "$release_runbook" 'require_release_absent v0.1.3'
assert_count "$release_runbook" 'require_release_absent v0.1.4' 2
assert_count "$release_runbook" 'require_remote_tag_absent v0.1.4' 2
assert_not_contains "$release_runbook" 'npm view superpowers-manager@0.1.2 --json'
assert_not_contains "$release_runbook" 'npm view superpowers-manager@0.1.3 --json'
assert_not_contains "$release_runbook" 'npm view superpowers-manager@0.1.4 --json'
assert_not_contains "$release_runbook" 'gh release view v0.1.2 --repo j7an/superpowers-manager'
assert_not_contains "$release_runbook" 'gh release view v0.1.3 --repo j7an/superpowers-manager'
assert_not_contains "$release_runbook" 'gh release view v0.1.4 --repo j7an/superpowers-manager'
assert_not_matches "$release_runbook" '^[[:space:]]*git[[:space:]]+ls-remote[[:space:]]+--exit-code[[:space:]]+origin[[:space:]]+refs/tags/v0\.1\.4[[:space:]]*$'
assert_not_contains "$release_runbook" "SHA-512 integrity equals the build output"
assert_not_contains "$release_runbook" "reported manager identity state"
assert_not_contains "$release_runbook" 'gh secret set NPM_BOOTSTRAP_TOKEN'
assert_not_contains "$release_runbook" 'Create a new one-day granular npm token'
assert_not_matches "$release_runbook" '(^|[[:space:]])gh[[:space:]]+run[[:space:]]+rerun[^[:cntrl:]]*29501874951'
assert_not_matches "$release_runbook" '(^|[[:space:]])gh[[:space:]]+run[[:space:]]+rerun[^[:cntrl:]]*29547694362'
assert_not_matches "$release_runbook" '(^|[[:space:]])npm[[:space:]]+publish[^[:cntrl:]]*(0\.1\.2|superpowers-manager-0\.1\.2\.tgz)'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+tag([[:space:]]+-[^[:space:]]+)*[[:space:]]+v0\.1\.2([[:space:]]|$)'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+push[^[:cntrl:]]*(refs/tags/)?v0\.1\.2'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+update-ref[^[:cntrl:]]*refs/tags/v0\.1\.2'
assert_not_matches "$release_runbook" '(^|[[:space:]])gh[[:space:]]+release[[:space:]]+(create|delete|edit|upload)[^[:cntrl:]]*v0\.1\.2'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+tag([[:space:]]+-[^[:space:]]+)*[[:space:]]+v0\.1\.3([[:space:]]|$)'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+push[^[:cntrl:]]*(refs/tags/)?v0\.1\.3'
assert_not_matches "$release_runbook" '(^|[[:space:]])git[[:space:]]+update-ref[^[:cntrl:]]*refs/tags/v0\.1\.3'
assert_not_matches "$release_runbook" '(^|[[:space:]])gh[[:space:]]+release[[:space:]]+(create|delete|edit|upload)[^[:cntrl:]]*v0\.1\.3'

verifier_dir=$(mktemp -d)
trap 'rm -rf "$verifier_dir"' EXIT HUP INT TERM
verifier_script="$verifier_dir/verify_tarball.py"
awk '
  /^# BEGIN PRE_R2_TARBALL_VERIFIER$/ { capture = 1; next }
  /^# END PRE_R2_TARBALL_VERIFIER$/ { capture = 0; exit }
  capture { print }
' "$root/$release_runbook" > "$verifier_script"
test -s "$verifier_script"
NPM_CONFIG_CACHE="$verifier_dir/npm-cache" \
  npm pack --silent --pack-destination "$verifier_dir" "$root" >/dev/null
artifact="$verifier_dir/superpowers-manager-0.1.4.tgz"
test -f "$artifact"
python3 "$verifier_script" \
  "$artifact" \
  "$root/tests/expected_tarball_contents.txt"

mutated_expected="$verifier_dir/mutated-expected.txt"
grep -Fv 'scripts/update' \
  "$root/tests/expected_tarball_contents.txt" > "$mutated_expected"
if python3 "$verifier_script" "$artifact" "$mutated_expected" \
  >"$verifier_dir/mutant.out" 2>&1; then
  echo "tarball verifier accepted an incomplete expected-file list" >&2
  exit 1
fi

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
