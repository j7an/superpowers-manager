import type { AdapterContext, AdapterResult } from "../adapter-result.ts";

export interface CommandContext {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  // REQUIRED, not optional-with-default. An optional field would let a
  // command module silently fall back to the real adapter in a test that
  // meant to inject one — the failure mode is a green case observing
  // nothing, which is the defect the seam registry exists to prevent.
  // src/cli.ts supplies runAdapter at its one construction site.
  readonly adapter: (
    argv: readonly string[],
    ctx: AdapterContext,
  ) => Promise<AdapterResult>;
}
