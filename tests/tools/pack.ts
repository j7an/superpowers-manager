import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackEntry {
  filename: string;
  files: { path: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

export type PackReport = [PackEntry];

class PackFailure extends Error {}

const STATIC_ASSETS = [
  "config/upstream-ref",
  ".agents/plugins/marketplace.json",
  "plugins/superpowers/.codex-plugin/plugin.template.json",
  "README.md",
  "LICENSE",
] as const;

function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function canonicalize(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new PackFailure(`cannot resolve ${label}`);
  }
}

async function writeStageFile(path: string, data: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  } catch {
    throw new PackFailure(`cannot write staged package file: ${path}`);
  }
}

async function copyStageFile(source: string, target: string): Promise<void> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch {
    throw new PackFailure(`cannot stage package asset: ${source}`);
  }
}

function forwardDiagnostics(stdout: string, stderr: string): void {
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function readManifest(
  sourceRoot: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(sourceRoot, "package.json"), "utf8"),
    );
  } catch {
    throw new PackFailure("cannot read package manifest");
  }
  if (!isRecord(parsed)) {
    throw new PackFailure("package manifest must be a JSON object");
  }
  return parsed;
}

async function stageManifest(
  sourceRoot: string,
  packageRoot: string,
): Promise<void> {
  const manifest = await readManifest(sourceRoot);
  const staged = { ...manifest };
  if (isRecord(manifest.scripts)) {
    const scripts = { ...manifest.scripts };
    delete scripts.prepack;
    staged.scripts = scripts;
  }
  await writeStageFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(staged, null, 2)}\n`,
  );
}

async function createDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch {
    throw new PackFailure(`cannot create ${label}`);
  }
}

async function makeCliExecutable(packageRoot: string): Promise<void> {
  try {
    await chmod(join(packageRoot, "dist", "cli.js"), 0o755);
  } catch {
    throw new PackFailure("cannot make staged package CLI executable");
  }
}

function reportEntry(value: unknown): PackEntry {
  if (!isRecord(value) || typeof value.filename !== "string") {
    throw new PackFailure("package report has no valid artifact filename");
  }
  if (!Array.isArray(value.files)) {
    throw new PackFailure("package report has no valid file list");
  }
  const files: { path: string; [key: string]: unknown }[] = [];
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new PackFailure("package report has no valid file list");
    }
    files.push(file as { path: string; [key: string]: unknown });
  }
  return { ...value, filename: value.filename, files };
}

function parsePackReport(json: string): PackEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PackFailure("package report is not valid JSON");
  }
  if (Array.isArray(parsed) && parsed.length === 1)
    return reportEntry(parsed[0]);
  if (isRecord(parsed) && Object.keys(parsed).length === 1) {
    return reportEntry(Object.values(parsed)[0]);
  }
  throw new PackFailure("package report must contain exactly one artifact");
}

function safeFilename(filename: string): string {
  if (
    filename === "" ||
    filename === "." ||
    filename === ".." ||
    isAbsolute(filename) ||
    basename(filename) !== filename
  ) {
    throw new PackFailure("package report has an unsafe artifact filename");
  }
  return filename;
}

async function verifiedArtifact(
  packedRoot: string,
  filename: string,
): Promise<string> {
  const candidate = join(packedRoot, safeFilename(filename));
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    throw new PackFailure("packaged artifact could not be inspected");
  }
  if (!info.isFile()) {
    throw new PackFailure("packaged artifact is not a regular file");
  }
  const [resolvedPackedRoot, resolvedArtifact] = await Promise.all([
    canonicalize(packedRoot, "package artifact directory"),
    canonicalize(candidate, "packaged artifact"),
  ]);
  if (!isWithin(resolvedPackedRoot, resolvedArtifact)) {
    throw new PackFailure(
      "packaged artifact is outside the package artifact directory",
    );
  }
  return candidate;
}

async function removeDelivered(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    throw new PackFailure("cannot remove failed package output");
  }
}

async function cleanupStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true });
  } catch {
    throw new PackFailure("cannot remove package staging directory");
  }
}

export async function runPack(
  root: string,
  outDir: string,
): Promise<PackReport> {
  const managedSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
  type ManagedSignal = (typeof managedSignals)[number];
  let terminating: ManagedSignal | undefined;
  let activeChild: ChildProcess | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let childGroupUnconfirmed = false;
  let staging: string | undefined;
  let deliveredPath: string | undefined;
  let report: PackReport | undefined;
  const failures: string[] = [];

  function checkCancellation(): void {
    if (terminating !== undefined) {
      throw new PackFailure(`package operation cancelled by ${terminating}`);
    }
  }

  function signalOwnedGroup(signal: NodeJS.Signals): void {
    const pid = activeChild?.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") activeChild?.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )) {
        failures.push("cannot signal package child process group");
      }
    }
  }

  function interruptChild(signal: NodeJS.Signals): void {
    if (activeChild === undefined) return;
    signalOwnedGroup(signal);
    escalation ??= setTimeout(() => signalOwnedGroup("SIGKILL"), 1000);
  }

  function requestTermination(signal: ManagedSignal): void {
    if (terminating !== undefined) return;
    terminating = signal;
    interruptChild(signal);
  }

  async function confirmOwnedGroupExit(pid: number | undefined): Promise<void> {
    if (process.platform === "win32" || pid === undefined) return;
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          return;
        }
      }
      if (Date.now() >= deadline) {
        childGroupUnconfirmed = true;
        throw new PackFailure(
          "cannot confirm package child process group exit",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async function runStep(
    command: string,
    args: readonly string[],
    cwd: string,
    label: string,
  ): Promise<string> {
    checkCancellation();
    let stdout = "";
    let stderr = "";
    let startFailed = false;
    let groupPid: number | undefined;
    try {
      const code = await new Promise<number | null>(
        (resolveStep, rejectStep) => {
          let child;
          try {
            child = spawn(command, args, {
              cwd,
              detached: process.platform !== "win32",
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch {
            rejectStep(new PackFailure(`cannot start ${label}`));
            return;
          }
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", () => {
            startFailed = true;
          });
          // Keep the group identity after its leader and streams close: a
          // descendant can still write in staging until group death is proved.
          child.once("exit", () => interruptChild(terminating ?? "SIGTERM"));
          child.once("close", (code) => resolveStep(code));
          activeChild = child;
          groupPid = child.pid;
        },
      );
      await confirmOwnedGroupExit(groupPid);
      checkCancellation();
      if (startFailed) throw new PackFailure(`cannot start ${label}`);
      if (code !== 0) {
        forwardDiagnostics(stdout, stderr);
        throw new PackFailure(`${label} failed`);
      }
      return stdout;
    } finally {
      if (escalation !== undefined) clearTimeout(escalation);
      escalation = undefined;
      activeChild = undefined;
    }
  }

  async function deliverArtifact(
    target: string,
    stagedTarball: string,
  ): Promise<void> {
    checkCancellation();
    try {
      const output = await open(target, "wx", 0o600);
      deliveredPath = target;
      try {
        checkCancellation();
        const bytes = await readFile(stagedTarball);
        checkCancellation();
        await output.writeFile(bytes);
        checkCancellation();
      } finally {
        await output.close();
      }
      checkCancellation();
    } catch (error) {
      if (error instanceof PackFailure) throw error;
      throw new PackFailure("cannot deliver packaged artifact");
    }
  }

  async function rollbackOutput(): Promise<void> {
    if (deliveredPath === undefined) return;
    try {
      await removeDelivered(deliveredPath);
    } catch {
      failures.push("cannot remove failed package output");
    }
    deliveredPath = undefined;
  }

  const handlers = managedSignals.map((signal) => {
    const handler = () => requestTermination(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    try {
      const sourceRoot = await canonicalize(root, "package source checkout");
      checkCancellation();
      const destinationRoot = await canonicalize(
        outDir,
        "package output directory",
      );
      checkCancellation();
      const temporaryParent = await canonicalize(
        tmpdir(),
        "package temporary directory",
      );
      checkCancellation();
      try {
        const info = await stat(destinationRoot);
        checkCancellation();
        if (!info.isDirectory())
          throw new PackFailure("package output is not a directory");
      } catch (error) {
        if (error instanceof PackFailure) throw error;
        throw new PackFailure("package output is not a directory");
      }
      if (isWithin(sourceRoot, temporaryParent)) {
        throw new PackFailure(
          "package temporary directory must be outside the source checkout",
        );
      }
      try {
        await access(destinationRoot, constants.W_OK | constants.X_OK);
      } catch {
        throw new PackFailure("package output directory is not writable");
      }
      checkCancellation();
      try {
        staging = await mkdtemp(join(temporaryParent, "spw-pack-"));
      } catch {
        throw new PackFailure("cannot create package staging directory");
      }
      checkCancellation();
      const packageRoot = join(staging, "package");
      const packedRoot = join(staging, "packed");
      await createDirectory(packageRoot, "package staging directory");
      checkCancellation();
      await createDirectory(packedRoot, "package artifact directory");
      checkCancellation();
      await stageManifest(sourceRoot, packageRoot);
      checkCancellation();
      for (const asset of STATIC_ASSETS) {
        await copyStageFile(join(sourceRoot, asset), join(packageRoot, asset));
        checkCancellation();
      }
      await runStep(
        join(sourceRoot, "node_modules", ".bin", "tsc"),
        [
          "-p",
          join(sourceRoot, "tsconfig.json"),
          "--noEmit",
          "false",
          "--noEmitOnError",
          "true",
          "--outDir",
          join(packageRoot, "dist"),
        ],
        sourceRoot,
        "compile package sources",
      );
      await makeCliExecutable(packageRoot);
      checkCancellation();
      const packJson = await runStep(
        "npm",
        ["pack", "--json", "--pack-destination", packedRoot],
        packageRoot,
        "pack staged package",
      );
      const metadataPath = join(staging, "pack.json");
      try {
        await writeFile(metadataPath, packJson);
      } catch {
        throw new PackFailure("cannot write package metadata");
      }
      checkCancellation();
      await runStep(
        "sh",
        [join(sourceRoot, "tests", "assert_pack_contents.sh"), metadataPath],
        sourceRoot,
        "validate package contents",
      );
      const entry = parsePackReport(packJson);
      const filename = safeFilename(entry.filename);
      const stagedTarball = await verifiedArtifact(packedRoot, filename);
      checkCancellation();
      await deliverArtifact(join(destinationRoot, filename), stagedTarball);
      report = [{ ...entry, filename }];
    } catch (error) {
      failures.push(
        error instanceof PackFailure
          ? error.message
          : "cannot package source checkout",
      );
    }
    if (failures.length > 0 || terminating !== undefined)
      await rollbackOutput();
    if (staging !== undefined && !childGroupUnconfirmed) {
      try {
        await cleanupStaging(staging);
      } catch {
        failures.push("cannot remove package staging directory");
      }
    }
    if (failures.length > 0 || terminating !== undefined)
      await rollbackOutput();
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (terminating !== undefined) {
    if (failures.length > 0) process.stderr.write(failures.join("\n") + "\n");
    process.kill(process.pid, terminating);
    await new Promise<never>(() => {});
  }
  if (failures.length > 0) throw new PackFailure(failures.join("\n"));
  if (report === undefined)
    throw new PackFailure("cannot package source checkout");
  return report;
}

function usage(): void {
  process.stderr.write("usage: pack.ts --out-dir <directory>\n");
}

async function isEntryPoint(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (await realpath(entry)) === import.meta.filename;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out-dir" || args[1] === "") {
    usage();
    process.exitCode = 2;
    return;
  }
  const root = fileURLToPath(new URL("../..", import.meta.url));
  try {
    const report = await runPack(root, args[1]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (error instanceof PackFailure) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("cannot package source checkout\n");
    }
    process.exitCode = 1;
  }
}

if (await isEntryPoint()) await main();
