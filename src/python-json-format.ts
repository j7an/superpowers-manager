/**
 * Apply CPython's `ensure_ascii=True` to an already-JSON-encoded string. Input
 * must be the output of JSON.stringify, which has already escaped quotes,
 * backslashes, and control characters; this only replaces the remainder.
 * Astral characters are already surrogate pairs in a JavaScript string, so the
 * per-code-unit replacement emits the pair CPython emits.
 *
 * The range starts at U+007F, not U+0080: CPython escapes DEL while
 * JSON.stringify leaves it literal, and U+007E is "~" in both. Below U+0020
 * the two already agree. Measured 2026-07-31.
 */
export function escapeNonAscii(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
