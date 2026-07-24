// @ts-check
/** @type {typeof import("../../../src/workspace.js")} */
const { withWorkspace } = await import("../../../dist/workspace.js");

const parent = process.argv[2];
if (!parent) throw new Error("missing parent");
const never = new Promise(() => {
  setInterval(() => {}, 2 ** 31 - 1);
});

await Promise.all([
  withWorkspace(parent, "outer-", async (outer) => {
    process.stdout.write(`${outer}\n`);
    await withWorkspace(outer, "nested-", async (nested) => {
      process.stdout.write(`${nested}\n`);
      await never;
    });
  }),
  withWorkspace(parent, "peer-", async (peer) => {
    process.stdout.write(`${peer}\n`);
    await never;
  }),
]);
