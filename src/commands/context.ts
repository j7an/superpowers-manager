import type { HarnessAdapter } from "../harness.ts";
import type { InvocationOptions } from "../harness-compatibility.ts";

export interface CommandContext<R> {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly options: InvocationOptions;
  // REQUIRED, not optional-with-default. An optional field would let a
  // command module silently fall back to the real adapter in a test that
  // meant to inject one — the failure mode is a green case observing
  // nothing, which is the defect the seam registry exists to prevent.
  // src/cli.ts supplies the concrete Codex harness at its one construction
  // site. Shared commands know only this typed boundary.
  readonly adapter: HarnessAdapter<R>;
}
