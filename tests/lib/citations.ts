// Citation scanner, resolver and bounded fixer. No assertions
// or process exit; applyFixEdits is the only writer. The suite asserts over it
// and the tool drives it, so both compute line numbers through exactly one
// implementation.
//
// A citation is recognized ONLY inside a comment. Every citation in the
// enforced corpus was measured comment-leading at the plan's base, with none
// in a string literal, so no tokenizer is required. Known blind spot: a
// citation-shaped token inside a multi-line template literal can be read as a
// comment citation.

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

const MIN_ANCHOR = 3;

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
// anchored citation would be invisible to the gate. Plain `path:N` is deliberately excluded --
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

function hasDotSegment(path: string): boolean {
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
function historicalTargetExists(
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
function historicalChecksAvailable(root: string): boolean {
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
 * The content of path as it stood in object sha, or null when it cannot be
 * read. Callers have already established existence with historicalTargetExists,
 * so null here means the object could not be streamed, not that it is absent.
 */
function historicalLines(
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
function anchorRespectsBoundaries(line: string, anchor: string): boolean {
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
 * must validate.
 * A malformed citation is "checked" for the same reason an anchored one is:
 * it must be fixed.
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
  if (citation.kind === "legacy") {
    return {
      ok: false,
      code: "UNANCHORED_CITATION",
      message:
        citation.path +
        " requires an anchored citation or a Git history reference",
    };
  }
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
