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
import { basename, isAbsolute, join, relative, sep } from "node:path";

export const MIN_ANCHOR = 3;
const WIDEN_LIMIT = 5;

/** The enforced corpus, declared and never globbed. */
export const CORPUS_DIRS = ["src", "tests"] as const;

const PATH_PART = String.raw`[A-Za-z0-9_.-]+`;
const DOTTED_PATH = String.raw`(?:${PATH_PART}\/)*${PATH_PART}\.[A-Za-z0-9]+`;
const EXTENSIONLESS_PATH = String.raw`(?:${PATH_PART}\/)+${PATH_PART}`;
const RESOLUTION_PATH = String.raw`(?:${DOTTED_PATH}|${EXTENSIONLESS_PATH})`;
const PATH = RESOLUTION_PATH;
const ANCHORED = new RegExp(
  String.raw`^(${PATH})(?::(\d+)(?:-(\d+))?)?::(.+)$`,
);
// The line or range is admissible ONLY with an anchor after it. A trailing
// `:N` alone would be a line claim nothing can check, which is the fail-open
// shape this grammar exists to refuse; it stays malformed.
const RESOLUTION = new RegExp(
  String.raw`^git show ([0-9a-f]{40}):(${RESOLUTION_PATH})(?:(?::(\d+)(?:-(\d+))?)?::(.+))?$`,
);
const LEGACY = new RegExp(String.raw`(${PATH}):(\d+)(?:-(\d+))?`, "g");
const BACKTICKED = /`([^`\n]+)`/g;
// A backticked token that LOOKS like a citation but does not parse is retained
// as MALFORMED rather than dropped. Dropping it is fail-open: a near-miss
// anchored citation would be invisible to the gate AND absent from the ledger,
// which is a bypass, not a gap. Plain `path:N` is deliberately excluded --
// that is a legitimate legacy citation and the legacy pass owns it.
// The file-like fallback is intentionally broader than PATH only for candidate
// retention: either a plausible dotted filename or a slash-bearing path before
// `::` is enough, independently of valid PATH characters. ANCHORED remains the
// sole valid-path parser.
const FILELIKE_CANDIDATE = String.raw`(?:.+\.[^\s:]+|(?:[^\s:]+\/)+[^\s:]+)`;
const CANDIDATE = new RegExp(
  String.raw`^(?:git show\s+\S+:\S|${FILELIKE_CANDIDATE}(?::.*)?::|:\d+(?:-\d+)?$)`,
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
 */
export function commentText(
  line: string,
): { text: string; offset: number } | undefined {
  const lead = line.trimStart();
  if (lead.startsWith("//") || lead.startsWith("*") || lead.startsWith("/*")) {
    return { text: line, offset: 0 };
  }

  let quote: string | undefined;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  let expressionCanStart = true;

  let pendingControl: "control" | "for" | undefined;

  const controlParens: Array<"control" | "for" | "for-of" | undefined> = [];
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

      const forOfSeparator: boolean =
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
      const postfix: boolean = !expressionCanStart;
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

function readLines(path: string) {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
}

export function listSources(dirs: readonly string[], root: string): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
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

export type Citation = {
  kind: "anchored" | "legacy" | "resolution" | "malformed";
  shape?: "anchored" | "resolution";
  file: string;
  lineNumber: number;
  column: number;
  raw: string;
  path: string;
  line?: number;
  endLine?: number;
  anchor?: string;
  sha?: string;
};

function parseComment(
  text: string,
  offset: number,
  file: string,
  lineNumber: number,
): Citation[] {
  const found: Citation[] = [];

  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(BACKTICKED)) {
    const inner = m[1];
    const at = m.index as number;
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
        line: res[3] === undefined ? undefined : Number(res[3]),
        endLine: res[4] === undefined ? undefined : Number(res[4]),
        anchor: res[5],
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
      column: offset + (m.index as number),
      raw: m[0],
      path: m[1],
      line: Number(m[2]),
      endLine: m[3] === undefined ? undefined : Number(m[3]),
    });
  }
  return found;
}

export function scan(files: string[]): Citation[] {
  const out: Citation[] = [];
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

export function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

export function targetExists(path: string, root: string): boolean {
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
 */
export function historicalTargetExists(
  sha: string,
  path: string,
  root: string,
): boolean {
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
 */
export function historicalChecksAvailable(root: string): boolean {
  return existsSync(join(root, ".git"));
}

export function displayPath(file: string, root: string): string {
  return relative(root, file);
}

function anchorLinesIn(lines: readonly string[], anchor: string): number[] {
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (line.includes(anchor)) hits.push(index + 1);
  });
  return hits;
}

/**
 * Every line of `path` containing `anchor`, one-based.
 */
export function anchorLines(path: string, anchor: string): number[] {
  return anchorLinesIn(readLines(path), anchor);
}

/**
 * The content of path as it stood in object sha, or null when it cannot be
 * read. Callers have already established existence with historicalTargetExists,
 * so null here means the object could not be streamed, not that it is absent.
 */
export function historicalLines(
  sha: string,
  path: string,
  root: string,
): string[] | null {
  const result = spawnSync("git", ["show", `${sha}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout.split("\n");
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * True when `anchor` occurs in `line` at least once without beginning or
 * ending inside an identifier. Uniqueness alone admits fragments like
 * "tion h" (the middle of "function hookError"), which satisfy the gate and
 * tell a reader nothing.
 */
export function anchorRespectsBoundaries(
  line: string,
  anchor: string,
): boolean {
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

const DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)|^\s*([A-Za-z_$][\w$]*)\s*\(\)\s*\{|^\s*def\s+([A-Za-z_$]\w*)/;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Anchor candidates for one line in the order spec §5.1 requires: the declared
 * name, then full identifiers longest-first, then the shortest prefix of the
 * trimmed line that ends on a token boundary. The prefix tier is the "shortest
 * boundary-respecting clause" of that sentence and stays last.
 */
function anchorCandidates(line: string): string[] {
  const out: string[] = [];
  const declared = DECLARATION.exec(line);
  if (declared !== null) out.push(declared[1] ?? declared[2] ?? declared[3]);
  const identifiers = [...line.matchAll(IDENTIFIER)]
    .map((m) => m[0])
    .filter((s) => s.length >= MIN_ANCHOR)
    .sort((a, b) => b.length - a.length);
  out.push(...identifiers);
  const trimmed = line.trim();
  for (let length = MIN_ANCHOR; length <= trimmed.length; length += 1) {
    if (
      length < trimmed.length &&
      WORD.test(trimmed[length - 1]) &&
      WORD.test(trimmed[length])
    )
      continue;
    out.push(trimmed.slice(0, length));
  }
  return out.filter(
    (c) => c !== undefined && c.length >= MIN_ANCHOR && c === c.trim(),
  );
}

function occursOnce(lines: string[], candidate: string): boolean {
  let seen = 0;
  for (const line of lines) {
    if (!line.includes(candidate)) continue;
    seen += 1;
    if (seen > 1) return false;
  }
  return seen === 1;
}

function anchorForLine(lines: string[], index: number): string | null {
  const line = lines[index];
  if (line === undefined) return null;
  for (const candidate of anchorCandidates(line))
    if (
      occursOnce(lines, candidate) &&
      anchorRespectsBoundaries(line, candidate)
    )
      return candidate;
  return null;
}

/**
 * The first legible unique anchor for the inclusive 1-based span, widening
 * outward by up to WIDEN_LIMIT lines when the span itself yields none. Widening
 * changes what is cited, so the caller is told the span it must write.
 */
export function suggestAnchor(
  lines: string[],
  start: number,
  end: number,
): { anchor: string; line: number; endLine: number } | null {
  for (let n = start; n <= end; n += 1) {
    const anchor = anchorForLine(lines, n - 1);
    if (anchor !== null) return { anchor, line: start, endLine: end };
  }
  for (let distance = 1; distance <= WIDEN_LIMIT; distance += 1) {
    const above = anchorForLine(lines, start - distance - 1);
    if (above !== null)
      return {
        anchor: above,
        line: Math.max(1, start - distance),
        endLine: end,
      };
    const below = anchorForLine(lines, end + distance - 1);
    if (below !== null)
      return { anchor: below, line: start, endLine: end + distance };
  }
  return null;
}

/**
 * One proposal line per legacy citation. A proposal is a citation body ready to
 * paste between backticks; it is never applied. `at` resolves dead referents
 * against one historical object, and applies ONLY to citations whose token path
 * is that path or its basename -- an object override that matched every dead
 * path would silently resolve one file's line numbers against another's text.
 */
export function suggest(
  citations: Citation[],
  root: string,
  at?: { sha: string; path: string },
): string[] {
  const out: string[] = [];

  const cache: Map<string, string[] | null> = new Map();
  for (const citation of citations) {
    if (citation.kind !== "legacy") continue;
    const line = citation.line as number;
    const where = `${displayPath(citation.file, root)}:${citation.lineNumber}`;
    const token = `${citation.path}:${line}${
      citation.endLine === undefined ? "" : `-${citation.endLine}`
    }`;
    const live = classify(citation, root) === "unanchored";
    const named =
      at !== undefined &&
      (citation.path === at.path || citation.path === basename(at.path));
    if (!live && !named) {
      out.push(`${where}\t${token}\tDEAD (rerun with --at <sha>:<path>)`);
      continue;
    }
    const key = live ? `live:${citation.path}` : `hist:${at?.sha}:${at?.path}`;
    if (!cache.has(key))
      cache.set(
        key,
        live
          ? readLines(join(root, citation.path))
          : historicalLines(
              (at as { sha: string }).sha,
              (at as { path: string }).path,
              root,
            ),
      );
    const lines = cache.get(key) ?? null;
    if (lines === null) {
      out.push(`${where}\t${token}\tNO SOURCE`);
      continue;
    }
    const picked = suggestAnchor(lines, line, citation.endLine ?? line);
    if (picked === null) {
      out.push(`${where}\t${token}\tNO ANCHOR`);
      continue;
    }
    const span =
      picked.line === picked.endLine
        ? `${picked.line}`
        : `${picked.line}-${picked.endLine}`;
    const body = live
      ? `${citation.path}:${span}::${picked.anchor}`
      : `git show ${(at as { sha: string }).sha}:${
          (at as { path: string }).path
        }:${span}::${picked.anchor}`;
    const widened =
      picked.line !== line || picked.endLine !== (citation.endLine ?? line);
    out.push(`${where}\t${token}\t${body}${widened ? "  [WIDENED]" : ""}`);
  }
  return out;
}

/**
 * The single anchor rule, applied to live file content or to a historical
 * blob. One implementation so the two paths cannot drift apart.
 */
function checkAnchor(
  lines: readonly string[],
  citation: Citation,
  label: string,
):
  | { ok: true; line: number }
  | { ok: false; code: string; message: string; line?: number } {
  const anchor = citation.anchor as string;
  const hits = anchorLinesIn(lines, anchor);
  if (hits.length === 0) {
    return {
      ok: false,
      code: "ANCHOR_NOT_FOUND",
      message: `anchor "${anchor}" does not occur in ${label}`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      code: "ANCHOR_MULTIPLE",
      message:
        `anchor "${anchor}" occurs on ${hits.length} lines of ${label} ` +
        `(${hits.join(", ")}); lengthen it`,
    };
  }
  const at = hits[0];
  if (!anchorRespectsBoundaries(lines[at - 1] ?? "", anchor)) {
    return {
      ok: false,
      code: "ANCHOR_UNBOUNDED",
      message:
        `anchor "${anchor}" begins or ends inside an identifier in ` +
        `${label}:${at}; extend it to a whole token`,
    };
  }
  if (citation.line === undefined) return { ok: true, line: at };
  if (citation.endLine !== undefined) {
    if (at < citation.line || at > citation.endLine) {
      return {
        ok: false,
        code: "RANGE_MISS",
        message: `cited ${label}:${citation.line}-${citation.endLine}, anchor is at :${at}`,
      };
    }
    return { ok: true, line: at };
  }
  if (at !== citation.line) {
    return {
      ok: false,
      code: "LINE_MISMATCH",
      line: at,
      message: `cited ${label}:${citation.line}, anchor is at :${at}`,
    };
  }
  return { ok: true, line: at };
}

/**
 * Anchored and resolution citations are always checked -- an anchored citation
 * must validate and can never be ledgered, or the ledger becomes the escape
 * hatch for the check this gate exists to add.
 * A malformed citation is "checked" for the same reason an anchored one is:
 * it must be fixed, never ledgered. Ledgering it would let a near-miss anchored
 * citation buy permanent silence.
 */
export function classify(
  citation: Citation,
  root: string,
): "checked" | "unanchored" | "dead" {
  if (citation.kind !== "legacy") return "checked";
  return targetExists(citation.path, root) ? "unanchored" : "dead";
}

/**
 * Remove only the citation token that would otherwise prove its own anchor.
 * A mismatch leaves the lines unchanged, preserving fail-closed uniqueness.
 */
function withoutCitationEcho(
  lines: readonly string[],
  citation: Citation,
  target: string,
): string[] {
  try {
    if (realpathSync(citation.file) !== realpathSync(target)) return [...lines];
  } catch {
    return [...lines];
  }
  const searchable = [...lines];
  const index = citation.lineNumber - 1;
  const source = searchable[index];
  if (
    source?.slice(citation.column, citation.column + citation.raw.length) !==
    citation.raw
  ) {
    return searchable;
  }
  searchable[index] =
    source.slice(0, citation.column) +
    " ".repeat(citation.raw.length) +
    source.slice(citation.column + citation.raw.length);
  return searchable;
}

export function validate(
  citation: Citation,
  root: string,
):
  | { ok: true; line?: number; unverified?: "historical" }
  | { ok: false; code: string; line?: number; message: string } {
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
    const sha = citation.sha as string;
    if (!historicalTargetExists(sha, citation.path, root)) {
      return {
        ok: false,
        code: "MISSING_HISTORICAL_TARGET",
        message: `${citation.path} does not exist at ${sha}`,
      };
    }
    if (citation.anchor === undefined) return { ok: true };
    if (citation.anchor.length < MIN_ANCHOR) {
      return {
        ok: false,
        code: "ANCHOR_TOO_SHORT",
        message: `anchor "${citation.anchor}" is shorter than ${MIN_ANCHOR} characters`,
      };
    }
    const lines = historicalLines(sha, citation.path, root);
    if (lines === null) {
      return {
        ok: false,
        code: "MISSING_HISTORICAL_TARGET",
        message: `${citation.path} at ${sha} could not be read`,
      };
    }
    return checkAnchor(lines, citation, `${citation.path} at ${sha}`);
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
  const anchor = citation.anchor as string;
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
  const target = join(root, citation.path);
  const lines = withoutCitationEcho(readLines(target), citation, target);
  return checkAnchor(lines, citation, citation.path);
}

export type Ledger = {
  unanchored: Record<string, Record<string, number>>;
  deadReferent: Record<string, Record<string, number>>;
};

/**
 * Preserve arbitrary string keys on an ordinary object, including keys handled
 * specially by legacy object accessors.
 */
function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function buildLedger(citations: Citation[], root: string): Ledger {
  const ledger: Ledger = { unanchored: {}, deadReferent: {} };
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
 */
export function readLedger(path: string): Ledger {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }

  let parsed: unknown;
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
  const shaped = parsed as Record<string, unknown>;
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

  const ledger: Ledger = { unanchored: {}, deadReferent: {} };
  for (const bucket of ["deadReferent", "unanchored"] as const) {
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

      const counts: Record<string, number> = {};
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
 */
export function ledgerDrift(observed: Ledger, declared: Ledger): string[] {
  const drift: string[] = [];
  for (const bucket of ["deadReferent", "unanchored"] as const) {
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
 */
export function fixEdits(
  citations: Citation[],
  root: string,
): Array<{
  file: string;
  lineNumber: number;
  column: number;
  from: string;
  to: string;
}> {
  const edits: Array<{
    file: string;
    lineNumber: number;
    column: number;
    from: string;
    to: string;
  }> = [];
  for (const citation of citations) {
    if (citation.kind !== "anchored") continue;
    if (citation.line === undefined) continue;
    if (citation.endLine !== undefined) continue;
    const verdict = validate(citation, root);
    if (verdict.ok || verdict.code !== "LINE_MISMATCH") continue;
    const at = verdict.line as number;
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
 */
export function applyFixEdits(edits: ReturnType<typeof fixEdits>): number {
  const byFile: Map<string, ReturnType<typeof fixEdits>> = new Map();
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
