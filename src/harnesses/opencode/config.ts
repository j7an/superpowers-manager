import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import * as jsoncParserRuntime from "jsonc-parser";
import { atomicWriteFile } from "../../atomic.ts";
import { SafetyError } from "../../safety-error.ts";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_DEPTH = 256;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const SYNTAX_KIND = (
  jsoncParserRuntime as unknown as {
    readonly SyntaxKind: {
      readonly CommaToken: number;
      readonly EOF: number;
    };
  }
).SyntaxKind;

export interface ConfigEntry {
  readonly index: number;
  readonly spec: string;
  readonly options: Readonly<Record<string, unknown>> | null;
}

export interface ConfigDocument {
  readonly path: string;
  readonly text: string;
  readonly root: JsonNode;
  readonly entries: readonly ConfigEntry[];
}

export interface ConfigFileObservation {
  readonly document: ConfigDocument;
  readonly bytes: Buffer;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
  };
}

interface FileBytesObservation {
  readonly bytes: Buffer;
  readonly identity: ConfigFileObservation["identity"];
}

function invalidConfig(path: string, cause?: unknown): SafetyError {
  return new SafetyError(
    "opencode-config",
    `invalid OpenCode configuration: ${path}`,
    cause === undefined ? {} : { cause },
  );
}

function cannotRead(path: string, cause?: unknown): SafetyError {
  return new SafetyError(
    "opencode-config",
    `cannot read OpenCode configuration: ${path}`,
    cause === undefined ? {} : { cause },
  );
}

function cannotRemove(path: string, cause?: unknown): SafetyError {
  return new SafetyError(
    "opencode-config",
    `cannot remove owned OpenCode registration: ${path}`,
    cause === undefined ? {} : { cause },
  );
}

function propertyParts(property: JsonNode): readonly [JsonNode, JsonNode] {
  const [key, value] = property.children ?? [];
  if (
    property.type !== "property" ||
    key?.type !== "string" ||
    typeof key.value !== "string" ||
    value === undefined
  ) {
    throw new Error("malformed property tree");
  }
  return [key, value];
}

function validateTree(node: JsonNode, depth: number): void {
  if (node.type !== "object" && node.type !== "array") return;
  if (depth > MAX_CONFIG_DEPTH) throw new Error("configuration is too deep");

  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const [key, value] = propertyParts(property);
      if (names.has(key.value as string)) throw new Error("duplicate key");
      names.add(key.value as string);
      validateTree(value, depth + 1);
    }
    return;
  }

  for (const child of node.children ?? []) validateTree(child, depth + 1);
}

function configEntries(root: JsonNode): readonly ConfigEntry[] {
  const plugin = findNodeAtLocation(root, ["plugin"]);
  if (plugin === undefined) return [];
  if (plugin.type !== "array") throw new Error("plugin must be an array");

  return (plugin.children ?? []).map((entry, index): ConfigEntry => {
    if (entry.type === "string" && typeof entry.value === "string") {
      return { index, spec: entry.value, options: null };
    }
    const tuple = entry.children ?? [];
    if (
      entry.type !== "array" ||
      tuple.length !== 2 ||
      tuple[0]?.type !== "string" ||
      typeof tuple[0].value !== "string" ||
      tuple[1]?.type !== "object"
    ) {
      throw new Error("unsupported plugin entry");
    }
    return {
      index,
      spec: tuple[0].value,
      options: decodeNode(tuple[1]) as Readonly<Record<string, unknown>>,
    };
  });
}

function decodeNode(node: JsonNode): unknown {
  if (node.type === "array") {
    return (node.children ?? []).map(decodeNode);
  }
  if (node.type === "object") {
    const value: Record<string, unknown> = {};
    for (const property of node.children ?? []) {
      const [key, child] = propertyParts(property);
      Object.defineProperty(value, key.value as string, {
        value: decodeNode(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return value;
  }
  return node.value ?? null;
}

export function parseOpenCodeConfig(
  text: string,
  path: string,
): ConfigDocument {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
      throw new Error("configuration is too large");
    }
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: true });
    if (root === undefined || errors.length !== 0 || root.type !== "object") {
      throw new Error("configuration must be one valid object");
    }
    validateTree(root, 1);
    return { path, text, root, entries: configEntries(root) };
  } catch (cause) {
    if (cause instanceof SafetyError) throw cause;
    throw invalidConfig(path, cause);
  }
}

function sameEntries(
  left: readonly ConfigEntry[],
  right: readonly ConfigEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.spec === right[index]?.spec &&
        isDeepStrictEqual(entry.options, right[index]?.options),
    )
  );
}

export function removeOpenCodeEntry(
  document: ConfigDocument,
  index: number,
): string {
  try {
    const array = findNodeAtLocation(document.root, ["plugin"]);
    const elements = array?.children ?? [];
    const element = elements[index];
    if (
      array?.type !== "array" ||
      !Number.isInteger(index) ||
      index < 0 ||
      !element
    ) {
      throw new Error("invalid removal index");
    }
    const previous = elements[index - 1];
    const next = elements[index + 1];
    const gapStart =
      next || !previous
        ? element.offset + element.length
        : previous.offset + previous.length;
    const gapEnd = next
      ? next.offset
      : previous
        ? element.offset
        : array.offset + array.length - 1;
    const scanner = createScanner(document.text, true);
    scanner.setPosition(gapStart);
    let commaOffset: number | undefined;
    while (scanner.getPosition() < gapEnd) {
      const token = scanner.scan();
      if (token === SYNTAX_KIND.EOF || scanner.getTokenOffset() >= gapEnd)
        break;
      if (token !== SYNTAX_KIND.CommaToken || commaOffset !== undefined) {
        throw new Error("unexpected separator");
      }
      commaOffset = scanner.getTokenOffset();
    }
    if ((previous || next) && commaOffset === undefined) {
      throw new Error("missing separator");
    }

    const edits = [
      { offset: element.offset, length: element.length, content: "" },
    ];
    if (commaOffset !== undefined) {
      edits.push({ offset: commaOffset, length: 1, content: "" });
    }
    const output = applyEdits(document.text, edits);
    const after = parseOpenCodeConfig(output, document.path);
    const expected = document.entries.filter((entry) => entry.index !== index);
    if (!sameEntries(after.entries, expected)) {
      throw new Error("removal changed surviving registrations");
    }
    return output;
  } catch (cause) {
    throw cannotRemove(document.path, cause);
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

async function readConfigBytes(
  path: string,
): Promise<FileBytesObservation | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_CONFIG_BYTES) {
      throw new Error("configuration is not a bounded regular file");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_CONFIG_BYTES) {
      throw new Error("configuration grew past the byte limit");
    }
    return {
      bytes,
      identity: {
        dev: details.dev,
        ino: details.ino,
        mode: details.mode,
      },
    };
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return null;
    throw cannotRead(path, cause);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeConfig(bytes: Buffer, path: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw cannotRead(path, cause);
  }
}

export async function readOpenCodeConfig(
  path: string,
): Promise<ConfigFileObservation | null> {
  const observed = await readConfigBytes(path);
  if (observed === null) return null;
  const text = decodeConfig(observed.bytes, path);
  try {
    return {
      document: parseOpenCodeConfig(text, path),
      bytes: observed.bytes,
      identity: observed.identity,
    };
  } catch (cause) {
    throw cannotRead(path, cause);
  }
}

function sameIdentity(
  left: ConfigFileObservation["identity"],
  right: ConfigFileObservation["identity"],
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function removeObservedOpenCodeEntry(
  observation: ConfigFileObservation,
  index: number,
): Promise<void> {
  const path = observation.document.path;
  try {
    const originalText = decodeConfig(observation.bytes, path);
    const original = parseOpenCodeConfig(originalText, path);
    const output = removeOpenCodeEntry(original, index);
    const outputBytes = Buffer.from(output, "utf8");
    const expected = original.entries.filter((entry) => entry.index !== index);

    await atomicWriteFile(path, outputBytes, {
      validate: async (temporary) => {
        await chmod(temporary, observation.identity.mode & 0o7777);
        const current = await readConfigBytes(path);
        if (
          current === null ||
          !sameIdentity(current.identity, observation.identity) ||
          !current.bytes.equals(observation.bytes)
        ) {
          throw new Error("OpenCode configuration changed concurrently");
        }
      },
    });

    const after = await readOpenCodeConfig(path);
    if (
      after === null ||
      !after.bytes.equals(outputBytes) ||
      !sameEntries(after.document.entries, expected)
    ) {
      throw new Error("published OpenCode configuration could not be verified");
    }
  } catch (cause) {
    throw cannotRemove(path, cause);
  }
}
