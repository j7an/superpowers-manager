# Releasing Superpowers Manager 0.1.3

This is the authoritative recovery procedure for
`superpowers-manager@0.1.3`. It replaces the failed `0.1.2` procedure. Reading,
reviewing, merging, or following the read-only checks in this document does not
authorize an external mutation.

Stop at every **Recovery Gate** and obtain explicit approval for only the
mutation named by that gate. Approvals are non-transitive: approval for R1 does
not authorize R2, approval for R2 does not authorize R3, and so on through R6.
No approval authorizes a different package, version, tag, workflow run,
environment, credential, repository, or npm metadata change.

## 1. Preserve the failed incident as immutable evidence

The public `v0.1.2` tag points to:

```text
733ddfc0dce4598c65a4945df08f7a0f64d875a4
```

GitHub Actions failed run 29501874951 is:

```text
https://github.com/j7an/superpowers-manager/actions/runs/29501874951
```

The run passed frozen-source verification and isolated acceptance, then failed
before artifact upload because `npm install --global "npm@>=11.5.1"` selected
npm `12.0.1`. npm 12 changed `npm pack --json` from the reviewed npm-11
one-element array to an object keyed by package name. The publish and GitHub
release jobs were skipped.

No `superpowers-manager@0.1.2` npm version, uploaded workflow artifact, or
GitHub release was created. The failed-run npm token was revoked. Its
`NPM_BOOTSTRAP_TOKEN` environment secret and temporary `npm-bootstrap`
environment were removed.

The failed run must never be rerun. v0.1.2 must not be moved, deleted, or recreated.
`superpowers-manager@0.1.2` must never be published. Recheck the incident
read-only before continuing:

```sh
set -eu
require_npm_absent() {
  package_spec=$1
  if npm_absence_output=$(npm view "$package_spec" --json 2>&1); then
    printf 'unexpected npm package/version exists: %s\n' "$package_spec" >&2
    printf '%s\n' "$npm_absence_output" >&2
    exit 1
  else
    npm_absence_status=$?
  fi
  case "$npm_absence_output" in
    *E404*) ;;
    *)
      printf 'npm absence check failed with status %s:\n%s\n' \
        "$npm_absence_status" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
  case "$npm_absence_output" in
    *"$package_spec"*) ;;
    *)
      printf 'npm E404 did not name exact package/version %s:\n%s\n' \
        "$package_spec" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
}
require_release_absent() {
  release_tag=$1
  if release_absence_output=$(
    gh api "repos/j7an/superpowers-manager/releases/tags/$release_tag" --silent \
      2>&1
  ); then
    printf 'unexpected GitHub release exists: %s\n' "$release_tag" >&2
    exit 1
  else
    release_absence_status=$?
  fi
  case "$release_absence_output" in
    *"HTTP 404"*) ;;
    *)
      printf 'GitHub release absence check failed with status %s:\n%s\n' \
        "$release_absence_status" "$release_absence_output" >&2
      exit 1
      ;;
  esac
}
test "$(git rev-parse v0.1.2)" = \
  "733ddfc0dce4598c65a4945df08f7a0f64d875a4"
gh run view 29501874951 \
  --repo j7an/superpowers-manager \
  --json databaseId,headBranch,headSha,status,conclusion,url
require_npm_absent superpowers-manager@0.1.2
require_release_absent v0.1.2
gh api repos/j7an/superpowers-manager/environments \
  --jq '.environments[].name'
gh secret list --repo j7an/superpowers-manager
```

The npm and GitHub release lookups must report absence. Only the long-lived
`npm` and `release` environments may exist, and no bootstrap secret may exist.
Stop and adjudicate if any observed state differs.

## 2. Review, squash-merge, and freeze the recovery branch

The recovery line is `release/0.1.3-manager`, created from exact public tag
`v0.1.2`. Review the feature branch through a pull request targeting
`release/0.1.3-manager`, never `main`. Repository policy remains squash-only
with linear history.

The complete tracked recovery diff from `v0.1.2` is restricted to an exact
allowlist. Before approval, compare the actual sorted diff to the expected
sorted list programmatically:

```sh
set -eu
boundary_dir=$(mktemp -d)
trap 'rm -rf "$boundary_dir"' EXIT HUP INT TERM
expected_files="$boundary_dir/expected"
actual_files="$boundary_dir/actual"
cat > "$expected_files" <<'EOF'
.github/workflows/release.yml
README.md
RELEASING.md
package.json
scripts/lib.sh
tests/container/codex-offline-probe.sh
tests/test_bootstrap.sh
tests/test_identity_state.sh
tests/test_release_workflow.sh
tests/test_verify_npm_provenance.mjs
EOF
git fetch origin release/0.1.3-manager --tags
git diff --name-status v0.1.2...HEAD
git diff --name-only v0.1.2...HEAD |
  LC_ALL=C sort > "$actual_files"
cmp -s "$expected_files" "$actual_files" || {
  diff -u "$expected_files" "$actual_files"
  exit 1
}
git diff --check v0.1.2...HEAD
git log --oneline --decorate v0.1.2..HEAD
```

The changes may only:

- set the package and versioned guidance to `superpowers-manager@0.1.3`;
- preserve the reviewed `v0.1.2` product behavior and identity;
- keep strict fail-closed Codex identity parsing;
- trigger the recovery workflow only for exact tag `v0.1.3`;
- pin build and publish jobs to exact `npm@11.16.0`; and
- document and test this recovery.

After explicit PR approval, squash-merge into `release/0.1.3-manager`. Then
fetch and freeze the full post-squash remote head SHA:

```sh
set -eu
boundary_dir=$(mktemp -d)
trap 'rm -rf "$boundary_dir"' EXIT HUP INT TERM
expected_files="$boundary_dir/expected"
actual_files="$boundary_dir/actual"
cat > "$expected_files" <<'EOF'
.github/workflows/release.yml
README.md
RELEASING.md
package.json
scripts/lib.sh
tests/container/codex-offline-probe.sh
tests/test_bootstrap.sh
tests/test_identity_state.sh
tests/test_release_workflow.sh
tests/test_verify_npm_provenance.mjs
EOF
git fetch origin release/0.1.3-manager --tags
frozen_sha=$(git rev-parse origin/release/0.1.3-manager)
test "$(git rev-parse "$frozen_sha^")" = "$(git rev-parse v0.1.2)"
git show --stat --oneline "$frozen_sha"
git diff --name-only v0.1.2..."$frozen_sha" |
  LC_ALL=C sort > "$actual_files"
cmp -s "$expected_files" "$actual_files" || {
  diff -u "$expected_files" "$actual_files"
  exit 1
}
```

Record `frozen_sha`. Do not force-push or add another commit after it is frozen.
No tag or package mutation is authorized by the PR approval.

## 3. Complete all pre-tag verification

Use a clean checkout of `"$frozen_sha"`. Confirm the package, workflow source,
and recovery ancestry:

```sh
test "$(node -p 'require("./package.json").name')" = \
  "superpowers-manager"
test "$(node -p 'require("./package.json").version')" = "0.1.3"
test "$(node -p 'require("./package.json").repository.url')" = \
  "git+https://github.com/j7an/superpowers-manager.git"
git merge-base --is-ancestor v0.1.2 "$frozen_sha"
test "$(git rev-parse "$frozen_sha^")" = "$(git rev-parse v0.1.2)"
```

Run the focused contracts and full host suite:

```sh
sh tests/test_bootstrap.sh
sh tests/test_release_workflow.sh
sh tests/test_identity_state.sh
sh tests/test_container_contract.sh
sh tests/run.sh
```

Run blocking isolated acceptance with the real Codex CLI only inside the
throwaway container:

```sh
sh tests/container.sh
```

Install the exact reviewed npm version into an isolated temporary prefix and
cache. Fail fast, put only that temporary npm first on `PATH`, verify its exact
version, run the package dry run, and clean the temporary state on every exit:

```sh
set -eu
npm_root=$(mktemp -d)
npm_prefix="$npm_root/prefix"
npm_cache="$npm_root/cache"
pack_report="$npm_root/pack.json"
mkdir -p "$npm_prefix" "$npm_cache"
cleanup_npm() {
  rm -rf "$npm_root"
}
trap cleanup_npm EXIT HUP INT TERM
NPM_CONFIG_PREFIX="$npm_prefix" \
  NPM_CONFIG_CACHE="$npm_cache" \
  npm install --global --ignore-scripts "npm@11.16.0"
PATH="$npm_prefix/bin:$PATH"
NPM_CONFIG_PREFIX="$npm_prefix"
NPM_CONFIG_CACHE="$npm_cache"
export PATH NPM_CONFIG_PREFIX NPM_CONFIG_CACHE
test "$(command -v npm)" = "$npm_prefix/bin/npm"
test "$(npm --version)" = "11.16.0"
npm pack --dry-run --json > "$pack_report"
sh tests/assert_pack_contents.sh "$pack_report"
git diff --check
git status --short
```

The package report must describe exactly one npm-11 array entry, version
`0.1.3`, filename `superpowers-manager-0.1.3.tgz`, and only the files in
`tests/expected_tarball_contents.txt`. The checkout must remain clean.

`sh tests/test_release_workflow.sh` is the structural authority for
`.github/workflows/release.yml`. It must prove that build and publish each
contain exactly one `npm install --global "npm@11.16.0"` and the exact
`test "$(npm --version)" = "11.16.0"` assertion. Do not execute the workflow
installer again merely to inspect workflow text.

Ranges, npm 12, alternate versions, extra npm installers, parser broadening,
generated plugin content, main-line code, and any file outside the allowlist
are stop conditions.

## 4. Recovery Gate R1: create fresh bootstrap credentials

**STOP — EXTERNAL MUTATION GATE R1**

R1 authorizes only creation and storage of one fresh temporary npm token and
the protected GitHub `npm-bootstrap` environment. It does not authorize a tag,
workflow approval, publication, cleanup, trust change, or deprecation.

Immediately before requesting R1 approval, recheck read-only:

- current official npm policy still permits a short-lived granular token to
  create this unscoped public package with provenance;
- `superpowers-manager` and `superpowers-manager@0.1.3` are absent from npm;
- local and remote `v0.1.3` are absent;
- `npm-bootstrap` and `NPM_BOOTSTRAP_TOKEN` are absent; and
- `origin/release/0.1.3-manager` still equals `"$frozen_sha"`.

Use fail-closed absence checks. npm absence is valid only when npm returns an
E404 that names the exact requested package or version. Remote tag absence is
valid only when `git ls-remote --exit-code` returns status 2:

```sh
set -eu
require_npm_absent() {
  package_spec=$1
  if npm_absence_output=$(npm view "$package_spec" --json 2>&1); then
    printf 'unexpected npm package/version exists: %s\n' "$package_spec" >&2
    printf '%s\n' "$npm_absence_output" >&2
    exit 1
  else
    npm_absence_status=$?
  fi
  case "$npm_absence_output" in
    *E404*) ;;
    *)
      printf 'npm absence check failed with status %s:\n%s\n' \
        "$npm_absence_status" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
  case "$npm_absence_output" in
    *"$package_spec"*) ;;
    *)
      printf 'npm E404 did not name exact package/version %s:\n%s\n' \
        "$package_spec" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
}
require_remote_tag_absent() {
  remote_tag=$1
  if remote_tag_output=$(
    git ls-remote --exit-code origin "refs/tags/$remote_tag" 2>&1
  ); then
    printf 'unexpected remote tag exists: %s\n%s\n' \
      "$remote_tag" "$remote_tag_output" >&2
    exit 1
  else
    remote_tag_status=$?
  fi
  if [ "$remote_tag_status" -ne 2 ]; then
    printf 'remote tag absence check failed with status %s:\n%s\n' \
      "$remote_tag_status" "$remote_tag_output" >&2
    exit 1
  fi
}
require_npm_absent superpowers-manager
require_npm_absent superpowers-manager@0.1.3
test -z "$(git tag --list v0.1.3)"
require_remote_tag_absent v0.1.3
test "$(git rev-parse origin/release/0.1.3-manager)" = "$frozen_sha"
```

Present the token's minimum current package-creation scope, one-day expiry,
2FA-bypass requirement, required environment reviewer, secret name, and cleanup
obligation. Stop if npm policy now requires a different publication path.

After explicit R1 approval only:

1. Create a new one-day granular npm token interactively with the minimum
   package-creation permission npm currently permits. If npm still requires
   `All Packages: read/write` to create an unscoped package, that broader scope
   is allowed only for this one recovery.
2. Create GitHub environment `npm-bootstrap`.
3. Configure the approved required reviewer.
4. Store the token only as environment secret `NPM_BOOTSTRAP_TOKEN`.
5. Never print, echo, or store the token at repository or organization scope.

Create the protected environment and reviewer policy in the GitHub UI, then
enter the token interactively without placing it on the command line:

```sh
gh secret set NPM_BOOTSTRAP_TOKEN \
  --env npm-bootstrap \
  --repo j7an/superpowers-manager
```

Verify presence by name only:

```sh
verification_dir=$(mktemp -d)
trap 'rm -rf "$verification_dir"' EXIT HUP INT TERM
environment_json="$verification_dir/environment.json"
environment_secrets_json="$verification_dir/environment-secrets.json"
repository_secrets_json="$verification_dir/repository-secrets.json"
gh api repos/j7an/superpowers-manager/environments/npm-bootstrap \
  > "$environment_json"
gh api \
  repos/j7an/superpowers-manager/environments/npm-bootstrap/secrets \
  > "$environment_secrets_json"
gh api repos/j7an/superpowers-manager/actions/secrets \
  > "$repository_secrets_json"
python3 - \
  "$environment_json" \
  "$environment_secrets_json" \
  "$repository_secrets_json" <<'PY'
import json
import sys

environment_path, environment_secrets_path, repository_secrets_path = sys.argv[1:]
with open(environment_path, encoding="utf-8") as stream:
    environment = json.load(stream)
with open(environment_secrets_path, encoding="utf-8") as stream:
    environment_secrets = json.load(stream)
with open(repository_secrets_path, encoding="utf-8") as stream:
    repository_secrets = json.load(stream)

approved_reviewer = "j7an"
reviewer_logins = {
    reviewer["reviewer"]["login"]
    for rule in environment.get("protection_rules", [])
    if rule.get("type") == "required_reviewers"
    for reviewer in rule.get("reviewers", [])
    if reviewer.get("type") == "User"
    and isinstance(reviewer.get("reviewer"), dict)
}
assert approved_reviewer == "j7an"
assert "j7an" in reviewer_logins
environment_secret_names = {
    secret["name"] for secret in environment_secrets.get("secrets", [])
}
repository_secret_names = {
    secret["name"] for secret in repository_secrets.get("secrets", [])
}
assert environment_secret_names == {"NPM_BOOTSTRAP_TOKEN"}
assert "NPM_BOOTSTRAP_TOKEN" not in repository_secret_names
PY
```

Stop after verification and request R2 separately.

## 5. Recovery Gate R2: push exact lightweight v0.1.3

**STOP — EXTERNAL MUTATION GATE R2**

R2 authorizes only creation and push of one lightweight `v0.1.3` tag at the
recorded `"$frozen_sha"`. It does not authorize publication approval or any
other mutation.

Recheck:

```sh
set -eu
require_remote_tag_absent() {
  remote_tag=$1
  if remote_tag_output=$(
    git ls-remote --exit-code origin "refs/tags/$remote_tag" 2>&1
  ); then
    printf 'unexpected remote tag exists: %s\n%s\n' \
      "$remote_tag" "$remote_tag_output" >&2
    exit 1
  else
    remote_tag_status=$?
  fi
  if [ "$remote_tag_status" -ne 2 ]; then
    printf 'remote tag absence check failed with status %s:\n%s\n' \
      "$remote_tag_status" "$remote_tag_output" >&2
    exit 1
  fi
}
git fetch origin release/0.1.3-manager --tags
test "$(git rev-parse origin/release/0.1.3-manager)" = "$frozen_sha"
test "$(git rev-parse "$frozen_sha^")" = "$(git rev-parse v0.1.2)"
test -z "$(git tag --list v0.1.3)"
require_remote_tag_absent v0.1.3
git show "$frozen_sha:package.json"
git show "$frozen_sha:.github/workflows/release.yml"
```

The remote lookup must report tag absence. The package must be exactly
`superpowers-manager@0.1.3`; the workflow must trigger only `v0.1.3`.
Repeat the protected-environment boundary check immediately before requesting
R2 so the tag cannot start a workflow whose publish job lacks the approved R3
reviewer gate:

```sh
verification_dir=$(mktemp -d)
trap 'rm -rf "$verification_dir"' EXIT HUP INT TERM
environment_json="$verification_dir/environment.json"
environment_secrets_json="$verification_dir/environment-secrets.json"
repository_secrets_json="$verification_dir/repository-secrets.json"
gh api repos/j7an/superpowers-manager/environments/npm-bootstrap \
  > "$environment_json"
gh api \
  repos/j7an/superpowers-manager/environments/npm-bootstrap/secrets \
  > "$environment_secrets_json"
gh api repos/j7an/superpowers-manager/actions/secrets \
  > "$repository_secrets_json"
python3 - \
  "$environment_json" \
  "$environment_secrets_json" \
  "$repository_secrets_json" <<'PY'
import json
import sys

environment_path, environment_secrets_path, repository_secrets_path = sys.argv[1:]
with open(environment_path, encoding="utf-8") as stream:
    environment = json.load(stream)
with open(environment_secrets_path, encoding="utf-8") as stream:
    environment_secrets = json.load(stream)
with open(repository_secrets_path, encoding="utf-8") as stream:
    repository_secrets = json.load(stream)

approved_reviewer = "j7an"
reviewer_logins = {
    reviewer["reviewer"]["login"]
    for rule in environment.get("protection_rules", [])
    if rule.get("type") == "required_reviewers"
    for reviewer in rule.get("reviewers", [])
    if reviewer.get("type") == "User"
    and isinstance(reviewer.get("reviewer"), dict)
}
assert approved_reviewer == "j7an"
assert "j7an" in reviewer_logins
environment_secret_names = {
    secret["name"] for secret in environment_secrets.get("secrets", [])
}
repository_secret_names = {
    secret["name"] for secret in repository_secrets.get("secrets", [])
}
assert environment_secret_names == {"NPM_BOOTSTRAP_TOKEN"}
assert "NPM_BOOTSTRAP_TOKEN" not in repository_secret_names
PY
```

Present the exact tag, full SHA, immutable-tag consequence, and workflow that
will start. After explicit R2 approval only:

```sh
git tag v0.1.3 "$frozen_sha"
test "$(git cat-file -t v0.1.3)" = "commit"
git show --no-patch --decorate v0.1.3
git push origin refs/tags/v0.1.3
```

Identify the resulting release workflow run and verify its head SHA equals
`"$frozen_sha"`. If the run fails, preserve the tag and run; never move the tag
or dispatch another attempt under the same version.

## 6. Inspect the build and artifact before publication

Monitor only through the build job. It must:

- install exact `npm@11.16.0` and assert the exact version;
- verify the tag, frozen branch SHA, direct `v0.1.2` ancestry, and package
  metadata;
- pass `sh tests/container.sh`;
- run `npm pack --json` exactly once;
- assert exact tarball contents and integrity;
- upload exactly `superpowers-manager-0.1.3.tgz`; and
- leave the publish job waiting at protected environment `npm-bootstrap`.

Inspect the run and logs:

```sh
gh run view RUN_ID \
  --repo j7an/superpowers-manager \
  --json databaseId,headBranch,headSha,status,conclusion,url,jobs
gh run view RUN_ID --repo j7an/superpowers-manager --log
```

If publication starts without the protected-environment wait, stop. Do not
approve the environment.

Download the pre-publication artifact:

```sh
artifact_dir=$(mktemp -d)
gh run download RUN_ID \
  --repo j7an/superpowers-manager \
  --name npm-dist \
  --dir "$artifact_dir"
artifact="$artifact_dir/superpowers-manager-0.1.3.tgz"
test -f "$artifact"
artifact_integrity=$(node - "$artifact" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const artifact = fs.readFileSync(process.argv[2]);
const digest = crypto.createHash('sha512').update(artifact).digest('base64');
process.stdout.write(`sha512-${digest}\n`);
NODE
)
case "$artifact_integrity" in
  sha512-*) ;;
  *) echo "invalid artifact integrity: $artifact_integrity" >&2; exit 1 ;;
esac
printf 'artifact_integrity=%s\n' "$artifact_integrity"
python3 - "$artifact" tests/expected_tarball_contents.txt <<'PY'
# BEGIN PRE_R3_TARBALL_VERIFIER
import json
import sys
import tarfile

artifact_path, expected_path = sys.argv[1:]
with open(expected_path, encoding="utf-8") as stream:
    expected_files = sorted(
        line.strip()
        for line in stream
        if line.strip() and not line.lstrip().startswith("#")
    )

with tarfile.open(artifact_path, "r:gz") as archive:
    regular_members = [member for member in archive.getmembers() if member.isfile()]
    assert all(member.name.startswith("package/") for member in regular_members)
    actual_files = sorted(
        member.name.removeprefix("package/") for member in regular_members
    )
    assert actual_files == expected_files
    package_member = archive.getmember("package/package.json")
    package_stream = archive.extractfile(package_member)
    assert package_stream is not None
    package = json.load(package_stream)

assert package["name"] == "superpowers-manager"
assert package["version"] == "0.1.3"
assert package["repository"]["url"] == "git+https://github.com/j7an/superpowers-manager.git"
# END PRE_R3_TARBALL_VERIFIER
PY
```

Before R3, verify:

- the filename is exactly `superpowers-manager-0.1.3.tgz`;
- embedded name, version, and repository are exact;
- the tar entries equal `tests/expected_tarball_contents.txt`;
- the computed `artifact_integrity` is recorded with the artifact and run
  evidence;
- no generated plugin tree, old bin alias, token, cache, or unrelated file is
  present; and
- npm and the GitHub release still report `0.1.3` absent.

Inspect the artifact, then use fail-closed absence checks for the exact npm
version and GitHub release:

```sh
set -eu
require_npm_absent() {
  package_spec=$1
  if npm_absence_output=$(npm view "$package_spec" --json 2>&1); then
    printf 'unexpected npm package/version exists: %s\n' "$package_spec" >&2
    printf '%s\n' "$npm_absence_output" >&2
    exit 1
  else
    npm_absence_status=$?
  fi
  case "$npm_absence_output" in
    *E404*) ;;
    *)
      printf 'npm absence check failed with status %s:\n%s\n' \
        "$npm_absence_status" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
  case "$npm_absence_output" in
    *"$package_spec"*) ;;
    *)
      printf 'npm E404 did not name exact package/version %s:\n%s\n' \
        "$package_spec" "$npm_absence_output" >&2
      exit 1
      ;;
  esac
}
require_release_absent() {
  release_tag=$1
  if release_absence_output=$(
    gh api "repos/j7an/superpowers-manager/releases/tags/$release_tag" --silent \
      2>&1
  ); then
    printf 'unexpected GitHub release exists: %s\n' "$release_tag" >&2
    exit 1
  else
    release_absence_status=$?
  fi
  case "$release_absence_output" in
    *"HTTP 404"*) ;;
    *)
      printf 'GitHub release absence check failed with status %s:\n%s\n' \
        "$release_absence_status" "$release_absence_output" >&2
      exit 1
      ;;
  esac
}
require_npm_absent superpowers-manager@0.1.3
require_release_absent v0.1.3
```

Any mismatch is a stop condition. Do not rebuild or replace the artifact under
the same tag.

## 7. Recheck the current Codex schema and strict snapshot

This check occurs after the tag build but before R3. Resolve the then-current
stable Codex release from official OpenAI sources. Compare its implementation
with the tested `rust-v0.144.1` baseline, inspecting changed source rather than
accepting blob inequality alone:

```text
codex-rs/cli/src/plugin_cmd.rs
codex-rs/cli/src/marketplace_cmd.rs
codex-rs/plugin/src/plugin_id.rs
```

Confirm normal supported JSON listings still guarantee:

- every `installed[]` entry has a non-empty string `pluginId`; and
- every `marketplaces[]` entry has a non-empty string `name`.

Inspect the exact frozen probe source and prove that the strict snapshot call
and `neither` assertion are present:

```sh
probe_source=$(mktemp)
git show "$frozen_sha:tests/container/codex-offline-probe.sh" > "$probe_source"
grep -Fqx \
  'snapshot=$(spw_codex_identity_snapshot run_codex)' \
  "$probe_source"
grep -Fqx \
  'test "$(spw_snapshot_get "$snapshot" identity_state)" = "neither"' \
  "$probe_source"
```

The tag-build log does not print the snapshot identities or state. It proves
only that the frozen probe, including those fail-fast assertions, completed:

```sh
gh run view RUN_ID --repo j7an/superpowers-manager --log |
  grep -F 'codex offline probe: OK'
```

Together, the frozen source and terminal success line prove the strict
`spw_codex_identity_snapshot run_codex` plus `neither` assertion executed
successfully while the probe plugin and marketplace were installed.

If current normal Codex output can omit or null either identifying field, or if
the real strict-snapshot evidence is absent, stop before publication. Do not
silently skip unidentified entries and do not defer the defect to a published
version. Malformed or corrupt state may continue to fail closed.

Record the current Codex version, primary-source URLs or commit, inspected source
results, tag-build run URL, relevant container log evidence, and decision.

## 8. Recovery Gate R3: approve the protected publication

**STOP — EXTERNAL MUTATION GATE R3**

R3 authorizes only approval of the exact waiting `npm-bootstrap` deployment for
the reviewed workflow run. It does not authorize another run, another package
or version, cleanup, trust changes, deprecation, or a dist-tag change.

Present:

- workflow run ID, URL, and exact `"$frozen_sha"`;
- build success and exact npm version;
- blocking container result;
- current Codex schema and real strict-snapshot result;
- artifact path, exact filename, file list, and the directly computed recorded
  `artifact_integrity`;
- npm and GitHub release absence;
- the exact workflow publication command
  `npm publish "$TARBALL" --access public --provenance`; and
- npm version immutability and the stop-on-mismatch rule.

Do not infer R3 approval from R1 or R2. After explicit R3 approval, approve only
the pending `npm-bootstrap` deployment for the identified run.

Monitor completion. The publish job must install/assert npm `11.16.0`, download
the reviewed artifact, expose `NPM_BOOTSTRAP_TOKEN` only to the publish step,
publish with provenance, poll boundedly for exact integrity, verify a clean
versioned npx invocation, and verify provenance. The GitHub release job must
create or verify `v0.1.3` with the same artifact.

Stop on any mismatch. Never republish an immutable npm version and never replace
a differing release asset.

## 9. Verify registry, provenance, npx, tarballs, release, and container

All checks in this section are read-only with respect to npm and GitHub.

Restore the exact pre-publication SRI recorded for R3, then parse and assert
every required registry field rather than printing it for visual inspection:

```sh
set -eu
artifact_integrity='RECORDED_PREPUBLICATION_SHA512_SRI'
registry_json=$(mktemp)
tmp_cache=$(mktemp -d)
cleanup_post_publish() {
  rm -rf "$registry_json" "$tmp_cache"
}
trap cleanup_post_publish EXIT HUP INT TERM
npm view superpowers-manager@0.1.3 \
  name version repository dist-tags dist.integrity dist.attestations --json \
  > "$registry_json"
python3 - "$registry_json" "$artifact_integrity" <<'PY'
import json
import sys

metadata_path, expected_integrity = sys.argv[1:]
with open(metadata_path, encoding="utf-8") as stream:
    metadata = json.load(stream)

expected_attestations_url = (
    "https://registry.npmjs.org/-/npm/v1/attestations/"
    "superpowers-manager@0.1.3"
)
assert metadata["name"] == "superpowers-manager"
assert metadata["version"] == "0.1.3"
assert metadata["repository"]["url"] == "git+https://github.com/j7an/superpowers-manager.git"
assert metadata["dist-tags"]["latest"] == "0.1.3"
assert metadata["dist.integrity"] == expected_integrity
assert metadata["dist.attestations"]["url"] == expected_attestations_url
assert metadata["dist.attestations"]["provenance"] == {
    "predicateType": "https://slsa.dev/provenance/v1"
}
PY
registry_integrity=$(python3 - "$registry_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    print(json.load(stream)["dist.integrity"])
PY
)
test "$registry_integrity" = "$artifact_integrity"
test "$(NPM_CONFIG_CACHE="$tmp_cache" npx --yes superpowers-manager@0.1.3 --version)" = "0.1.3"
```

Verify provenance:

```sh
registry_integrity=$(npm view superpowers-manager@0.1.3 dist.integrity)
node tests/verify_npm_provenance.mjs \
  superpowers-manager \
  0.1.3 \
  https://github.com/j7an/superpowers-manager \
  refs/tags/v0.1.3 \
  .github/workflows/release.yml \
  "$frozen_sha" \
  "$registry_integrity"
```

The package subject, SHA-512 digest, repository, tag ref, workflow path,
resolved commit, and GitHub-hosted runner builder must all match.

Download the npm tarball and GitHub release asset into the isolated temporary
directories, compare them byte-for-byte, and parse the release JSON to assert
the exact tag, title, sole asset, and SHA-256 digest:

```sh
set -eu
npm_dir=$(mktemp -d)
release_dir=$(mktemp -d)
release_json=$(mktemp)
cleanup_release_verification() {
  rm -rf "$npm_dir" "$release_dir" "$release_json"
}
trap cleanup_release_verification EXIT HUP INT TERM
npm pack superpowers-manager@0.1.3 --pack-destination "$npm_dir"
gh release download v0.1.3 \
  --repo j7an/superpowers-manager \
  --pattern superpowers-manager-0.1.3.tgz \
  --dir "$release_dir"
cmp \
  "$npm_dir/superpowers-manager-0.1.3.tgz" \
  "$release_dir/superpowers-manager-0.1.3.tgz"
gh release view v0.1.3 \
  --repo j7an/superpowers-manager \
  --json tagName,name,assets,url > "$release_json"
release_digest="sha256:$(sha256sum \
  "$release_dir/superpowers-manager-0.1.3.tgz" | cut -d ' ' -f 1)"
python3 - "$release_json" "$release_digest" <<'PY'
import json
import sys

release_path, expected_digest = sys.argv[1:]
with open(release_path, encoding="utf-8") as stream:
    release = json.load(stream)

assert release["tagName"] == "v0.1.3"
assert release["name"] == "Superpowers Manager 0.1.3"
assert len(release["assets"]) == 1
asset = release["assets"][0]
assert asset["name"] == "superpowers-manager-0.1.3.tgz"
assert asset["digest"] == expected_digest
PY
```

Verify the published tarball in the isolated container without registry access:

```sh
npm_tarball="$npm_dir/superpowers-manager-0.1.3.tgz"
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --tmpfs /home/spw:rw,nosuid,size=128m,uid=10001,gid=10001 \
  --mount \
  "type=bind,src=$npm_tarball,dst=/tmp/superpowers-manager.tgz,readonly" \
  --entrypoint sh \
  superpowers-manager-test:local \
  -c 'NPM_CONFIG_CACHE=/tmp/npm-cache npx --yes --offline \
    --package=/tmp/superpowers-manager.tgz \
    superpowers-manager --version'
```

Expected: `0.1.3`.

From exact tagged source, rerun `sh tests/container.sh` and retain evidence for
fresh install, update, probe, uninstall, manager-only, legacy-only, both-ID,
malformed listings, offline failures, and the real strict snapshot. Never
mutate the operator's real Codex home.

Do not proceed to cleanup until every package, provenance, release, artifact,
and container result is approved.

## 10. Recovery Gate R4: revoke and remove bootstrap material

**STOP — EXTERNAL MUTATION GATE R4**

R4 authorizes only revocation of the recovery token and removal of
`NPM_BOOTSTRAP_TOKEN` and `npm-bootstrap` after all publication evidence passes.
It does not authorize permanent trust configuration or deprecation.

Present the completed verification and identify the exact token, environment
secret, and temporary environment. After explicit R4 approval only:

1. Revoke the npm token interactively.
2. Delete environment secret `NPM_BOOTSTRAP_TOKEN`:

   ```sh
   gh secret delete NPM_BOOTSTRAP_TOKEN \
     --env npm-bootstrap \
     --repo j7an/superpowers-manager
   ```

3. Delete temporary environment `npm-bootstrap`:

   ```sh
   gh api --method DELETE \
     repos/j7an/superpowers-manager/environments/npm-bootstrap
   ```

4. Verify fail closed that the temporary environment returns HTTP 404, the
   repository-scope bootstrap secret is absent, and long-lived environments
   `npm` and `release` remain.

```sh
set -eu
require_environment_absent() {
  environment_name=$1
  if environment_absence_output=$(
    gh api \
      "repos/j7an/superpowers-manager/environments/$environment_name" \
      --silent 2>&1
  ); then
    printf 'unexpected GitHub environment exists: %s\n' \
      "$environment_name" >&2
    exit 1
  else
    environment_absence_status=$?
  fi
  case "$environment_absence_output" in
    *"HTTP 404"*) ;;
    *)
      printf 'GitHub environment absence check failed with status %s:\n%s\n' \
        "$environment_absence_status" "$environment_absence_output" >&2
      exit 1
      ;;
  esac
}
require_environment_absent npm-bootstrap
verification_dir=$(mktemp -d)
trap 'rm -rf "$verification_dir"' EXIT HUP INT TERM
environments_json="$verification_dir/environments.json"
repository_secrets_json="$verification_dir/repository-secrets.json"
gh api repos/j7an/superpowers-manager/environments > "$environments_json"
gh api repos/j7an/superpowers-manager/actions/secrets \
  > "$repository_secrets_json"
python3 - "$environments_json" "$repository_secrets_json" <<'PY'
import json
import sys

environments_path, repository_secrets_path = sys.argv[1:]
with open(environments_path, encoding="utf-8") as stream:
    environments = json.load(stream)
with open(repository_secrets_path, encoding="utf-8") as stream:
    repository_secrets = json.load(stream)

environment_names = {
    environment["name"] for environment in environments.get("environments", [])
}
repository_secret_names = {
    secret["name"] for secret in repository_secrets.get("secrets", [])
}
assert {"npm", "release"}.issubset(environment_names)
assert "npm-bootstrap" not in environment_names
assert "NPM_BOOTSTRAP_TOKEN" not in repository_secret_names
PY
```

Never display the token value. If revocation succeeds but later trust setup
fails, do not create or restore token-based publishing.

## 11. Recovery Gate R5: configure permanent trusted publishing

**STOP — EXTERNAL MUTATION GATE R5**

R5 authorizes only permanent trust configuration for `superpowers-manager` and
the package's token-disallow policy. It does not authorize changes to another
package, deprecation, or a release.

Recheck current official npm trusted-publishing documentation immediately
before approval. Stop if the required claims or workflow configuration differ
from:

```text
Package: superpowers-manager
Repository: j7an/superpowers-manager
Workflow: release.yml
Environment: npm
Allowed action: npm publish
```

Present the exact package, repository, workflow, environment, and policy
changes. After explicit R5 approval only, configure the trusted publisher
interactively with 2FA, require 2FA, and disallow token publishing while
retaining OIDC.

Verify the long-lived `npm` GitHub environment and its required reviewers
without printing secrets:

```sh
gh api repos/j7an/superpowers-manager/environments/npm
```

If trust setup fails, leave verified `0.1.3` published, keep the bootstrap token
revoked, and block every later release until trust is repaired interactively.

## 12. Recovery Gate R6: deprecate the exact old package

**STOP — EXTERNAL MUTATION GATE R6**

R6 authorizes only package-wide deprecation metadata for
`superpowers-wrapper`. It does not authorize publishing a bridge, unpublishing,
transferring, deleting, or changing any version.

First verify only historical versions `0.1.0` and `0.1.1` exist, remain
installable, and have no conflicting deprecation:

```sh
npm view superpowers-wrapper versions deprecated --json
npm pack superpowers-wrapper@0.1.0 --pack-destination /tmp
npm pack superpowers-wrapper@0.1.1 --pack-destination /tmp
```

Present this exact message:

```text
DEPRECATED: Renamed to superpowers-manager; this package is frozen. Existing installs: run npx superpowers-wrapper@0.1.1 uninstall, then npx superpowers-manager install.
```

After explicit R6 approval only, deprecate interactively with 2FA:

```sh
npm deprecate 'superpowers-wrapper@*' \
  'DEPRECATED: Renamed to superpowers-manager; this package is frozen. Existing installs: run npx superpowers-wrapper@0.1.1 uninstall, then npx superpowers-manager install.'
```

Verify both versions retain the exact message, remain packable and installable,
a clean install emits the warning, and the npm package page displays it.
Recheck search after npm's normal indexing delay. Search absence is a
verification target, never a reason to unpublish.

## 13. Failure and further-recovery rules

- If the `v0.1.3` build fails before publication, preserve its tag and run,
  revoke and remove temporary credentials under a separately approved cleanup,
  and adjudicate a higher patch version. Never move the failed tag.
- If npm publication succeeds but verification lags, retry only bounded
  read-only checks. Never republish `0.1.3`.
- If the registry artifact differs from the reviewed artifact, stop and
  preserve evidence. npm versions are immutable.
- If current normal Codex listings violate the identifying-field contract, stop
  before publication and design a product fix. Do not silently skip entries.
- If trusted-publisher setup fails, keep verified `0.1.3` published and the
  bootstrap token revoked; block later releases.
- If deprecation fails, leave old versions published and retry only the metadata
  operation after separate approval. Never unpublish.
- Any dist-tag correction, release-asset replacement, higher-version recovery,
  tag-ruleset change, or main-line release requires a separate evidence packet
  and explicit approval. No R1-R6 approval carries forward to that work.
- Never publish another `superpowers-wrapper` version, create a replacement
  old-name repository, weaken branch protection, remove another provider, or
  import the bootstrap path into modular `main`.

At closeout, confirm again that public `v0.1.2` still resolves to
`733ddfc0dce4598c65a4945df08f7a0f64d875a4`, failed run 29501874951 remains the
failed attempt, and no npm version or GitHub release exists for `0.1.2`.
