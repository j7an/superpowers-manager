// @ts-check
// Citation scanner, resolver, ledger builder and bounded fixer. No assertions
// or process exit; applyFixEdits is the only writer. The suite asserts over it
// and the tool drives it, so both compute line numbers through exactly one
// implementation.
//
// A citation is recognized ONLY inside a comment. Every citation in the
// enforced corpus was measured comment-leading at the plan's base, with none
// in a string literal, so no tokenizer is required. Known blind spot: a
// citation-shaped token inside a multi-line template literal can be read as a
// comment citation. That yields a false positive, which the ledger absorbs.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";

export const MIN_ANCHOR = 3;

/** The enforced corpus, declared and never globbed. */
export const CORPUS_DIRS = /** @type {const} */ ([
  "src",
  "tests/bin",
  "tests/baseline",
  "tests/unit",
  "tests/lib",
]);

const PATH = String.raw`(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+`;
const ANCHORED = new RegExp(
  String.raw`^(${PATH})(?::(\d+)(?:-(\d+))?)?::(.+)$`,
);
const RESOLUTION = new RegExp(String.raw`^git show ([0-9a-f]{40}):(${PATH})$`);
const LEGACY = new RegExp(String.raw`(${PATH}):(\d+)(?:-(\d+))?`, "g");
const BACKTICKED = /`([^`\n]+)`/g;
// A backticked token that LOOKS like a citation but does not parse is retained
// as MALFORMED rather than dropped. Dropping it is fail-open: a near-miss
// anchored citation would be invisible to the gate AND absent from the ledger,
// which is a bypass, not a gap. Plain `path:N` is deliberately excluded --
// that is a legitimate legacy citation and the legacy pass owns it.
// The file-like fallback is intentionally broader than PATH only for candidate
// retention: a plausible extension before the `::` separator is enough,
// independently of valid PATH characters. ANCHORED remains the sole valid-path
// parser.
const CANDIDATE = new RegExp(
  String.raw`^(?:git show\s+\S+:\S|.+\.[^\s:]+(?::.*)?::)`,
);
const LEADING_PATH = new RegExp(String.raw`^(${PATH})`);
const CONTROL_CONDITION = new Set(["for", "if", "while", "with"]);
const EXPRESSION_PREFIX = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * The comment portion of a line, with its offset, or undefined when the line
 * carries none.
 * @param {string} line
 * @returns {{ text: string, offset: number } | undefined}
 */
export function commentText(line) {
  const lead = line.trimStart();
  if (lead.startsWith("//") || lead.startsWith("*") || lead.startsWith("/*")) {
    return { text: line, offset: 0 };
  }
  /** @type {string | undefined} */
  let quote;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let expressionCanStart = true;
  /** @type {"control" | "for" | undefined} */
  let pendingControl;
  /** @type {Array<"control" | "for" | "for-of" | undefined>} */
  const controlParens = [];
  let propertyAccess = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const c = line[i];
    if (blockComment) {
      if (c === "*" && line[i + 1] === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = undefined;
        expressionCanStart = false;
      }
      continue;
    }
    if (regex) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === "[") regexClass = true;
      else if (c === "]") regexClass = false;
      else if (c === "/" && !regexClass) {
        regex = false;
        expressionCanStart = false;
      }
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      pendingControl = undefined;
      propertyAccess = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let end = i + 1;
      while (end < line.length && /[\w$]/.test(line[end])) end += 1;
      const word = line.slice(i, end);
      /** @type {boolean} */
      const forOfSeparator =
        !propertyAccess &&
        word === "of" &&
        controlParens.at(-1) === "for" &&
        !expressionCanStart;
      if (forOfSeparator) controlParens[controlParens.length - 1] = "for-of";
      pendingControl =
        !propertyAccess && CONTROL_CONDITION.has(word)
          ? word === "for"
            ? "for"
            : "control"
          : undefined;
      expressionCanStart =
        !propertyAccess && (EXPRESSION_PREFIX.has(word) || forOfSeparator);
      propertyAccess = false;
      i = end - 1;
      continue;
    }
    if (/\d/.test(c)) {
      let end = i + 1;
      while (end < line.length && /[\w.]/.test(line[end])) end += 1;
      expressionCanStart = false;
      pendingControl = undefined;
      propertyAccess = false;
      i = end - 1;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") {
      return { text: line.slice(i), offset: i };
    }
    if (c === "/" && line[i + 1] === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === "/") {
      pendingControl = undefined;
      propertyAccess = false;
      if (expressionCanStart) {
        regex = true;
        regexClass = false;
      } else {
        expressionCanStart = true;
        if (line[i + 1] === "=") i += 1;
      }
      continue;
    }
    if (c === "(") {
      controlParens.push(pendingControl);
      expressionCanStart = true;
      pendingControl = undefined;
      propertyAccess = false;
      continue;
    }
    if (c === ")") {
      const closesControl = controlParens.pop() !== undefined;
      expressionCanStart = closesControl;
      pendingControl = undefined;
      propertyAccess = false;
      continue;
    }
    if ((c === "+" || c === "-") && line[i + 1] === c) {
      /** @type {boolean} */
      const postfix = !expressionCanStart;
      expressionCanStart = !postfix;
      pendingControl = undefined;
      propertyAccess = false;
      i += 1;
      continue;
    }
    pendingControl = undefined;
    if (c === "]" || c === "}") {
      expressionCanStart = false;
    } else if (c === ".") {
      expressionCanStart = false;
    } else {
      expressionCanStart = true;
    }
    propertyAccess = c === ".";
  }
  return undefined;
}

/** @param {string} path */
function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
}

/**
 * @param {readonly string[]} dirs
 * @param {string} root
 * @returns {string[]}
 */
export function listSources(dirs, root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new Error(`cannot read directory ${dir}`);
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) out.push(p);
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return out.sort();
}

/**
 * @typedef {object} Citation
 * @property {"anchored" | "legacy" | "resolution" | "malformed"} kind
 * @property {"anchored" | "resolution"} [shape]
 * @property {string} file
 * @property {number} lineNumber
 * @property {number} column
 * @property {string} raw
 * @property {string} path
 * @property {number} [line]
 * @property {number} [endLine]
 * @property {string} [anchor]
 * @property {string} [sha]
 */

/**
 * @param {string} text
 * @param {number} offset
 * @param {string} file
 * @param {number} lineNumber
 * @returns {Citation[]}
 */
function parseComment(text, offset, file, lineNumber) {
  /** @type {Citation[]} */
  const found = [];
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const m of text.matchAll(BACKTICKED)) {
    const inner = m[1];
    const at = /** @type {number} */ (m.index);
    const res = RESOLUTION.exec(inner);
    if (res !== null) {
      found.push({
        kind: "resolution",
        file,
        lineNumber,
        column: offset + at,
        raw: m[0],
        path: res[2],
        sha: res[1],
      });
      spans.push([at, at + m[0].length]);
      continue;
    }
    const anc = ANCHORED.exec(inner);
    if (anc !== null) {
      found.push({
        kind: "anchored",
        file,
        lineNumber,
        column: offset + at,
        raw: m[0],
        path: anc[1],
        line: anc[2] === undefined ? undefined : Number(anc[2]),
        endLine: anc[3] === undefined ? undefined : Number(anc[3]),
        anchor: anc[4],
      });
      spans.push([at, at + m[0].length]);
      continue;
    }
    if (CANDIDATE.test(inner)) {
      const leading = LEADING_PATH.exec(inner);
      found.push({
        kind: "malformed",
        shape: inner.startsWith("git show") ? "resolution" : "anchored",
        file,
        lineNumber,
        column: offset + at,
        raw: m[0],
        path: leading === null ? "" : leading[1],
      });
      spans.push([at, at + m[0].length]);
    }
  }
  let rest = text;
  for (const [s, e] of spans)
    rest = rest.slice(0, s) + " ".repeat(e - s) + rest.slice(e);
  for (const m of rest.matchAll(LEGACY)) {
    found.push({
      kind: "legacy",
      file,
      lineNumber,
      column: offset + /** @type {number} */ (m.index),
      raw: m[0],
      path: m[1],
      line: Number(m[2]),
      endLine: m[3] === undefined ? undefined : Number(m[3]),
    });
  }
  return found;
}

/** @param {string[]} files @returns {Citation[]} */
export function scan(files) {
  /** @type {Citation[]} */
  const out = [];
  for (const file of files) {
    readLines(file).forEach((line, index) => {
      const comment = commentText(line);
      if (comment !== undefined)
        out.push(
          ...parseComment(comment.text, comment.offset, file, index + 1),
        );
    });
  }
  return out;
}

/** @param {string} path @returns {boolean} */
export function hasDotSegment(path) {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** @param {string} path @param {string} root @returns {boolean} */
export function targetExists(path, root) {
  if (hasDotSegment(path)) return false;
  try {
    const physicalRoot = realpathSync(root);
    const physicalTarget = realpathSync(join(root, path));
    const fromRoot = relative(physicalRoot, physicalTarget);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    )
      return false;
    return statSync(physicalTarget).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether path exists in the tree of object sha. This is what makes a
 * resolution citation a claim rather than a shape: without it a stamped
 * object name that names nothing passes.
 * @param {string} sha
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
export function historicalTargetExists(sha, path, root) {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.error === undefined && result.status === 0;
}

/**
 * Whether the historical leg can run at all: a repository must exist at root.
 * The container image is a copy of a checkout, not a checkout -- .dockerignore
 * excludes .git -- so this is false there. The discriminator is the fact, never
 * an environment variable, and the caller counts and asserts what it covers.
 * A shallow checkout has a repository and lacks the objects, so it fails the
 * existence check rather than degrading here.
 * @param {string} root
 * @returns {boolean}
 */
export function historicalChecksAvailable(root) {
  return existsSync(join(root, ".git"));
}

/** @param {string} file @param {string} root @returns {string} */
export function displayPath(file, root) {
  return relative(root, file);
}

/**
 * Every line of `path` containing `anchor`, one-based.
 * @param {string} path
 * @param {string} anchor
 * @returns {number[]}
 */
export function anchorLines(path, anchor) {
  /** @type {number[]} */
  const hits = [];
  readLines(path).forEach((line, index) => {
    if (line.includes(anchor)) hits.push(index + 1);
  });
  return hits;
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * True when `anchor` occurs in `line` at least once without beginning or
 * ending inside an identifier. Uniqueness alone admits fragments like
 * "tion h" (the middle of "function hookError"), which satisfy the gate and
 * tell a reader nothing.
 * @param {string} line
 * @param {string} anchor
 * @returns {boolean}
 */
export function anchorRespectsBoundaries(line, anchor) {
  if (anchor.length === 0) return false;
  const first = anchor[0];
  const last = anchor[anchor.length - 1];
  for (
    let i = line.indexOf(anchor);
    i !== -1;
    i = line.indexOf(anchor, i + 1)
  ) {
    const before = line[i - 1];
    const after = line[i + anchor.length];
    const startsInside =
      WORD.test(first) && before !== undefined && WORD.test(before);
    const endsInside =
      WORD.test(last) && after !== undefined && WORD.test(after);
    if (!startsInside && !endsInside) return true;
  }
  return false;
}

/**
 * Anchored and resolution citations are always checked -- an anchored citation
 * must validate and can never be ledgered, or the ledger becomes the escape
 * hatch for the check this gate exists to add.
 * A malformed citation is "checked" for the same reason an anchored one is:
 * it must be fixed, never ledgered. Ledgering it would let a near-miss anchored
 * citation buy permanent silence.
 * @param {Citation} citation
 * @param {string} root
 * @returns {"checked" | "unanchored" | "dead"}
 */
export function classify(citation, root) {
  if (citation.kind !== "legacy") return "checked";
  return targetExists(citation.path, root) ? "unanchored" : "dead";
}

/**
 * @param {Citation} citation
 * @param {string} root
 * @returns {{ ok: true, line?: number, unverified?: "historical" } | { ok: false, code: string, line?: number, message: string }}
 */
export function validate(citation, root) {
  if (citation.kind === "resolution") {
    if (hasDotSegment(citation.path)) {
      return {
        ok: false,
        code: "MALFORMED_RESOLUTION",
        message: `${citation.raw} is not repo-root-relative: a path segment escapes the root`,
      };
    }
    if (!historicalChecksAvailable(root)) {
      return { ok: true, unverified: "historical" };
    }
    const sha = /** @type {string} */ (citation.sha);
    if (!historicalTargetExists(sha, citation.path, root)) {
      return {
        ok: false,
        code: "MISSING_HISTORICAL_TARGET",
        message: `${citation.path} does not exist at ${sha}`,
      };
    }
    return { ok: true };
  }
  if (citation.kind === "legacy") return { ok: true };
  if (citation.kind === "malformed") {
    return citation.shape === "resolution"
      ? {
          ok: false,
          code: "MALFORMED_RESOLUTION",
          message:
            `${citation.raw} is not a valid resolution reference: expected ` +
            "a 40-hex object name followed by a path",
        }
      : {
          ok: false,
          code: "ANCHOR_MISSING",
          message: `${citation.raw} does not parse as \`path::anchor\` or \`path:N::anchor\``,
        };
  }
  const anchor = /** @type {string} */ (citation.anchor);
  if (anchor.length < MIN_ANCHOR) {
    return {
      ok: false,
      code: "ANCHOR_TOO_SHORT",
      message: `anchor "${anchor}" is shorter than ${MIN_ANCHOR} characters`,
    };
  }
  if (!targetExists(citation.path, root)) {
    return {
      ok: false,
      code: "MISSING_TARGET",
      message: `${citation.path} does not exist`,
    };
  }
  const hits = anchorLines(join(root, citation.path), anchor);
  if (hits.length === 0) {
    return {
      ok: false,
      code: "ANCHOR_NOT_FOUND",
      message: `anchor "${anchor}" does not occur in ${citation.path}`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ANCHOR_MULTIPLE",
      message:
        `anchor "${anchor}" occurs on ${hits.length} lines of ${citation.path} ` +
        `(${hits.join(", ")}); lengthen it`,
    };
  }
  const at = hits[0];
  if (
    !anchorRespectsBoundaries(
      readLines(join(root, citation.path))[at - 1] ?? "",
      anchor,
    )
  ) {
    return {
      ok: false,
      code: "ANCHOR_UNBOUNDED",
      message:
        `anchor "${anchor}" begins or ends inside an identifier in ` +
        `${citation.path}:${at}; extend it to a whole token`,
    };
  }
  if (citation.line === undefined) return { ok: true, line: at };
  if (citation.endLine !== undefined) {
    if (at < citation.line || at > citation.endLine) {
      return {
        ok: false,
        code: "RANGE_MISS",
        message: `cited ${citation.path}:${citation.line}-${citation.endLine}, anchor is at :${at}`,
      };
    }
    return { ok: true, line: at };
  }
  if (at !== citation.line) {
    return {
      ok: false,
      code: "LINE_MISMATCH",
      line: at,
      message: `cited ${citation.path}:${citation.line}, anchor is at :${at}`,
    };
  }
  return { ok: true, line: at };
}

/**
 * @typedef {{ unanchored: Record<string, Record<string, number>>,
 *             deadReferent: Record<string, Record<string, number>> }} Ledger
 */

/**
 * Preserve arbitrary string keys on an ordinary object, including keys handled
 * specially by legacy object accessors.
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @param {T} value
 * @returns {void}
 */
function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * @template T
 * @param {Record<string, T>} record
 * @param {string} key
 * @returns {T | undefined}
 */
function ownValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * @param {Citation[]} citations
 * @param {string} root
 * @returns {Ledger}
 */
export function buildLedger(citations, root) {
  /** @type {Ledger} */
  const ledger = { unanchored: {}, deadReferent: {} };
  for (const citation of citations) {
    const bucket = classify(citation, root);
    if (bucket === "checked") continue;
    const key = bucket === "unanchored" ? "unanchored" : "deadReferent";
    const from = displayPath(citation.file, root);
    let byFile = ownValue(ledger[key], from);
    if (byFile === undefined) {
      byFile = {};
      setOwn(ledger[key], from, byFile);
    }
    setOwn(byFile, citation.raw, (ownValue(byFile, citation.raw) ?? 0) + 1);
  }
  return ledger;
}

/**
 * Fail closed: an absent or malformed ledger is a failure, never an empty one.
 * @param {string} path
 * @returns {Ledger}
 */
export function readLedger(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be an object`);
  }
  // Exact schema, not a tolerant read. Defaulting a missing bucket to {} makes
  // a truncated ledger look like a clean one, and ignoring an extra bucket lets
  // debt be parked somewhere the drift comparison never looks. Both are the
  // fail-open shape the design forbids.
  const shaped = /** @type {Record<string, unknown>} */ (parsed);
  const keys = Object.keys(shaped).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "deadReferent" ||
    keys[1] !== "unanchored"
  ) {
    throw new Error(
      `${path} must declare exactly the buckets deadReferent and unanchored, found: ${keys.join(", ")}`,
    );
  }
  /** @type {Ledger} */
  const ledger = { unanchored: {}, deadReferent: {} };
  for (const bucket of /** @type {const} */ (["deadReferent", "unanchored"])) {
    const byFile = shaped[bucket];
    if (
      typeof byFile !== "object" ||
      byFile === null ||
      Array.isArray(byFile)
    ) {
      throw new Error(`${path}: bucket ${bucket} must be an object`);
    }
    for (const [file, tokens] of Object.entries(byFile)) {
      if (
        typeof tokens !== "object" ||
        tokens === null ||
        Array.isArray(tokens)
      ) {
        throw new Error(`${path}: ${bucket} entry ${file} must be an object`);
      }
      /** @type {Record<string, number>} */
      const counts = {};
      for (const [token, count] of Object.entries(tokens)) {
        if (
          typeof count !== "number" ||
          !Number.isInteger(count) ||
          count < 1
        ) {
          throw new Error(
            `${path}: ${bucket} ${file} ${token} must be a positive integer`,
          );
        }
        setOwn(counts, token, count);
      }
      setOwn(ledger[bucket], file, counts);
    }
  }
  return ledger;
}

/**
 * One line per disagreement, in either direction, in either bucket. A single
 * empty-array assertion over this covers all four symmetry rules at once, with
 * a message that names each disagreement rather than diffing two large objects.
 * @param {Ledger} observed
 * @param {Ledger} declared
 * @returns {string[]}
 */
export function ledgerDrift(observed, declared) {
  /** @type {string[]} */
  const drift = [];
  for (const bucket of /** @type {const} */ (["deadReferent", "unanchored"])) {
    const seen = observed[bucket] ?? {};
    const said = declared[bucket] ?? {};
    const files = new Set([...Object.keys(seen), ...Object.keys(said)]);
    for (const file of files) {
      const seenFile = ownValue(seen, file) ?? {};
      const saidFile = ownValue(said, file) ?? {};
      const tokens = new Set([
        ...Object.keys(seenFile),
        ...Object.keys(saidFile),
      ]);
      for (const token of tokens) {
        const seenCount = ownValue(seenFile, token) ?? 0;
        const saidCount = ownValue(saidFile, token) ?? 0;
        if (seenCount !== saidCount) {
          drift.push(
            `${bucket} ${file} \`${token}\`: ledger declares ${saidCount}, tree has ${seenCount}`,
          );
        }
      }
    }
  }
  return drift.sort();
}

/**
 * The only transformation the fixer permits: a single-line anchored citation
 * may take the line of its unique anchor. Ranges, missing targets, and
 * ambiguous anchors are left for human review.
 * @param {Citation[]} citations
 * @param {string} root
 * @returns {Array<{ file: string, lineNumber: number, column: number, from: string, to: string }>}
 */
export function fixEdits(citations, root) {
  /** @type {Array<{ file: string, lineNumber: number, column: number, from: string, to: string }>} */
  const edits = [];
  for (const citation of citations) {
    if (citation.kind !== "anchored") continue;
    if (citation.line === undefined) continue;
    if (citation.endLine !== undefined) continue;
    const verdict = validate(citation, root);
    if (verdict.ok || verdict.code !== "LINE_MISMATCH") continue;
    const at = /** @type {number} */ (verdict.line);
    const numberStart = citation.path.length + 2;
    const numberEnd = citation.raw.indexOf("::", numberStart);
    edits.push({
      file: citation.file,
      lineNumber: citation.lineNumber,
      column: citation.column,
      from: citation.raw,
      to:
        citation.raw.slice(0, numberStart) + at + citation.raw.slice(numberEnd),
    });
  }
  return edits;
}

/**
 * Applies edit spans against their original source lines. Same-line edits run
 * from right to left so replacing one span cannot shift the next span's
 * recorded column.
 * @param {ReturnType<typeof fixEdits>} edits
 * @returns {number}
 */
export function applyFixEdits(edits) {
  /** @type {Map<string, ReturnType<typeof fixEdits>>} */
  const byFile = new Map();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }
  for (const [file, list] of byFile) {
    const lines = readLines(file);
    for (const edit of [...list].sort((a, b) => b.column - a.column)) {
      const line = lines[edit.lineNumber - 1];
      lines[edit.lineNumber - 1] =
        line.slice(0, edit.column) +
        edit.to +
        line.slice(edit.column + edit.from.length);
    }
    writeFileSync(file, lines.join("\n"));
  }
  return byFile.size;
}
