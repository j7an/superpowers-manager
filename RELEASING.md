# Releasing Superpowers Manager 0.1.2

This is the authoritative, one-time migration procedure for
`superpowers-manager@0.1.2`. Every GitHub or npm mutation below has its own
explicit approval gate. Stop at each gate; do not treat approval for one step as
approval for another.

The migration workflow runs only for the exact `v0.1.2` tag on the frozen
`release/0.1.2-manager` branch. It must never be reused for a later version,
prerelease, or dist-tag correction. Modular `main` replaces it with the normal
shared OIDC publisher before `0.2.0` or any other main-line release.

## 1. Review, merge, and freeze the maintenance branch

Review the maintenance PR into `release/0.1.2-manager`, not `main`. Confirm its
scope contains only the identity migration, legacy-state safety, documentation,
acceptance tests, and this release path. Merge only after the PR review gate is
explicitly approved. Then record one immutable SHA:

```sh
git fetch origin release/0.1.2-manager --tags
frozen_sha=$(git rev-parse origin/release/0.1.2-manager)
git status --short
git show --stat --oneline "$frozen_sha"
git show "$frozen_sha:package.json"
```

Do not merge or force-push another commit to the branch after freezing it.

## 2. Verify the maintenance branch and published 0.1.1 baseline

Prove the frozen branch descends from the stable line and is not the unfinished
modular tree:

```sh
git merge-base --is-ancestor v0.1.1 "$frozen_sha"
git diff --stat v0.1.1..."$frozen_sha"
git diff --name-status v0.1.1..."$frozen_sha"
git diff --check v0.1.1..."$frozen_sha"
npm view superpowers-wrapper@0.1.1 name version repository dist.integrity --json
```

From a clean checkout of the frozen SHA, run the acceptance and package checks:

```sh
sh tests/run.sh
sh tests/container.sh
npm pack --dry-run --json
git diff --check
git status --short
```

The container suite is blocking before tagging. The package must be exactly
`superpowers-manager@0.1.2`, contain only the asserted source files, and retain
`v0.1.1` behavior except for reviewed migration changes.

## 3. Rename GitHub after the explicit rename gate

First recheck the volatile namespace, policy, and repository assumptions without
changing them:

```sh
npm view superpowers-manager --json
gh api repos/j7an/superpowers-manager
gh repo view j7an/superpowers-wrapper --json nameWithOwner,url,defaultBranchRef
gh api repos/j7an/superpowers-wrapper/rulesets
npm profile get tfa
```

The new npm package and GitHub repository must still be absent, and the old
repository and package must remain intact. If reality differs, stop and
adjudicate; do not improvise. After explicit rename approval only:

```sh
gh repo rename superpowers-manager --repo j7an/superpowers-wrapper --yes
old_origin=$(git remote get-url origin)
case "$old_origin" in
  git@github.com:j7an/superpowers-wrapper.git)
    new_origin=git@github.com:j7an/superpowers-manager.git
    ;;
  https://github.com/j7an/superpowers-wrapper.git)
    new_origin=https://github.com/j7an/superpowers-manager.git
    ;;
  *)
    echo "unexpected origin URL: $old_origin" >&2
    exit 1
    ;;
esac
git remote set-url origin "$new_origin"
git fetch origin --tags
```

Do not create a replacement repository at the old name.

Verify the renamed repository before continuing:

```sh
git remote -v
git fetch origin --tags
gh repo view j7an/superpowers-manager --json nameWithOwner,url,defaultBranchRef,description,homepageUrl,repositoryTopics
gh api repos/j7an/superpowers-manager/branches
gh api repos/j7an/superpowers-manager/tags
gh api repos/j7an/superpowers-manager/releases
gh api repos/j7an/superpowers-manager/actions/workflows
gh api repos/j7an/superpowers-manager/environments
gh api repos/j7an/superpowers-manager/rulesets
```

Branches, tags, releases, Actions, environments, and rulesets must all survive.
Set the approved description, README homepage, topics, and social preview only
under this same explicit metadata gate.

## 4. Create and store the one-day bootstrap token after its gate

Immediately before execution, recheck npm policy. After explicit credential
approval only, create a one-day granular token that bypasses 2FA with the minimum
package-creation permission npm currently allows. Because the unscoped package
does not exist, `All Packages: read/write` is acceptable only if npm still
requires it for this approved bootstrap.

Create the protected `npm-bootstrap` GitHub environment with a required reviewer
and store the token only as its `NPM_BOOTSTRAP_TOKEN` environment secret. Never
store it at repository or organization scope and never print its value. Verify
presence by name only:

```sh
gh api repos/j7an/superpowers-manager/environments/npm-bootstrap
gh api repos/j7an/superpowers-manager/environments/npm-bootstrap/secrets --jq '.secrets[].name'
```

## 5. Push v0.1.2 after the explicit tag gate

Recheck the frozen branch and both local and remote tag absence:

```sh
git fetch origin release/0.1.2-manager --tags
test "$(git rev-parse origin/release/0.1.2-manager)" = "$frozen_sha"
test -z "$(git tag --list v0.1.2)"
git ls-remote --exit-code origin refs/tags/v0.1.2
```

The last command must report that the remote tag does not exist. After explicit
tag approval only, create and push the lightweight tag:

```sh
git tag v0.1.2 "$frozen_sha"
git show --no-patch --decorate v0.1.2
git push origin refs/tags/v0.1.2
```

The workflow must complete its build job and then wait at the protected
`npm-bootstrap` environment. A tag at any other SHA is a stop condition.

## 6. Approve npm-bootstrap after the first-publication gate

Before approval, inspect the workflow run and confirm the exact tag/branch SHA,
successful `sh tests/container.sh`, package metadata, tarball filename, and npm
integrity:

```sh
gh run list --workflow release.yml --branch v0.1.2
gh run view RUN_ID --log
```

After explicit first-publication approval only, approve `npm-bootstrap`. The
publish step alone receives `NPM_BOOTSTRAP_TOKEN`; it publishes the already-built
tarball with `--access public --provenance`. If the exact version already exists,
the workflow verifies identical integrity and never republishes it.

## 7. Verify registry, provenance, npx, and the GitHub release

Do not change trust or the old package until all read-only verification passes:

```sh
npm view superpowers-manager@0.1.2 name version repository dist-tags dist.integrity dist.attestations --json
NPM_CONFIG_CACHE=$(mktemp -d)
export NPM_CONFIG_CACHE
npx --yes superpowers-manager@0.1.2 --version
gh release view v0.1.2 --repo j7an/superpowers-manager --json tagName,targetCommitish,assets,url
```

Run `tests/verify_npm_provenance.mjs` with the frozen SHA and observed integrity.
It must verify the exact package subject, SHA-512 digest, repository, tag ref,
workflow path, resolved Git commit, and GitHub-hosted runner builder. Download
the npm and GitHub release tarballs into separate temporary directories and
compare them byte-for-byte. Run the isolated real-Codex container against the
published tarball and verify fresh install, update, probe, uninstall, legacy-only,
manager-only, both-ID, malformed-listing, and offline failure cases.

```sh
integrity=$(npm view superpowers-manager@0.1.2 dist.integrity)
node tests/verify_npm_provenance.mjs \
  superpowers-manager \
  0.1.2 \
  https://github.com/j7an/superpowers-manager \
  refs/tags/v0.1.2 \
  .github/workflows/release.yml \
  "$frozen_sha" \
  "$integrity"
```

The expected registry state is `latest -> 0.1.2`; this step only observes it.
Any dist-tag correction or recovery publication is a separate mutation gate.

## 8. Revoke and remove token material after its gate

After all Step 7 evidence is approved, explicitly authorize credential cleanup.
Revoke the one-day npm token, delete `NPM_BOOTSTRAP_TOKEN`, and remove the
temporary `npm-bootstrap` environment only after confirming no workflow still
needs it. Verify secret presence or absence by name only; never expose values.

If revocation succeeds but later trust setup fails, do not restore token-based
publishing.

## 9. Configure trusted publishing and disallow tokens after its gate

After explicit trust-cutover approval, configure npm interactively with 2FA:

```text
Package: superpowers-manager
Repository: j7an/superpowers-manager
Workflow: release.yml
Environment: npm
Allowed action: npm publish
```

Require 2FA and disallow token publishing while retaining OIDC. Verify the normal
`npm` GitHub environment and its required reviewers without printing secrets:

```sh
gh api repos/j7an/superpowers-manager/environments/npm
```

If trusted-publisher setup fails, leave verified `0.1.2` published, keep the
bootstrap token revoked, block every later release, and resolve trust
interactively without restoring token publication.

## 10. Deprecate superpowers-wrapper after its gate; never unpublish

After explicit deprecation approval only, deprecate all existing versions with
this exact message, interactively with 2FA:

```sh
npm deprecate 'superpowers-wrapper@*' 'DEPRECATED: Renamed to superpowers-manager; this package is frozen. Existing installs: run npx superpowers-wrapper@0.1.1 uninstall, then npx superpowers-manager install.'
```

Never publish an old-name `0.1.2`, unpublish, transfer, or delete an old version.
Verify both versions remain reproducible and the exact notice is visible:

```sh
npm view superpowers-wrapper@0.1.0 deprecated version
npm view superpowers-wrapper@0.1.1 deprecated version
npm pack superpowers-wrapper@0.1.0 --pack-destination /tmp
npm pack superpowers-wrapper@0.1.1 --pack-destination /tmp
```

Use clean temporary npm caches to confirm both versions remain installable and
emit the exact notice. Recheck npm search after its indexing window; absence
from search is a verification target, never a reason to unpublish.

Record the final state with these read-only checks:

```sh
npm view superpowers-manager@0.1.2 --json
npm view superpowers-wrapper versions deprecated --json
gh repo view j7an/superpowers-manager --json nameWithOwner,url,description,homepageUrl,repositoryTopics
gh api repos/j7an/superpowers-manager/environments
```

## Failure and recovery rules

- If the rename succeeds but npm publication does not, keep the repository
  renamed and fix the reviewed release path without recreating or reverting
  namespace identities.
- If npm reports success but verification lags, retry only read-only registry
  checks within the bounded window; never republish the same version.
- If the published tarball differs from the reviewed artifact, stop, preserve
  evidence, and adjudicate a new version; npm versions and release evidence are
  never overwritten.
- If trusted-publisher setup fails, keep `0.1.2`, keep the token revoked, and
  block later releases until trust is repaired interactively.
- If deprecation fails, leave old versions published and retry the interactive
  metadata operation; never substitute unpublishing.
- If legacy Codex state exists, manager install/update performs no mutation and
  prints the old uninstall/new install sequence.
- Never remove or disable another provider automatically.
- No correction is expected for `latest`. Any dist-tag change, recovery
  publication, changed tarball, or release-asset replacement requires a new
  explicit gate with the observed state, exact command, and blast radius.
