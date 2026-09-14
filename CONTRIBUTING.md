# Contributing

- [Repository rules and source boundaries](AGENTS.md)
- [Development, tests, and package-runtime setup](AGENTS.md#testing)
- [Protected releases and packaging verification](RELEASING.md#required-verification)
- [Harness directory convention](docs/harness-interface.md#directory-convention)
- [Adapter result contract](docs/adapter-result-contract.md)

Run the checkout CLI with `node src/cli.ts`. Run published-package `npx superpowers-manager ...` commands outside this checkout, where npm cannot select the local package. Use Homebrew-managed pnpm locally, without Corepack.

`pnpm run check:static` includes Knip. Keep `knip.json` entries aligned with tooling and subprocess callers that imports cannot reveal; shared helpers remain reachable through imports. The `mkfifo` allowance covers existing tests.

## pnpm maintenance

The weekly Monday 06:00 UTC updater, also available by manual dispatch, opens or refreshes a dedicated pull request changing only the `packageManager` pin. It selects a non-deprecated stable pnpm release within the pinned major after five days; a deprecated current pin bypasses that wait. Major upgrades remain manual, and the workflow does not update the lockfile.

The reusable caller forwards only `RELEASE_BOT_PRIVATE_KEY` and uses `vars.RELEASE_BOT_APP_ID` for App-authored pull requests that can trigger CI. Keep both configured, manually verify App authentication after adopting the caller, and inspect its pull request before treating live integration as validated.
