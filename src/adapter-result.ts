import type { JsonValue } from "./strict-json.js";

export type AdapterChannel = "stdout" | "stderr";

export interface AdapterMessage {
  readonly channel: AdapterChannel;
  readonly text: string;
}

export interface AdapterError {
  readonly code: string;
  readonly message: string;
  readonly hints: readonly string[];
}

export type AdapterOutcome =
  | {
      readonly operation: string;
      readonly ok: true;
      readonly messages: readonly AdapterMessage[];
      readonly result: JsonValue;
      readonly error: null;
    }
  | {
      readonly operation: string;
      readonly ok: false;
      readonly messages: readonly AdapterMessage[];
      readonly result: null;
      readonly error: AdapterError;
    };

export interface AdapterResult {
  readonly status: 0 | 1;
  readonly outcome: AdapterOutcome;
}

// Lives here, not in src/adapter.ts, rather than having context.ts import it
// directly from adapter.ts. NOT a cycle avoidance: tsconfig.json's
// verbatimModuleSyntax:true erases a type-only import
// (`import type { AdapterContext } from "../adapter.js"`) at emit, so it
// produces no runtime edge either way and a cycle was never possible. The
// actual reason is grouping: AdapterContext, AdapterResult, and
// AdapterOutcome are all protocol types, and this is the module that owns
// the protocol rather than the one that implements it. adapter.ts re-exports
// this name so its existing importers are unaffected.
export interface AdapterContext {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
}

function byteEscape(byte: number): string {
  return `\\x${byte.toString(16).padStart(2, "0")}`;
}

function decodeBackslashReplace(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    if (first < 0x80) {
      result += String.fromCodePoint(first);
      index += 1;
      continue;
    }

    let length = 0;
    let codePoint = 0;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      codePoint = first & 0x0f;
      if (first === 0xe0) secondMinimum = 0xa0;
      if (first === 0xed) secondMaximum = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      codePoint = first & 0x07;
      if (first === 0xf0) secondMinimum = 0x90;
      if (first === 0xf4) secondMaximum = 0x8f;
    }

    const second = bytes[index + 1];
    let valid =
      length > 0 &&
      index + length <= bytes.length &&
      second !== undefined &&
      second >= secondMinimum &&
      second <= secondMaximum;
    for (let offset = 2; valid && offset < length; offset += 1) {
      const byte = bytes[index + offset]!;
      valid = byte >= 0x80 && byte <= 0xbf;
    }
    if (!valid) {
      result += byteEscape(first);
      index += 1;
      continue;
    }
    for (let offset = 1; offset < length; offset += 1) {
      codePoint = (codePoint << 6) | (bytes[index + offset]! & 0x3f);
    }
    result += String.fromCodePoint(codePoint);
    index += length;
  }
  return result;
}

function pythonUnicodeEscape(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === "\\") result += "\\\\";
    else if (code === 0x09) result += "\\t";
    else if (code === 0x0a) result += "\\n";
    else if (code === 0x0d) result += "\\r";
    else if (code >= 0x20 && code <= 0x7e) result += character;
    else if (code <= 0xff) result += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff)
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return result;
}

export function pythonUnicodeEscapeBytes(bytes: Uint8Array): string {
  return pythonUnicodeEscape(decodeBackslashReplace(bytes));
}

export class AdapterMessageLog {
  readonly #messages: AdapterMessage[] = [];

  appendBytes(channel: AdapterChannel, bytes: Uint8Array): void {
    let start = 0;
    for (let index = 0; index <= bytes.length; index += 1) {
      if (index !== bytes.length && bytes[index] !== 0x0a) continue;
      const chunk = bytes.slice(start, index);
      start = index + 1;
      if (chunk.length === 0) continue;
      this.#messages.push({
        channel,
        text: pythonUnicodeEscapeBytes(chunk),
      });
    }
  }

  appendText(channel: AdapterChannel, text: string): void {
    const escaped = pythonUnicodeEscape(text);
    if (escaped.length > 0) this.#messages.push({ channel, text: escaped });
  }

  snapshot(): readonly AdapterMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }
}

export function successResult(
  operation: string,
  result: JsonValue,
  messages: readonly AdapterMessage[],
): AdapterResult {
  return {
    status: 0,
    outcome: {
      operation,
      ok: true,
      messages,
      result,
      error: null,
    },
  };
}

export function failureResult(
  operation: string,
  code: string,
  message: string,
  hints: readonly string[],
  messages: readonly AdapterMessage[],
): AdapterResult {
  return {
    status: 1,
    outcome: {
      operation,
      ok: false,
      messages,
      result: null,
      error: { code, message, hints },
    },
  };
}

export function hasTerminalControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

// D8b's enforcement point on the LIVE product path. replayOutcome -- which
// every command replays through -- wrote these three strings to the terminal
// unfiltered.
//
// NOT requireProtocolString: that one message
// ("protocol strings must not contain terminal control characters") names no
// member, and D8b requires the thrown message to name the failing one. So this
// scans with the predicate underneath it instead.
//
// Order is code, then message, then hints by ascending index, so the thrown
// message is a function of the outcome rather than of iteration order.
//
// The offending value is never interpolated, never sanitized, and never
// truncated into the message: the contract is that an unsafe string does not
// reach the terminal, not that it arrives altered. The hint INDEX is the one
// interpolated value, and it is a bounded integer. src/cli.ts's handler catch
// emits `error: <this module's own hand-written message>` with exit 1, which
// is the sanctioned interpolation under AGENTS.md.
//
// Exported separately from writeAdapterFailure because replayOutcome writes
// every message BEFORE the error line: a caller that validated only at the
// write would already have put the context lines on the stream when the guard
// fired. Hoisting this above the message loop is what makes a refused failure
// leave both streams untouched.
export function assertFailureWritable(outcome: AdapterOutcome): void {
  if (outcome.ok) return;
  if (hasTerminalControl(outcome.error.code)) {
    throw new Error(
      "adapter failure code contains a terminal control character",
    );
  }
  if (hasTerminalControl(outcome.error.message)) {
    throw new Error(
      "adapter failure message contains a terminal control character",
    );
  }
  for (const [index, hint] of outcome.error.hints.entries()) {
    if (hasTerminalControl(hint)) {
      throw new Error(
        `adapter failure hint[${index}] contains a terminal control character`,
      );
    }
  }
}

// Validates the WHOLE failure before the first write, so a hint that fails
// after two safe ones leaves neither of those two on the stream. `ctx` is
// typed structurally rather than as CommandContext: this reads exactly one of
// that interface's five members, and naming the wide type would point this
// module at one that already imports from it.
export function writeAdapterFailure(
  ctx: { readonly stderr: NodeJS.WritableStream },
  outcome: AdapterOutcome,
): void {
  assertFailureWritable(outcome);
  if (outcome.ok) return;
  ctx.stderr.write(`error: ${outcome.error.message}\n`);
  for (const hint of outcome.error.hints) {
    ctx.stderr.write(`hint: ${hint}\n`);
  }
}

export function requireProtocolString(value: string): void {
  if (hasTerminalControl(value)) {
    throw new Error(
      "protocol strings must not contain terminal control characters",
    );
  }
}
