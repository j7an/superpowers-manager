# In-Process Adapter Result Contract

## Scope

This document defines the in-process adapter result contract used by the
product CLI. `src/cli.ts` binds the concrete `codexHarness` as a typed
`HarnessAdapter<CodexRemovalInput>`, while shared command handlers consume the
generic `HarnessAdapter<R>` and `AdapterResult<T>` envelope in-process. The
interface is internal TypeScript, not an external protocol. There is no
adapter-process exit or independent operation/response validation on the
product path.

The concrete Codex harness calls the typed Codex operation engines directly.
Those engines return the lifecycle payload types shared commands consume. There
is no argv-based compatibility dispatcher or shape-normalization layer.

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
escapes message `text` on ingress; and `codexInstallReceipt`
(`src/harnesses/codex/presentation.ts`) omits an unsafe verification hint before
`codexPresentation.renderInstallVerification` renders it.

Messages are replayed in array order to their declared streams.

## Codex operation results

The table below describes the typed Codex engine result shapes. The generic
envelope preserves each engine result for in-process harness consumers; it does
not require another integration to reproduce these Codex-native fields.

| Codex operation/view | Exact engine result contract |
|---|---|
| `install` | `InstallReceipt`; the missing verification output always includes the safe listing hint, and the mismatch output includes the safe remove-add retry hint only in `add-only` refresh mode. |
| ownership inspection | `OwnershipInspection<CodexRemovalInput>`; the producer derives install/removal policy, presentation values, conflicts, and the exact manager resource booleans consumed by removal. |
| update-control inspection | `UpdateControlInspection`; the low-level producer reports managed capability and the public harness may overlay recovery blocking. |
| installed-state inspection | `InstalledState`, through `inspectCodexInstallation`; absence, mismatch, and current require the existing native, durable, provenance, and payload evidence. |

For ownership, manager presence is whether either observed manager resource is
present, and legacy presence is whether either observed legacy resource is
present. Those values determine the policy's presentation identity while the
manager booleans remain the removal input.

For update control, `unsupported` is never emitted on this path. It survives as
an input the consumer still recognizes: `requireManagedUpdateControl`
(`src/harnesses/codex/lifecycle.ts`) rejects `unsupported` as a capability it cannot guarantee,
and rejects any other non-`managed` value as unknown.

## Capture-time buffering

On the product path, `src/harnesses/codex/adapter.ts` captures Codex child output in memory with
an unbounded `execFile` `maxBuffer`. Mutation-command output is recorded as
messages through `AdapterMessageLog` into `AdapterOutcome.messages`
(`src/adapter-result.ts`), but listing stdout may instead be parsed directly
without being recorded there; listing stderr is recorded.
