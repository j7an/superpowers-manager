// @ts-check
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Feed one framed record into the digest: a byte-length prefix followed by
 * the bytes themselves. Framing every record this way makes the resulting
 * byte stream uniquely decodable back into the original (record) list, so
 * two different input sets can never fold to the same digest through
 * unframed concatenation.
 * @param {import("node:crypto").Hash} hash
 * @param {Buffer} bytes
 * @returns {void}
 */
function updateFramed(hash, bytes) {
  hash.update(`${bytes.byteLength}\n`);
  hash.update(bytes);
}

/**
 * Resolve the installed TypeScript compiler's version from its own
 * package.json — the source of truth for what actually compiled `dist/`.
 * Never hardcode a version literal here: fails closed (throws) rather than
 * silently omitting the input when the package is missing or malformed, so
 * a broken resolution shows up as a build-id computation failure instead of
 * a digest that quietly stopped covering the compiler.
 * @param {string} root
 * @returns {string}
 */
function resolveCompilerVersion(root) {
  const manifestPath = join(root, "node_modules", "typescript", "package.json");
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(
      `cannot resolve the installed TypeScript compiler version: ${manifestPath} could not be read`,
    );
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${manifestPath} is not valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (/** @type {{version?: unknown}} */ (parsed).version) !== "string" ||
    /** @type {{version: string}} */ (parsed).version === ""
  ) {
    throw new Error(`${manifestPath} has no usable "version" field`);
  }
  return /** @type {{version: string}} */ (parsed).version;
}

/**
 * Digest every compiled source, the compiler config, and the resolved
 * compiler identity. Imported by the runner, the postbuild writer, and the
 * tests — so it must stay free of top-level side effects. Do not add a
 * process.exit() or an existence check to this file.
 * @param {string} root
 * @returns {string}
 */
export function computeBuildId(root) {
  const hash = createHash("sha256");
  const sources = readdirSync(join(root, "src"), { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  for (const name of sources) {
    updateFramed(hash, Buffer.from(name, "utf8"));
    updateFramed(hash, readFileSync(join(root, "src", name)));
  }
  updateFramed(hash, readFileSync(join(root, "tsconfig.json")));
  updateFramed(hash, Buffer.from(resolveCompilerVersion(root), "utf8"));
  return `${hash.digest("hex")}\n`;
}
