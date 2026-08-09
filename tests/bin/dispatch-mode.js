// @ts-check
/**
 * The command a dispatch *vehicle* names when it needs one DISPATCH still
 * spawns and asserts nothing about which one.
 *
 * Derived rather than hardcoded: PR 11.5 flips one command per slice, and a
 * vehicle naming a flipped command either fails for the wrong reason or --
 * worse, in buildSpawn's case -- keeps passing while describing a command that
 * is no longer spawned. Slice 2's stale vehicle was found by reading, not by a
 * failing test.
 *
 * The throw is the point of the empty case. When slice 4 flips the last
 * spawned command, every caller of this fails loudly, which is exactly when
 * those tests should be deleted rather than repaired.
 *
 * @template {string} K
 * @param {Record<K, "spawn" | "in-process">} table
 * @returns {K}
 */
export function vehicleCommand(table) {
  for (const [command, mode] of Object.entries(table)) {
    if (mode === "spawn") return /** @type {K} */ (command);
  }
  throw new Error(
    "vehicleCommand: no spawned command remains in DISPATCH — the test that " +
      "called this has nothing left to describe; delete it rather than " +
      "re-point it",
  );
}
