# In-Process Adapter Result Contract

## Scope

This document defines the in-process adapter result contract used by the
product CLI. `src/cli.ts` binds `runAdapter` directly into the lifecycle
context, and handlers consume its `AdapterResult` in-process. There is no
adapter-process exit or independent operation/response validation on this
path.

## Messages and errors

Each message object has exactly `channel` and `text`. `channel` is `stdout` or
`stderr`. Each error object has exactly `code`, `message`, and `hints`; `hints`
is an array of strings.

Every terminal-facing string is single-line, contains no characters below
U+0020 or in U+007F–U+009F, and contains no surrogate code points. This rule
applies to message `text`, error `code`, error `message`, every error hint, and
every install verification hint. Three constructs enforce it, one per
population: `writeAdapterFailure` (`src/adapter-result.ts`) refuses the error
`code`, `message`, and hints before the first write; `AdapterMessageLog`
escapes message `text` on ingress; and `verifyInstalledFingerprint`
(`src/lifecycle.ts`) omits an unsafe verification hint.

Messages are replayed in array order to their declared streams.

## Operation results

| Operation/view | Exact result contract |
|---|---|
| `install` | Exact key `verification_hints`; its object carries `missing` unconditionally, and `mismatch` exactly when the refresh mode is `add-only`. Each hint satisfies the terminal-facing string rule. |
| `inspect/fingerprint` | Exact keys `view` and `fingerprint`; view is `fingerprint`; `fingerprint` is `null` or a 7- or 40-character hexadecimal string. |
| `inspect/ownership` | Exact keys `view`, `resources`, `legacy_resources`, and `identity_state`; each resource object has Boolean `plugin` and `marketplace`. State is `neither`, `manager`, `legacy`, or `both` and must equal the presence derived from the two resource groups. |
| `inspect/update-control` | Exact keys `view` and `update_control`; view is `update-control`, and the emitted value is `managed`. |

For ownership, manager presence is whether either Boolean in `resources` is
true, and legacy presence is whether either Boolean in `legacy_resources` is
true. Those two derived presence values determine `identity_state`.

For update control, `unsupported` is never emitted on this path. It survives as
an input the consumer still recognizes: `requireManagedUpdateControl`
(`src/lifecycle.ts`) rejects `unsupported` as a capability it cannot guarantee,
and rejects any other non-`managed` value as unknown.

## Capture-time buffering

On the product path, `src/adapter.ts` captures Codex child output in memory with
an unbounded `execFile` `maxBuffer`. Mutation-command output is recorded as
messages through `AdapterMessageLog` into `AdapterOutcome.messages`
(`src/adapter-result.ts`), but listing stdout may instead be parsed directly
without being recorded there; listing stderr is recorded.
