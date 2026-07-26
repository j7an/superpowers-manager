import { execFile } from "node:child_process";
import { SafetyError } from "./safety-error.js";

export type GitResult =
  | {
      readonly status: number;
      readonly signal: null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: null;
      readonly signal: NodeJS.Signals;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface RunGitOptions {
  readonly cwd?: string;
}

export function runGit(
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        encoding: "utf8",
        maxBuffer: Infinity,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ status: 0, signal: null, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string;
          signal?: NodeJS.Signals | null;
        };
        if (typeof failure.code === "string") {
          const message =
            failure.code === "ENOENT"
              ? "required command not found: git"
              : `cannot run git: ${failure.message}`;
          reject(new SafetyError("git", message, { cause: error }));
          return;
        }
        const signal = failure.signal ?? null;
        if (signal !== null) {
          resolve({ status: null, signal, stdout, stderr });
          return;
        }
        resolve({
          status: typeof failure.code === "number" ? failure.code : 1,
          signal: null,
          stdout,
          stderr,
        });
      },
    );
  });
}
