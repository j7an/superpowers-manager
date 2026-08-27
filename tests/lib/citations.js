// @ts-check
// Citation scanner, resolver and ledger builder. Pure: no assertions, no
// writes, no process exit. The suite asserts over it and the tool drives it,
// so both compute line numbers through exactly one implementation.
//
// A citation is recognized ONLY inside a comment. Every citation in the
// enforced corpus was measured comment-leading at the plan's base, with none
// in a string literal, so no tokenizer is required. Known blind spot: a
// citation-shaped token inside a multi-line template literal can be read as a
// comment citation. That yields a false positive, which the ledger absorbs.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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
const CANDIDATE = new RegExp(
  String.raw`^(?:git show\s+\S+:\S|${PATH}(?::.*)?::)`,
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
 * @returns {{ ok: true, line?: number } | { ok: false, code: string, line?: number, message: string }}
 */
export function validate(citation, root) {
  // Shape was already proven by the resolution pattern; Git is never executed.
  if (citation.kind === "resolution") {
    return hasDotSegment(citation.path)
      ? {
          ok: false,
          code: "MALFORMED_RESOLUTION",
          message: `${citation.raw} is not repo-root-relative: a path segment escapes the root`,
        }
      : { ok: true };
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
