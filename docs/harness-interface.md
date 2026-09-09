# Internal harness interface

Codex and Pi are supported production integrations behind the same internal
TypeScript interface. It is not a public plugin protocol or a promise of support
for additional harnesses.

The [CLI composition point](../src/cli.ts) selects one concrete adapter per
invocation using `--harness codex` or `--harness pi`; omission defaults to Codex.
Upstream selection is shared, while preparation and activation target the chosen
harness independently.

- The [Codex adapter](../src/harnesses/codex/harness.ts) manages a generated Codex plugin
  and its marketplace/plugin registration.
- The [Pi adapter](../src/harnesses/pi/harness.ts) manages a Pi package and its registration,
  with a durable Manager-owned installed snapshot separate from prepared output.

Implement `HarnessAdapter<R>` for an additional integration and supply it at
the CLI composition point. Shared commands must not import concrete adapters.
`R` belongs to the adapter: ownership inspection returns it and removal consumes
it unchanged within the same invocation. It is not persisted authorization.

Preparation receives resolved upstream identity and invocation-owned staging.
Validate native artifacts before returning success. Shared orchestration runs
configured validation, replaces the candidate, and owns staging cleanup.

Inspect real state without mutation. Distinguish absence, mismatch, and failure.
Ownership/control decisions must be current before mutation; success requires
post-mutation inspection. Keep native identity/resource interpretation inside
the adapter and preserve controlled diagnostics.

Use typed outcomes, existing diagnostic helpers, and hermetic tests. Native
output and filesystem contents still require validation. Do not place raw
validator streams through AdapterMessageLog.

See the [internal interface](../src/harness.ts) and the
[boundary acceptance tests](../tests/unit/harness-boundary.test.ts).
