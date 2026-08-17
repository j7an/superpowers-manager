# Adapter Response Protocol v1

## Scope

This document defines the version-1 JSON response protocol used by
`src/adapter-cli.ts`.

The product CLI does not use that transport: `src/cli.ts` binds `runAdapter`
directly into the lifecycle context, and handlers consume its `AdapterResult`
in-process. There is no adapter-process exit or independent
operation/response validation on that path.

## Envelope

Every response is a JSON object with exactly these six keys:

| Field | Normative rule |
|---|---|
| `protocol` | Must be integer `1`; Boolean and floating-point `1` are rejected. |
| `operation` | Must be `build`, `inspect`, `install`, or `uninstall` and equal the invoked operation. |
| `ok` | Must be Boolean. `true` requires adapter exit 0; `false` requires nonzero adapter exit. |
| `messages` | Must be an array of exact message objects. |
| `result` | Success uses the operation-specific object; failure requires `null`. |
| `error` | Success requires `null`; failure uses the exact error object. |

Unknown or missing keys are rejected wherever this protocol defines an exact
shape.

## Messages and errors

Each message object has exactly `channel` and `text`. `channel` is `stdout` or
`stderr`. Each error object has exactly `code`, `message`, and `hints`; `hints`
is an array of strings.

Every terminal-facing string is non-empty, single-line, contains no characters
below U+0020 or in U+007F–U+009F, and contains no surrogate code points. This
rule applies to message `text`, error `code`, error `message`, every error hint,
and every install verification hint.

Messages are replayed in array order to their declared streams.

## Operation results

| Operation/view | Exact result contract |
|---|---|
| `build` | Empty object. |
| `uninstall` | Empty object. |
| `install` | Exact key `verification_hints`; its object may contain only `mismatch` and/or `missing`, each satisfying the terminal-facing string rule. |
| `inspect/fingerprint` | Exact keys `view` and `fingerprint`; view is `fingerprint`; `fingerprint` is `null` or a 7- or 40-character hexadecimal string. |
| `inspect/ownership` | Exact keys `view`, `resources`, `legacy_resources`, and `identity_state`; each resource object has Boolean `plugin` and `marketplace`. State is `neither`, `manager`, `legacy`, or `both` and must equal the presence derived from the two resource groups. |
| `inspect/update-control` | Exact keys `view` and `update_control`; view is `update-control`, value is `managed` or `unsupported`. |

For ownership, manager presence is whether either Boolean in `resources` is
true, and legacy presence is whether either Boolean in `legacy_resources` is
true. Those two derived presence values determine `identity_state`.

## Capture-time buffering

On the product path, `src/adapter.ts` captures Codex child output in memory with
an unbounded `execFile` `maxBuffer`. Mutation-command output is recorded as
messages, but listing stdout may instead be parsed directly without being
recorded in an envelope; listing stderr is recorded.
