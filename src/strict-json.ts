import { Buffer } from "node:buffer";
import { SafetyError } from "./safety-error.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StrictJsonProfile {
  readonly duplicateKeys: "reject" | "last-wins";
  readonly maxDepth?: number;
  readonly maxBytes?: number;
}

export function parseStrictJson(
  input: string | Uint8Array,
  profile: StrictJsonProfile,
): JsonValue {
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

  try {
    return new Parser(text, profile).parse();
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw new SafetyError("strict-json", "JSON parsing failed", { cause });
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly profile: StrictJsonProfile,
  ) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing input");
    return value;
  }

  private parseValue(depth: number): JsonValue {
    const token = this.text[this.index];
    if (token === "{") return this.parseObject(depth + 1);
    if (token === "[") return this.parseArray(depth + 1);
    if (token === '"') return this.parseString();
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private checkDepth(depth: number): void {
    if (this.profile.maxDepth !== undefined && depth > this.profile.maxDepth) {
      this.fail(`container depth exceeds ${this.profile.maxDepth}`);
    }
  }

  private parseObject(depth: number): { [key: string]: JsonValue } {
    this.checkDepth(depth);
    this.index += 1;
    const result: { [key: string]: JsonValue } = {};
    this.skipWhitespace();
    if (this.take("}")) return result;
    for (;;) {
      if (this.text[this.index] !== '"')
        this.fail("object key must be a string");
      const key = this.parseString();
      this.skipWhitespace();
      if (!this.take(":")) this.fail("expected ':' after object key");
      this.skipWhitespace();
      const value = this.parseValue(depth);
      if (
        this.profile.duplicateKeys === "reject" &&
        Object.hasOwn(result, key)
      ) {
        this.fail(`duplicate object key ${JSON.stringify(key)}`);
      }
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.take("}")) return result;
      if (!this.take(",")) this.fail("expected ',' or '}'");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.checkDepth(depth);
    this.index += 1;
    const result: JsonValue[] = [];
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

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (match === null) this.fail("expected JSON value");
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseLiteral<T extends null | boolean>(literal: string, value: T): T {
    if (!this.text.startsWith(literal, this.index))
      this.fail("invalid literal");
    this.index += literal.length;
    return value;
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
