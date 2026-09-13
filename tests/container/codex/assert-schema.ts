import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Codex hooks/list protocol changed: ${message}`);
}

function readSchema(path: string): unknown {
  try {
    return JSON.parse(decoder.decode(readFileSync(path))) as unknown;
  } catch {
    return fail(`schema could not be read: ${path}`);
  }
}

function* walk(value: unknown): Generator<unknown> {
  yield value;
  if (isObject(value))
    for (const child of Object.values(value)) yield* walk(child);
  else if (Array.isArray(value)) for (const child of value) yield* walk(child);
}

function resolve(root: unknown, initial: unknown): unknown {
  let schema = initial;
  const seen = new Set<string>();
  while (isObject(schema) && typeof schema.$ref === "string") {
    const reference = schema.$ref;
    if (!reference.startsWith("#/") || seen.has(reference))
      fail(`unsupported schema reference: ${reference}`);
    seen.add(reference);
    let target: unknown = root;
    for (const part of reference.slice(2).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isObject(target) || !Object.hasOwn(target, key))
        fail(`unresolved schema reference: ${reference}`);
      target = target[key];
    }
    schema = target;
  }
  return schema;
}

function scalarValues(root: unknown, schema: unknown): Set<unknown> {
  const values = new Set<unknown>();
  for (const node of walk(resolve(root, schema))) {
    if (!isObject(node)) continue;
    const resolved = resolve(root, node);
    if (!isObject(resolved)) fail("schema reference resolved to a non-object");
    if (Object.hasOwn(resolved, "const")) values.add(resolved.const);
    if (Array.isArray(resolved.enum))
      for (const value of resolved.enum) values.add(value);
  }
  return values;
}

function allowedTypes(root: unknown, schema: unknown): Set<string> {
  const types = new Set<string>();
  for (const node of walk(resolve(root, schema))) {
    if (!isObject(node)) continue;
    const resolved = resolve(root, node);
    if (!isObject(resolved)) fail("schema reference resolved to a non-object");
    if (typeof resolved.type === "string") types.add(resolved.type);
    else if (Array.isArray(resolved.type))
      for (const type of resolved.type)
        if (typeof type === "string") types.add(type);
  }
  return types;
}

function assertCompatible(
  clientRequest: unknown,
  hooksResponse: unknown,
): void {
  let methodFound = false;
  for (const node of walk(clientRequest)) {
    if (
      !isObject(node) ||
      !isObject(node.properties) ||
      !Object.hasOwn(node.properties, "method")
    )
      continue;
    if (scalarValues(clientRequest, node.properties.method).has("hooks/list")) {
      methodFound = true;
      break;
    }
  }
  if (!methodFound) fail('ClientRequest does not contain method "hooks/list"');

  const candidates: unknown[] = [];
  for (const node of walk(hooksResponse)) {
    if (!isObject(node)) continue;
    if (isObject(node.HookMetadata)) candidates.push(node.HookMetadata);
    if (node.title === "HookMetadata") candidates.push(node);
  }
  if (candidates.length === 0)
    fail("HooksListResponse does not define HookMetadata");
  const metadata = resolve(hooksResponse, candidates[0]);
  if (!isObject(metadata)) fail("HookMetadata is not an object schema");
  const properties = metadata.properties;
  const required = metadata.required;
  if (!isObject(properties) || !Array.isArray(required))
    fail("HookMetadata is not an object schema");
  const requiredFields = new Set([
    "source",
    "enabled",
    "isManaged",
    "trustStatus",
  ]);
  if (![...requiredFields].every((field) => required.includes(field)))
    fail("HookMetadata required fields changed");
  if (![...requiredFields].every((field) => Object.hasOwn(properties, field)))
    fail("HookMetadata properties changed");
  if (!scalarValues(hooksResponse, properties.source).has("plugin"))
    fail('HookMetadata source no longer includes "plugin"');
  if (!scalarValues(hooksResponse, properties.trustStatus).has("untrusted"))
    fail('HookMetadata trustStatus no longer includes "untrusted"');
  if (!Object.hasOwn(properties, "pluginId"))
    fail("HookMetadata no longer exposes pluginId");
  if (required.includes("pluginId"))
    fail("HookMetadata pluginId unexpectedly became required");
  assert.deepEqual(
    allowedTypes(hooksResponse, properties.pluginId),
    new Set(["string", "null"]),
    "Codex hooks/list protocol changed: HookMetadata pluginId is not string-or-null",
  );
}

try {
  const [clientPath, responsePath] = process.argv.slice(2);
  if (typeof clientPath !== "string" || typeof responsePath !== "string")
    fail("schema paths are required");
  assertCompatible(readSchema(clientPath), readSchema(responsePath));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Codex hooks/list protocol changed: schema validation failed"}\n`,
  );
  process.exitCode = 1;
}
