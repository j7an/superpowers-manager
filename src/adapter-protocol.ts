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

export type AdapterEnvelope =
  | {
      readonly protocol: 1;
      readonly operation: string;
      readonly ok: true;
      readonly messages: readonly AdapterMessage[];
      readonly result: JsonValue;
      readonly error: null;
    }
  | {
      readonly protocol: 1;
      readonly operation: string;
      readonly ok: false;
      readonly messages: readonly AdapterMessage[];
      readonly result: null;
      readonly error: AdapterError;
    };

export interface AdapterResult {
  readonly status: 0 | 1;
  readonly envelope: AdapterEnvelope;
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
    envelope: {
      protocol: 1,
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
    envelope: {
      protocol: 1,
      operation,
      ok: false,
      messages,
      result: null,
      error: { code, message, hints },
    },
  };
}

function hasTerminalControl(value: string): boolean {
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

function requireProtocolString(value: string): void {
  if (hasTerminalControl(value)) {
    throw new Error(
      "protocol strings must not contain terminal control characters",
    );
  }
}

function requireFinite(value: JsonValue): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("protocol JSON must not contain non-finite numbers");
  }
  if (Array.isArray(value)) {
    for (const child of value) requireFinite(child);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) requireFinite(child);
  }
}

export function serializeEnvelope(envelope: AdapterEnvelope): string {
  requireProtocolString(envelope.operation);
  for (const [index, message] of envelope.messages.entries()) {
    if (
      (message.channel !== "stdout" && message.channel !== "stderr") ||
      message.text.length === 0 ||
      message.text.includes("\t") ||
      message.text.includes("\r") ||
      hasTerminalControl(message.text)
    ) {
      throw new Error(`invalid message record at line ${index + 1}`);
    }
  }
  if (envelope.ok) {
    requireFinite(envelope.result);
  } else {
    requireProtocolString(envelope.error.code);
    requireProtocolString(envelope.error.message);
    for (const hint of envelope.error.hints) {
      if (hasTerminalControl(hint)) {
        throw new Error(
          "protocol hints must not contain terminal control characters",
        );
      }
    }
  }
  return `${JSON.stringify(envelope)}\n`;
}
