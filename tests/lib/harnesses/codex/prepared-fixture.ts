import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexCandidate } from "../../../../src/harnesses/codex/prepare.ts";
import type { PreparedArtifact } from "../../../../src/harness.ts";
import { nativeSelection } from "../pi/package-fixture.ts";

// Command tests exercise the real prepared reader against an assessed native
// skill fixture, while scripting only their external Codex operation results.
export async function writeQualifiedCodexFixture(
  root: string,
  commit: string,
  source: string,
): Promise<PreparedArtifact> {
  const upstream = await mkdtemp(join(tmpdir(), "spw-command-native-"));
  try {
    await mkdir(join(upstream, "skills/using-superpowers"), {
      recursive: true,
    });
    await writeFile(
      join(upstream, "skills/using-superpowers/SKILL.md"),
      "---\nname: using-superpowers\ndescription: Native fixture skill\n---\nFixture body.\n",
    );
    for (const name of ["LICENSE", "README.md", "CODE_OF_CONDUCT.md"])
      await writeFile(join(upstream, name), "fixture\n");
    const template = join(upstream, "template.json");
    await writeFile(
      template,
      JSON.stringify({
        name: "superpowers",
        description: "Fixture package",
        version: "1.0.0",
        skills: "./skills/",
      }),
    );
    const result = await prepareCodexCandidate(
      {
        upstreamRoot: upstream,
        workspaceRoot: upstream,
        candidateRoot: root,
        selection: nativeSelection(commit, source),
      },
      { root: upstream, env: { SUPERPOWERS_MANIFEST_TEMPLATE: template } },
    );
    assert.equal(result.outcome.ok, true, JSON.stringify(result));
    if (!result.outcome.ok) assert.fail("qualified fixture failed");
    assert.equal(result.outcome.result.compatibility.kind, "supported");
    return result.outcome.result;
  } finally {
    await rm(upstream, { recursive: true, force: true });
  }
}
