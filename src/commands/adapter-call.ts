import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";
import type { Output } from "../harness.ts";
import type { CommandContext } from "./context.ts";

export type AdapterCall<T> =
  | {
      readonly ok: true;
      readonly result: {
        readonly status: 0;
        readonly outcome: Extract<AdapterOutcome<T>, { readonly ok: true }>;
      };
    }
  | {
      readonly ok: false;
      readonly result: AdapterResult<T> | null;
      readonly message: string | null;
    };

export async function callAdapter<T>(
  call: () => Promise<AdapterResult<T>>,
  failure: { readonly unexpected: string; readonly invalidStatus: string },
): Promise<AdapterCall<T>> {
  let result: AdapterResult<T>;
  try {
    result = await call();
  } catch {
    return { ok: false, result: null, message: failure.unexpected };
  }
  const outcome = result.outcome;
  if (result.status !== 0 || !outcome.ok)
    return {
      ok: false,
      result,
      message: outcome.ok ? failure.invalidStatus : null,
    };
  return { ok: true, result: { status: result.status, outcome } };
}

// Preserve outcomes collected before gathering throws so command catches can
// replay them before reporting the underlying failure.
export class GatherFailure extends Error {
  readonly inner: unknown;
  readonly outcomes: readonly AdapterOutcome<unknown>[];

  constructor(
    message: string,
    inner: unknown,
    outcomes: readonly AdapterOutcome<unknown>[],
  ) {
    super(message);
    this.inner = inner;
    this.outcomes = outcomes;
  }
}

export function writeOutput(
  output: Output,
  ctx: Pick<CommandContext<never>, "stdout" | "stderr">,
): void {
  for (const line of output.stdout) ctx.stdout.write(`${line}\n`);
  for (const line of output.stderr) ctx.stderr.write(`${line}\n`);
}

// callAdapter plus outcome collection: every returned result's outcome is
// recorded for replay. acceptValue turns a successful value it rejects into an
// invalid status without recording that outcome.
export async function invoke<T>(
  call: () => Promise<AdapterResult<T>>,
  failure: { readonly unexpected: string; readonly invalidStatus: string },
  outcomes: AdapterOutcome<unknown>[],
  acceptValue?: (value: T) => boolean,
): Promise<AdapterCall<T>> {
  let result = await callAdapter(call, failure);
  if (result.ok && acceptValue !== undefined) {
    try {
      if (!acceptValue(result.result.outcome.result))
        result = { ok: false, result: null, message: failure.invalidStatus };
    } catch {
      result = { ok: false, result: null, message: failure.invalidStatus };
    }
  }
  if (result.result !== null) outcomes.push(result.result.outcome);
  return result;
}
