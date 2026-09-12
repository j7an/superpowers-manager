import { writeSelectionState } from "../../src/selection-store.ts";
import { validateRecord } from "../../src/selection.ts";

const [path, json] = process.argv.slice(2);
if (process.argv.length !== 4 || path === undefined || json === undefined) {
  throw new Error("selection writer requires a state path and JSON record");
}
await writeSelectionState(path, validateRecord(JSON.parse(json)));
