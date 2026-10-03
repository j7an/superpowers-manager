import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  failureResult,
  successResult,
} from "../../../../src/adapter-result.ts";
import type { RunHermes } from "../../../../src/harnesses/hermes/native.ts";
import type { HermesPaths } from "../../../../src/harnesses/hermes/paths.ts";

export interface FakeHermes {
  readonly run: RunHermes;
  readonly calls: string[];
  failOn: string | null;
}

export function fakeHermes(paths: HermesPaths): FakeHermes {
  const failed = () =>
    failureResult(
      "hermes-command",
      "nonzero-exit",
      "Hermes command exited with status 1",
      [],
      [],
    );
  const fake: FakeHermes = {
    calls: [],
    failOn: null,
    run: async (args) => {
      const command = args.join(" ");
      fake.calls.push(command);
      if (
        (fake.failOn !== null && command.startsWith(fake.failOn)) ||
        ![
          "plugins enable superpowers",
          "plugins disable superpowers",
          "plugins remove superpowers",
        ].includes(command)
      )
        return failed();
      const config = join(paths.hermesHome, "config.yaml");
      const document = existsSync(config)
        ? parseDocument(readFileSync(config, "utf8"))
        : parseDocument("{}");
      const value = document.toJS() as {
        plugins?: { enabled?: unknown[]; disabled?: unknown[] };
      };
      const plugins = value.plugins ?? {};
      const enabled = Array.isArray(plugins.enabled)
        ? plugins.enabled.filter((name) => name !== "superpowers")
        : [];
      const disabled = Array.isArray(plugins.disabled)
        ? plugins.disabled.filter((name) => name !== "superpowers")
        : [];
      if (command === "plugins enable superpowers") enabled.push("superpowers");
      else if (command === "plugins disable superpowers")
        disabled.push("superpowers");
      else rmSync(paths.pluginRoot, { recursive: true, force: true });
      value.plugins = { ...plugins, enabled, disabled };
      mkdirSync(paths.hermesHome, { recursive: true });
      writeFileSync(config, stringify(value));
      return successResult("hermes-command", { stdout: "" }, []);
    },
  };
  return fake;
}
