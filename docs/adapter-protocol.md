# Adapter Response Protocol v1

## Scope

This document defines the version-1 JSON response protocol between a
Superpowers Manager adapter and the shared runtime in `scripts/core/`. The
adapter writes one response to standard output; the validator checks that
response against the invoked operation and adapter exit status before any
adapter message is replayed or any result is accepted.

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

After the complete response validates, messages are replayed in array order to
their declared streams. Malformed input never replays any message.

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

## Input limits

| Rule | Inclusive boundary and failure |
|---|---|
| JSON constants | `NaN`, `Infinity`, and `-Infinity` are invalid. |
| Nesting | At most 64 nested arrays/objects; 65 is rejected. |
| Object keys | Duplicate keys are invalid in every object at every depth. |
| Response bytes | At most 1,048,576 bytes (1 MiB) on disk; exactly the limit is accepted. |

All rows above use the malformed-input behavior defined below.

## Failure behavior

A structurally valid success envelope returns validator status 0, writes its
validated result, and replays its validated messages. A valid controlled-failure
envelope returns validator status 1 and replays its validated messages, error,
and hints; it does not produce a validated result.

Malformed input returns validator exit 2, produces no validated result, and
replays no adapter message. The validator's own generic diagnostic remains.
`spw_invoke_adapter` removes the result and normalizes every nonzero validator
exit to operational return 1, so public commands do not expose validator exit 2
directly.

## Size-limit rationale

The measurement pass recorded these response maxima without rounding:

| Environment | Maximum bytes | Source |
|---|---:|---|
| Host hermetic suite | 733 | `hermetic:install:adapter-exit=1:validator-exit=1:adapter-result.json.response` |
| Container Layer 4 | 652 | `layer4-real-codex:install:adapter-exit=0:validator-exit=0:install.json.response` |
| Overall observed | 733 | `hermetic:install:adapter-exit=1:validator-exit=1:adapter-result.json.response` |

The response-byte limit in the table above follows the selection rule
`max(1 MiB, smallest power of two greater than or equal to 100 × largest observed response)`.
Measured current operations sit far below the limit. A future legitimate
response approaching it requires re-measurement, reviewed reselection,
coordinated validator/test/doc updates, and a PR.

This limit is an accident guard, not a security boundary, because adapters
already execute local code.

## Capture-time disk growth

`scripts/core/adapter.sh` redirects adapter stdout to `${result_file}.response`
before validation. Therefore the limit bounds parser memory and replay volume,
not disk growth while stdout is captured.

## Governance

This document defines the intended version-1 contract. The validator enforces
it, and `tests/test_adapter_protocol.py` verifies its executable behavior.
Protocol changes must update all three together; any disagreement is a bug
requiring review.
