# Releasing superpowers-wrapper

Normal releases start from `.github/workflows/tag-release.yml`: dispatch it on
`main` with a bump choice, and it calls the shared `tag-release.yml` workflow
to bump `package.json`, push the release-bot commit, and create a `vX.Y.Z`
tag. That tag runs `.github/workflows/release.yml`, which calls the reusable
`publish-npm.yml` in `j7an/shared-workflows` and publishes to npm via trusted
publishing (OIDC). No npm token exists anywhere in this flow after the
one-time bootstrap below.

## Normal release

1. Ensure `main` is green (`sh tests/run.sh`) and every commit since the last
   tag has a Conventional Commits prefix matching its user-visible intent.
2. Confirm release-bot prerequisites are present: repo variable
   `RELEASE_BOT_APP_ID`, repo secret `RELEASE_BOT_PRIVATE_KEY`, and the
   `release` environment gate used by the shared tag-release workflow.
3. Dispatch **Tag Release** on `main` with `bump=auto|patch|minor|major`.
   The workflow bumps `package.json.version` via `.version-bump.json` and
   creates the signed `vX.Y.Z` tag.
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

npm documents no pending-publisher flow for unclaimed names (verified
2026-07-01; re-check https://docs.npmjs.com/trusted-publishers in case one
was added). Therefore:

1. Use **Tag Release** to create the initial release-bot bump commit and
   `vX.Y.Z` tag. The tag-triggered publish run may fail or be cancelled before
   npm trusted publishing is configured; that is expected for the first
   publish only.
2. From the release tag, pack and verify locally
   (`npm pack --json > pack.json && sh tests/assert_pack_contents.sh pack.json`),
   then publish manually with the 2FA-protected npm account:
   `npm publish superpowers-wrapper-X.Y.Z.tgz --access public`.
3. In the package's npmjs.com settings, configure the trusted publisher:
   - Repository: `j7an/superpowers-wrapper`
   - Workflow filename: `release.yml` (the CALLER workflow in this repo —
     validation checks the calling workflow, not the reusable one)
   - Environment: `npm` (matches the reusable workflow's publish job)
   - **Allowed actions: `npm publish` only** (not `npm stage publish`).
     Required for configurations created after May 20, 2026; this flow does
     no staged publishing.
4. Re-run the original tag-triggered **Release** workflow after configuring
   the trusted publisher. The pinned v4.2.2 reusable workflow sees that
   `superpowers-wrapper@X.Y.Z` already exists, skips the duplicate publish,
   performs registry and npx verification, and creates or updates the GitHub
   Release with the verified tarball attached.
5. Revoke any granular npm token afterward. All subsequent releases go
   through Tag Release followed by the tag-triggered OIDC publish flow only.
