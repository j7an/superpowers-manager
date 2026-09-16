import type { AdapterOutcome, AdapterResult } from "../adapter-result.ts";

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
