# Releasing Superpowers Manager

Normal releases start from `.github/workflows/tag-release.yml`. Dispatch it on
`main` with a stable bump choice; it calls the pinned shared Tag Release
workflow to update `package.json`, push the release-bot commit, and create a
lightweight `vX.Y.Z` tag. That tag runs `.github/workflows/release.yml`, which
publishes `superpowers-manager` through npm trusted publishing (OIDC) and creates
the GitHub Release from the same verified tarball.

No npm token belongs in this path. The trusted publisher is exact to repository
`j7an/superpowers-manager`, workflow `release.yml`, environment `npm`, and the
`npm publish` action. Package publishing access requires 2FA and disallows
traditional tokens; OIDC remains allowed.

## Release tag governance

Before any future release, confirm these three active GitHub tag rulesets all
target `v*`:

- `Release tag creation` restricts creation and grants standing bypass only to
  the Release Bot App.
- `Prevent release tag updates` restricts updates and has no bypass actors.
- `Prevent release tag deletion` restricts deletion and has no standing bypass
  actors.

GitHub repository settings are the enforcement source. The broader protected
`v*` namespace reserves release-family tags for the bot, while only `v*.*.*`
triggers npm publication. Do not create a `v*` tag directly. Use the Tag Release
workflow, review its proposed tag and frozen source SHA, and approve its
`release` environment only when both are intended.

Published GitHub Releases are immutable: their associated tags and assets must
not be moved, deleted, or replaced. Existing tags from before tag-ruleset
activation are historical evidence and are never eligible for recovery.

### Break-glass deletion of a never-published mistaken tag

Break glass is an exceptional repository-settings operation, not a standing
workflow or permission. It is allowed only when fresh evidence proves that the
tag was created after ruleset activation, npm never published the version, no
immutable GitHub Release exists, every tag-triggered publication run is stopped,
the tag name, target SHA, triggering run, and relevant repository state are
recorded, and the requested operation is deletion rather than movement or reuse.

After separate approval naming the tag, target SHA, ruleset, and deletion:

1. Keep `Release tag creation` and `Prevent release tag updates` active and
   unchanged.
2. Add a temporary administrator bypass only to
   `Prevent release tag deletion`.
3. Delete exactly the approved tag.
4. Immediately restore the deletion ruleset's empty bypass list.
5. Verify the tag is absent, verify all three rulesets match their normal
   configuration, and confirm npm and GitHub Releases are unchanged and no
   publication completed.
6. Record the deleted tag name as permanently burned in the release-lineage
   section, and correct any version-file state, through a normal reviewed pull
   request before another release attempt. The lineage update is required even
   when no version-file correction is needed.

If deletion protection cannot be restored, freeze releases and keep the
incident open. Never use this procedure for a tag that existed before ruleset
activation, a published release, tag movement, or reuse of a deleted name.

## Release lineage and version computation

`v0.1.2` and `v0.1.3` were failed and unpublished maintenance attempts.
`v0.1.4` was the recovered maintenance publication.
`v0.1.5` failed before publication and must never be moved, reused, rerun, or published.
`v0.1.6` published successfully through OIDC and is immutable. Never move,
delete, recreate, rerun, or republish any published release tag, published
version, or tag that existed before tag-ruleset activation.

The pinned Tag Release workflow selects the highest SemVer tag in the entire
repository, not only tags reachable from `main`. It updates the checked-in
`package.json` version, commits through the release bot, and creates the
lightweight release tag on `main`. Do not invent another release path.

No prerelease path is authorized. Do not create a beta tag, publish with
`--tag next`, or add a prerelease dist-tag through this workflow.
Persistent upstream-version pinning is required before production `0.2.0`.

### Persistent-pinning release gate

Persistent pinning is fulfilled only after every host check and the complete
Layer 4 container acceptance gate have passed on the exact reviewed commit and
that commit has landed on `main`. Host-only success does not satisfy this gate.

After those changes merge, production `0.2.0` remains a separate release
decision. If authorized, dispatch the protected Tag Release workflow on `main`
with a `minor` bump, then use the existing protected `release` and `npm`
environment approvals and trusted-publishing OIDC path. Do not create a
prerelease, publish manually, or introduce an npm token for this decision.

## Normal release

1. Ensure `main` is green (`sh tests/container.sh`) and inspect every commit
   since the latest version tag. Confirm Conventional Commit subjects match
   user-visible intent and that the selected bump is deliberate.
2. Confirm release-bot prerequisites remain present: repository variable
   `RELEASE_BOT_APP_ID`, repository secret `RELEASE_BOT_PRIVATE_KEY`, and the
   protected `release` environment used by the shared Tag Release workflow.
3. Confirm the protected `npm` environment still requires reviewer approval,
   has zero npm secrets, and the trusted-publisher mapping still matches this
   repository, caller workflow, and environment exactly.
4. Dispatch **Tag Release** on `main` with `auto|patch|minor|major` only after
   reviewing the computed stable version and satisfying the persistent
   upstream-version-pinning prerequisite for production `0.2.0`.
5. Approve the `release` environment deployment only after its proposed version
   and frozen source SHA match the intended release.
6. When the tag-triggered **Release** run reaches the `npm` environment, verify
   its tag, frozen source SHA, package name and version, and tarball digest
   before approving publication.
7. Verify the completed npm package, SLSA provenance, GitHub tag, GitHub Release,
   release asset digest, and clean `npx` execution against the same source SHA.

Do not combine environment approvals with trust changes, package deprecation,
tag recovery, or any other registry mutation.

## Publish and propagation behavior

The pinned reusable publisher:

1. checks out and validates the release tag;
2. runs the CI caller command that installs the frozen root dependencies,
   checks native TypeScript, and runs `sh tests/container.sh`;
3. invokes `node tests/tools/pack.ts --out-dir .` once, compiling production
   source in external temporary staging and validating the real package allowlist;
4. continues the existing OIDC publish, registry verification, `npx`
   verification, and GitHub Release flow.

Registry metadata and the `npx` installation path can become visible at
different times. The caller therefore retries `npx` six times with delays of
0, 30, 60, 90, 120, and 150 seconds. Every attempt uses a fresh npm cache so a
transient negative lookup cannot poison later attempts. A successful command
that prints the wrong version fails immediately; only lookup/execution failures
are retried.

If npm publication succeeds but either verification path lags, retry only
read-only checks within the bounded workflow. Never rerun publication, move the
tag, or attempt to overwrite the immutable npm version.

## Required verification

Run locally while iterating:

```sh
pnpm install --frozen-lockfile
pnpm run check:static
sh tests/run.sh
SPW_NATIVE_NODE_VERSION=24.12.0 sh tests/container.sh
SPW_NATIVE_NODE_VERSION=24 sh tests/container.sh
node tests/tools/pack.ts --out-dir /absolute/existing/temporary/output
node --import ./tests/assert-matcher-gate.ts --test tests/bin/npm-pack-contents.test.ts tests/baseline/packaged-cli.test.ts
git diff --check
```

Use Homebrew-managed pnpm by command name locally, without Corepack.
Native source, tests, and packaging tooling require Node >=24.12.0; the installed
package retains Node >=24. Static checking emits nothing into the checkout.
Allocate the packaging command's existing output directory outside the checkout
for developer verification. The command emits npm-compatible PackReport JSON,
validates the actual tarball, and cleans its own external staging.

The dependency-free source `prepack` guard rejects bare checkout `npm pack`
unconditionally, including absent or stale `dist/`, with explicit-command
guidance. The staged package omits only that source guard. The protected
publisher uses the same command with `--out-dir .`: its sealed tarball may briefly
reside in the checkout before the publisher moves it to its artifact directory.
Loose generated JavaScript remains external. This does not create an alternate
release or approval path.

Run the two container endpoints sequentially. `SPW_NATIVE_NODE_VERSION` accepts
only `24.12.0` and `24`, defaulting to `24`. Both run the native TypeScript suite
and the real Codex CLI in an isolated offline home. Each image copies and
smoke-tests Node 24.0.0, declares it through `SPW_PACKAGE_NODE` and
`SPW_PACKAGE_NODE_VERSION`, then runs the installed package's emitted JavaScript
with both that binary and the native harness binary. The minimum binary never
runs TypeScript or installs dependencies during offline acceptance.

PR CI runs focused native compatibility at Node 24.12.0 and one full container
at latest Node 24. Static no-emit checking, tooling coverage, and historical
citations run only on the latest-24 checkout entry. Release acceptance retains
static checking and both offline container endpoints before the shared
publisher's `pack-command` produces the tarball.
The package assertion must expose only the manager executable and approved
source allowlist.

### Pre-publication approval

Verify the frozen tag and source SHA, package name and version, tarball digest,
and zero npm secrets before approving publication.

### Post-publication verification

Verify npm provenance and clean-cache `npx` execution against the same
published version and source SHA after publication. Provenance must name
`j7an/superpowers-manager` and caller `release.yml`, and clean-cache `npx`
execution must print the published stable version exactly.

## Failure recovery

- Preserve every public tag and workflow run as immutable evidence, except for
  a never-published mistaken tag deleted under the break-glass procedure above.
- If a build fails before publication, fix through a reviewed higher version;
  never reuse or move the failed tag.
- Never run or rerun a release workflow for `v0.1.5`, and never publish `superpowers-manager@0.1.5` by any path.
- If publication succeeds and post-publish verification fails, do not
  republish. Verify registry integrity and provenance read-only, then adjudicate
  release-only recovery separately.
- If trusted publishing fails, stop. Do not create or restore an npm token as a
  workaround.
- Any dist-tag correction, release-only recovery, or credential/trust change
  requires its own explicit mutation gate.

Deprecating the historical `superpowers-wrapper` package is a separate
interactive npm metadata operation. Keep both old versions published; never
unpublish, transfer, bridge, or release another old-name version.
