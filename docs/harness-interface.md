# Internal harness interface

Codex is the only supported production integration. The interface is internal
TypeScript, not a public plugin protocol or a promise of other harness support.

Implement HarnessAdapter<R> for a future integration and supply it at the CLI
composition point. Shared commands must not import that concrete implementation.
R belongs to the adapter: ownership inspection returns it and removal consumes
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

See the [internal interface](../src/harness.ts), the concrete
[Codex adapter](../src/codex-harness.ts), and the
[boundary acceptance tests](../tests/unit/harness-boundary.test.ts).
