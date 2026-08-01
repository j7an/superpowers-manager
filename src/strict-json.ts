import { Buffer } from "node:buffer";
import { SafetyError } from "./safety-error.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Module-private brands. JSON object keys are always strings, so no parsed
// input can produce a symbol-keyed property — these are unforgeable by
// construction rather than by convention. A structural check such as
// `typeof value.rawNumber === "string"` is NOT equivalent: the ordinary
// upstream input {"future":{"rawNumber":"123"}} satisfies it and would be
// re-emitted as a bare number, corrupting a field AGENTS.md requires
// preserving.
const RAW_NUMBER = Symbol("strict-json.rawNumber");
const RAW_OBJECT = Symbol("strict-json.rawObject");

export interface RawNumber {
  readonly [RAW_NUMBER]: true;
  readonly source: string;
}

// Objects are ordered entries, not plain objects: ECMAScript enumerates
// integer-index-like keys first in ascending numeric order, so
// {"z":0,"2":2,"1":1,"a":3} would re-emit as 1,2,z,a where CPython keeps
// z,2,1,a. Key order is part of the byte contract.
export interface RawObject {
  readonly [RAW_OBJECT]: true;
  readonly entries: readonly (readonly [string, RawJsonValue])[];
}

export type RawJsonValue =
  null | boolean | string | RawNumber | RawJsonValue[] | RawObject;

export function isRawNumber(value: unknown): value is RawNumber {
  return typeof value === "object" && value !== null && RAW_NUMBER in value;
}

export function isRawObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && RAW_OBJECT in value;
}

export interface StrictJsonProfile {
  readonly duplicateKeys: "reject" | "last-wins";
  readonly nonStandardConstants: "reject" | "accept";
  readonly maxDepth?: number;
  readonly maxBytes?: number;
  readonly integerNumbersOnly?: boolean;
}

// The seam. Two node kinds differ between the value tree and the raw tree,
// so the scanner is parameterized over a builder rather than over a number
// type. Everything dangerous — string escapes, the unescaped-control-char
// rejection at :174, depth accounting, byte limits, duplicate-key policy —
// stays in the scanner and is shared verbatim.
interface TreeBuilder<T> {
  number(token: string): T;
  object(entries: (readonly [string, T])[]): T;
}

const VALUE_BUILDER: TreeBuilder<JsonValue> = {
  number: (token) => Number(token),
  object: (entries) => Object.fromEntries(entries),
};

const RAW_BUILDER: TreeBuilder<RawJsonValue> = {
  number: (token) => ({ [RAW_NUMBER]: true, source: token }),
  object: (entries) => ({ [RAW_OBJECT]: true, entries }),
};

export function parseStrictJson(
  input: string | Uint8Array,
  profile: StrictJsonProfile,
): JsonValue {
  return parseWith(input, profile, VALUE_BUILDER);
}

export function parseStrictJsonPreservingNumbers(
  input: string | Uint8Array,
  profile: StrictJsonProfile,
): RawJsonValue {
  return parseWith(input, profile, RAW_BUILDER);
}

function parseWith<T>(
  input: string | Uint8Array,
  profile: StrictJsonProfile,
  builder: TreeBuilder<T>,
): T {
  const byteLength =
    typeof input === "string"
      ? Buffer.byteLength(input, "utf8")
      : input.byteLength;
  if (profile.maxBytes !== undefined && byteLength > profile.maxBytes) {
    throw new SafetyError(
      "strict-json",
      `input exceeds ${profile.maxBytes} UTF-8 bytes`,
    );
  }

  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
  } catch (cause) {
    throw new SafetyError("strict-json", "input is not valid UTF-8", { cause });
  }

  try {
    return new Parser<T>(text, profile, builder).parse();
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError("strict-json", "JSON parsing failed", { cause });
  }
}

class Parser<T> {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly profile: StrictJsonProfile,
    private readonly builder: TreeBuilder<T>,
  ) {}

  parse(): T {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing input");
    return value;
  }

  private parseValue(depth: number): T {
    if (this.text.startsWith("NaN", this.index)) {
      return this.parseNonStandardConstant("NaN");
    }
    if (this.text.startsWith("Infinity", this.index)) {
      return this.parseNonStandardConstant("Infinity");
    }
    if (this.text.startsWith("-Infinity", this.index)) {
      return this.parseNonStandardConstant("-Infinity");
    }
    const token = this.text[this.index];
    if (token === "{") return this.parseObject(depth + 1);
    if (token === "[") return this.parseArray(depth + 1) as T;
    if (token === '"') return this.parseString() as T;
    if (token === "t") return this.parseLiteral("true", true) as T;
    if (token === "f") return this.parseLiteral("false", false) as T;
    if (token === "n") return this.parseLiteral("null", null) as T;
    return this.parseNumber();
  }

  private checkDepth(depth: number): void {
    if (this.profile.maxDepth !== undefined && depth > this.profile.maxDepth) {
      this.fail(`container depth exceeds ${this.profile.maxDepth}`);
    }
  }

  private parseObject(depth: number): T {
    this.checkDepth(depth);
    this.index += 1;
    const entries: [string, T][] = [];
    const seen = new Map<string, number>();
    this.skipWhitespace();
    if (this.take("}")) return this.builder.object(entries);
    for (;;) {
      if (this.text[this.index] !== '"')
        this.fail("object key must be a string");
      const key = this.parseString();
      this.skipWhitespace();
      if (!this.take(":")) this.fail("expected ':' after object key");
      this.skipWhitespace();
      const value = this.parseValue(depth);
      const previous = seen.get(key);
      if (previous === undefined) {
        seen.set(key, entries.length);
        entries.push([key, value]);
      } else if (this.profile.duplicateKeys === "reject") {
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      } else {
        // Last value wins AT THE FIRST KEY'S POSITION. Verified against
        // CPython 2026-07-31: json.loads('{"a":1,"b":2,"a":3}') reserializes
        // as {"a": 3, "b": 2} — the dict keeps the original slot. Pushing a
        // new entry instead would satisfy the "renamed" assertion at
        // tests/test_prepare_with_fake_upstream.sh:660 while silently
        // reordering the output.
        entries[previous] = [key, value];
      }
      this.skipWhitespace();
      if (this.take("}")) return this.builder.object(entries);
      if (!this.take(",")) this.fail("expected ',' or '}'");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): T[] {
    this.checkDepth(depth);
    this.index += 1;
    const result: T[] = [];
    this.skipWhitespace();
    if (this.take("]")) return result;
    for (;;) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.take("]")) return result;
      if (!this.take(",")) this.fail("expected ',' or ']'");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index]!;
      this.index += 1;
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.text[this.index];
        this.index += 1;
        const short: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape !== undefined && Object.hasOwn(short, escape)) {
          result += short[escape];
          continue;
        }
        if (escape === "u") {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex))
            this.fail("invalid Unicode escape");
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          continue;
        }
        this.fail("invalid string escape");
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail("unescaped control character in string");
      }
      result += character;
    }
    this.fail("unterminated string");
  }

  private parseNumber(): T {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) this.fail("expected JSON value");
    const token = match[0];
    this.index += token.length;
    if (this.profile.integerNumbersOnly === true && /[.eE]/.test(token)) {
      this.fail("non-integer JSON number");
    }
    return this.builder.number(token);
  }

  private parseLiteral<L extends null | boolean>(literal: string, value: L): L {
    if (!this.text.startsWith(literal, this.index))
      this.fail("invalid literal");
    this.index += literal.length;
    return value;
  }

  private parseNonStandardConstant(token: string): T {
    if (this.profile.nonStandardConstants === "reject") {
      this.fail(`non-standard JSON constant ${token}`);
    }
    this.index += token.length;
    return this.builder.number(token);
  }

  private skipWhitespace(): void {
    while (
      this.text[this.index] === " " ||
      this.text[this.index] === "\n" ||
      this.text[this.index] === "\r" ||
      this.text[this.index] === "\t"
    ) {
      this.index += 1;
    }
  }

  private take(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private fail(message: string): never {
    throw new SafetyError(
      "strict-json",
      `${message} at character ${this.index}`,
    );
  }
}
