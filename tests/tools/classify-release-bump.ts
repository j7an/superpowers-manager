import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const BOT_LOGIN = "shared-workflows-release-bot[bot]";
const BOT_ID = "275375463";
const BUMP_CONFIG = { files: [{ path: "package.json", field: "version" }] };
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface ClassificationInput {
  cwd: string;
  eventName: string;
  actor: string;
  actorId: string;
  event: unknown;
}

export interface Classification {
  skipTests: boolean;
  reason:
    | "ordinary-event"
    | "identity-mismatch"
    | "unverified-change"
    | "inspection-failed"
    | "verified-release-bump";
}

function result(reason: Classification["reason"]): Classification {
  return { skipTests: reason === "verified-release-bump", reason };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value) && !/^0{40}$/.test(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function packageWithoutVersion(
  value: unknown,
): Record<string, unknown> | undefined {
  const parsed = record(value);
  if (parsed === undefined || typeof parsed.version !== "string")
    return undefined;
  const { version: _version, ...remaining } = parsed;
  return remaining;
}

function increasingVersion(before: unknown, after: unknown): boolean {
  if (typeof before !== "string" || typeof after !== "string") return false;
  const beforeMatch = VERSION.exec(before);
  const afterMatch = VERSION.exec(after);
  if (beforeMatch === null || afterMatch === null) return false;
  for (let index = 1; index <= 3; index += 1) {
    const beforePart = BigInt(beforeMatch[index]);
    const afterPart = BigInt(afterMatch[index]);
    if (afterPart > beforePart) return true;
    if (afterPart < beforePart) return false;
  }
  return false;
}

function blobAt(
  git: (...args: string[]) => string,
  revision: string,
  path: string,
) {
  const entry = git("ls-tree", revision, "--", path);
  const match = /^(100644) blob [0-9a-f]{40}\tpackage\.json$/.exec(
    entry.trim(),
  );
  if (path === "package.json") return match !== null;
  return /^100[0-7]{3} blob [0-9a-f]{40}\t\.version-bump\.json$/.test(
    entry.trim(),
  );
}

function hasOnlyVerifiedVersionChange(
  input: ClassificationInput,
  before: string,
  after: string,
) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  const head = git("rev-parse", "HEAD").trim();
  const lineage = git("rev-list", "--parents", "-n", "1", after)
    .trim()
    .split(" ");
  if (head !== after || lineage.length !== 2 || lineage[1] !== before)
    return false;
  const paths = git(
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "-z",
    before,
    after,
    "--",
  );
  if (paths !== "package.json\0") return false;
  if (
    !blobAt(git, before, "package.json") ||
    !blobAt(git, after, "package.json")
  )
    return false;
  if (!blobAt(git, before, ".version-bump.json")) return false;
  const beforeConfig = parseJson(git("show", `${before}:.version-bump.json`));
  if (!isDeepStrictEqual(beforeConfig, BUMP_CONFIG)) return false;

  const beforePackage = parseJson(git("show", `${before}:package.json`));
  const afterPackage = parseJson(git("show", `${after}:package.json`));
  const beforeWithoutVersion = packageWithoutVersion(beforePackage);
  const afterWithoutVersion = packageWithoutVersion(afterPackage);
  if (beforeWithoutVersion === undefined || afterWithoutVersion === undefined)
    return false;
  if (!isDeepStrictEqual(beforeWithoutVersion, afterWithoutVersion))
    return false;
  return increasingVersion(
    record(beforePackage)?.version,
    record(afterPackage)?.version,
  );
}

export function classifyReleaseBump(
  input: ClassificationInput,
): Classification {
  if (input.eventName !== "push") return result("ordinary-event");
  if (input.actor !== BOT_LOGIN || input.actorId !== BOT_ID)
    return result("identity-mismatch");
  const event = record(input.event);
  if (event === undefined) return result("unverified-change");
  const sender = record(event.sender);
  if (
    sender === undefined ||
    sender.login !== BOT_LOGIN ||
    sender.id !== Number(BOT_ID) ||
    sender.type !== "Bot"
  ) {
    return result("identity-mismatch");
  }
  if (
    event.ref !== "refs/heads/main" ||
    event.forced !== false ||
    event.created !== false ||
    event.deleted !== false ||
    !validSha(event.before) ||
    !validSha(event.after)
  ) {
    return result("unverified-change");
  }
  try {
    return hasOnlyVerifiedVersionChange(input, event.before, event.after)
      ? result("verified-release-bump")
      : result("unverified-change");
  } catch {
    return result("inspection-failed");
  }
}

function summary(reason: Classification["reason"]): string {
  const explanation: Record<Classification["reason"], string> = {
    "ordinary-event":
      "Release-bump test skip disabled: normal CI owns validation because this is not a push event.",
    "identity-mismatch":
      "Release-bump test skip disabled: normal CI owns validation because the event identity is not the release bot.",
    "unverified-change":
      "Release-bump test skip disabled: normal CI owns validation because the pushed change is not a verified release bump.",
    "inspection-failed":
      "Release-bump test skip disabled: normal CI owns validation because immutable Git inspection failed.",
    "verified-release-bump":
      "Release-bump test skip enabled: Release owns validation for this verified release bump.",
  };
  return `${explanation[reason]}\n`;
}

function main() {
  let event: unknown = null;
  try {
    event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
    );
  } catch {
    // Event parsing is intentionally fail-closed below.
  }
  const classification = classifyReleaseBump({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    actor: process.env.GITHUB_ACTOR ?? "",
    actorId: process.env.GITHUB_ACTOR_ID ?? "",
    event,
  });
  try {
    appendFileSync(
      process.env.GITHUB_OUTPUT ?? "",
      `skip_tests=${classification.skipTests}\n`,
    );
  } catch {
    console.error("release-bump classifier: could not write GITHUB_OUTPUT");
    process.exitCode = 1;
    return;
  }
  try {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY ?? "",
      summary(classification.reason),
    );
  } catch {
    console.error(
      "release-bump classifier: could not write GITHUB_STEP_SUMMARY",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
