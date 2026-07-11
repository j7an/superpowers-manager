# Releasing superpowers-wrapper

Normal releases start from `.github/workflows/tag-release.yml`: dispatch it on
`main` with a bump choice, and it calls the shared `tag-release.yml` workflow
to bump `package.json`, push the release-bot commit, and create a `vX.Y.Z`
tag. That tag runs `.github/workflows/release.yml`, which calls the reusable
`publish-npm.yml` in `j7an/shared-workflows` and publishes to npm via trusted
publishing (OIDC). No npm token exists anywhere in this flow after the
one-time bootstrap below.

## Normal release

1. Ensure `main` is green (`sh tests/run.sh`) and review every commit since
   the last tag for a Conventional Commits prefix matching its user-visible
   intent. This repo's feature-commit hygiene keeps `bump=auto` inference
   reliable; it is not a claim that the reusable workflow enforces every
   prefix universally.
2. Confirm release-bot prerequisites are present: repo variable
   `RELEASE_BOT_APP_ID`, repo secret `RELEASE_BOT_PRIVATE_KEY`, and the
   `release` environment gate used by the shared tag-release workflow.
3. Dispatch **Tag Release** on `main` with `bump=auto|patch|minor|major`.
   The workflow bumps `package.json.version` via `.version-bump.json` and
   creates a lightweight `vX.Y.Z` tag pointing at the verified release-bot
   bump commit.
4. The publish workflow gates (tag is ancestor of main; tag tail ==
   package.json version), runs the test suite, packs once, asserts tarball
   contents, publishes the verified tarball, polls the registry, runs an
   `npx superpowers-wrapper@X.Y.Z --version` install check, and creates the
   GitHub release with the verified `*.tgz` tarball attached.

## Manual gates before the FIRST publish (release blockers, not optional)

1. **Codex root-migration probe.** With a real Codex install: register the
   marketplace from package root A (`install`), then copy the package to a
   different path B and run `install` from B. Confirm: the marketplace
   pointer moves to B (`codex plugin marketplace list --json`), the plugin
   refreshes, and skills still load in a new Codex session. This clears the
   open risk carried from the design spec.
2. **End-to-end tarball run.** Simulate the npx path without publishing:

   ```sh
   npm pack
   mkdir -p /tmp/spw-e2e && tar -xzf superpowers-wrapper-*.tgz -C /tmp/spw-e2e
   node /tmp/spw-e2e/package/bin/superpowers-wrapper.js update
   node /tmp/spw-e2e/package/bin/superpowers-wrapper.js probe
   codex plugin list --json   # wrapper plugin present and current
   ```

## First-publish bootstrap (one time)

npm trusted-publisher configuration lives in an existing package's settings
(verified 2026-07-11; re-check https://docs.npmjs.com/trusted-publishers before
publishing in case npm adds a pending-publisher flow). Therefore, claim the
unscoped package with the intended first version before creating the first
release tag. Do **not** dispatch **Tag Release** until the manual publish and
trusted-publisher configuration below are complete.

1. Create a temporary clean checkout of merged `main`. In that checkout only,
   stage the version that `bump=minor` will create, without committing or
   tagging it:

   ```sh
   repo_root=$(git rev-parse --show-toplevel)
   git -C "$repo_root" fetch --tags origin \
     'refs/heads/main:refs/remotes/origin/main'
   test -z "$(git -C "$repo_root" tag --list 'v*')"
   bootstrap_commit=$(git -C "$repo_root" rev-parse origin/main)
   bootstrap_root=$(mktemp -d)
   git -C "$repo_root" worktree add --detach \
     "$bootstrap_root/repo" "$bootstrap_commit"
   cd "$bootstrap_root/repo"
   test "$(node -p 'require("./package.json").version')" = "0.0.0"
   npm version 0.1.0 --no-git-tag-version --allow-same-version
   test "$(node -p 'require("./package.json").version')" = "0.1.0"
   test "$(git diff --name-only)" = "package.json"
   ```

   `.version-bump.json` changes only `package.json`, so this produces the same
   package contents as the later release-bot bump commit. Committed `main`
   remains at `0.0.0` throughout this manual bootstrap. Treat
   `$bootstrap_commit` as a freeze point: do not merge to `main` until the
   initial `Tag Release` run succeeds.
2. Test, pack, assert the exact tarball contents, and publish the staged
   `0.1.0` artifact with the 2FA-protected npm account:

   ```sh
   sh tests/run.sh
   npm pack --json > pack.json
   sh tests/assert_pack_contents.sh pack.json
   test "$(node -p 'require("./pack.json")[0].filename')" = \
     "superpowers-wrapper-0.1.0.tgz"
   npm publish superpowers-wrapper-0.1.0.tgz --access public
   ```

3. Verify the initial registry package before configuring automation:

   ```sh
   test "$(npm view superpowers-wrapper@0.1.0 version)" = "0.1.0"
   test "$(npx --yes superpowers-wrapper@0.1.0 --version)" = "0.1.0"
   ```

   Registry propagation can lag behind a successful publish. If either check
   fails immediately afterward, retry both checks for up to 10 minutes before
   treating the publish as failed; the reusable workflow similarly retries
   registry visibility for about 7.5 minutes.

4. In the package's npmjs.com settings, configure the trusted publisher:
   - Repository: `j7an/superpowers-wrapper`
   - Workflow filename: `release.yml` (the CALLER workflow in this repo —
     validation checks the calling workflow, not the reusable one)
   - Environment: `npm` (matches the reusable workflow's publish job)
   - **Allowed actions: `npm publish` only** (not `npm stage publish`).
     Required for configurations created after May 20, 2026; this flow does
     no staged publishing.
5. Discard only the scoped temporary checkout, then confirm remote `main` is
   still the frozen commit and no release tag has appeared:

   ```sh
   cd "$repo_root"
   git worktree remove --force "$bootstrap_root/repo"
   rmdir "$bootstrap_root"
   git fetch --tags origin 'refs/heads/main:refs/remotes/origin/main'
   test "$(git rev-parse origin/main)" = "$bootstrap_commit"
   test -z "$(git tag --list 'v*')"
   ```
   If either freeze check fails, stop and adjudicate the immutable published
   artifact against the changed repository state; do not dispatch a release.
6. Dispatch **Tag Release** on `main` with `bump=minor`. The explicit bump
   guarantees the tag version matches the already-published artifact. It
   creates the signed
   release-bot `0.1.0` bump commit and lightweight `v0.1.0` tag. Approve the
   `release` and `npm` environment gates when prompted.
7. Confirm the tag-triggered **Release** workflow succeeds. The pinned v4.2.2
   reusable workflow sees that `superpowers-wrapper@0.1.0` already exists,
   skips duplicate publication, performs registry and npx verification, and
   creates the GitHub Release with its verified tarball attached.
8. Revoke any temporary granular npm token after the OIDC workflow succeeds.
   All subsequent releases go
   through Tag Release followed by the tag-triggered OIDC publish flow only.
