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

## Release lineage and version computation

`v0.1.2` and `v0.1.3` are immutable failed maintenance attempts and were never
published. `superpowers-manager@0.1.4` and its GitHub Release were recovered
from the immutable out-of-main maintenance tag `v0.1.4`. Never move, delete,
recreate, rerun, or republish any of those versions.

The pinned Tag Release workflow selects the highest semver tag in the entire
repository, not only tags reachable from `main`. With `v0.1.4` as the current
base:

- patch produces `0.1.5`;
- minor produces `0.2.0`;
- major produces `1.0.0`.

The intended first modular-main release uses `bump=minor`. Commit analysis uses
`v0.1.4..HEAD` even though the maintenance and main histories diverged. The new
version-bump commit and release tag are created on `main`, so the tag passes the
shared publisher's main-ancestry gate.

The checked-in `package.json` version is synchronized to the immutable published
`0.1.4` baseline. Tag Release writes the approved next version. Do not invent
another release path.

No prerelease path is authorized. Do not create a beta tag, publish with
`--tag next`, or add a prerelease dist-tag through this workflow. Persistent
track-latest, pin, and unpin behavior requires its own approved design before
the production modular release.

## Normal release

1. Ensure `main` is green (`sh tests/container.sh`) and inspect every commit
   since `v0.1.4`. Confirm Conventional Commit subjects match user-visible
   intent and that the selected bump is deliberate.
2. Confirm release-bot prerequisites remain present: repository variable
   `RELEASE_BOT_APP_ID`, repository secret `RELEASE_BOT_PRIVATE_KEY`, and the
   protected `release` environment used by the shared Tag Release workflow.
3. Confirm the protected `npm` environment still requires reviewer approval,
   has zero npm secrets, and the trusted-publisher mapping still matches this
   repository, caller workflow, and environment exactly.
4. Dispatch **Tag Release** on `main` with `bump=minor` for the first modular
   release. Later releases may use `auto|patch|minor|major` only after reviewing
   the computed version.
5. Approve the `release` environment deployment only after its proposed version
   and frozen source SHA match the intended release.
6. When the tag-triggered **Release** run reaches the `npm` environment, verify
   its tag and build evidence before approving publication.
7. Verify the completed npm package, SLSA provenance, GitHub tag, GitHub Release,
   release asset digest, and clean `npx` execution against the same source SHA.

Do not combine environment approvals with trust changes, package deprecation,
tag recovery, or any other registry mutation.

## Publish and propagation behavior

The pinned reusable publisher:

1. requires the tag to be an ancestor of `origin/main`;
2. requires the tag version to equal `package.json.version`;
3. runs `sh tests/container.sh`;
4. packs once and checks `tests/assert_pack_contents.sh`;
5. publishes that tarball through OIDC;
6. polls `npm view` for bounded registry visibility;
7. runs the caller's bounded `npx` verification; and
8. creates the GitHub Release with the verified tarball.

Registry metadata and the `npx` installation path can become visible at
different times. The caller therefore retries `npx` six times with delays of
0, 30, 60, 90, 120, and 150 seconds. Every attempt uses a fresh npm cache so a
transient negative lookup cannot poison later attempts. A successful command
that prints the wrong version fails immediately; only lookup/execution failures
are retried.

If npm publication succeeds but either verification path lags, retry only
read-only checks within the bounded workflow. Never rerun publication, move the
tag, or attempt to overwrite the immutable npm version.

## Required verification before approval

Run locally while iterating:

```sh
sh tests/run.sh
sh tests/container.sh
npm pack --dry-run --json
sh tests/test_npm_pack_contents.sh
git diff --check
```

The container suite is authoritative for Node 24 TypeScript checks and the real
Codex CLI in an isolated offline home. The package assertion must expose only
the manager executable and approved source allowlist.

For the first modular release, also verify that:

- npm provenance names `j7an/superpowers-manager` and caller `release.yml`;
- the OIDC publish succeeds with zero GitHub npm secrets;
- `npx --yes superpowers-manager@X.Y.Z --version` prints exactly `X.Y.Z` from a
  clean cache; and
- `superpowers-wrapper@0.1.0` and `0.1.1` remain published and untouched.

## Failure recovery

- Preserve every public tag and workflow run as immutable evidence.
- If a build fails before publication, fix through a reviewed higher version;
  never reuse or move the failed tag.
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
