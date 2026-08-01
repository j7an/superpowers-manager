import { SafetyError } from "./safety-error.js";

/**
 * Render a JSON number token the way CPython's `json.dump` does.
 *
 * Classification is by source text, matching CPython's own: a token containing
 * `.` or `e`/`E` parses as a float, anything else as an arbitrary-width int.
 * Integers are emitted verbatim so widths above 2^53 survive; `-0` is the only
 * normalization JSON's grammar leaves room for, since leading zeros and a
 * leading `+` are already forbidden.
 */
export function formatPythonNumber(raw: string): string {
  if (!/[.eE]/.test(raw)) {
    // NaN/Infinity/-Infinity contain no `.` or `e`/`E`, so they would
    // otherwise fall into the "emit verbatim" integer branch and echo back
    // as invalid JSON. A reader running a non-standard-constants accept
    // profile (see src/strict-json.ts) can hand this function exactly these
    // three tokens as a raw number source, so this function must reject them
    // itself rather than assume its caller already did. CPython's
    // `json.dump(..., allow_nan=False)` raises ValueError for all three.
    if (raw === "NaN" || raw === "Infinity" || raw === "-Infinity") {
      throw new SafetyError(
        "manifest-overlay",
        `JSON number out of range: ${raw}`,
      );
    }
    return raw === "-0" ? "0" : raw;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new SafetyError(
      "manifest-overlay",
      `JSON number out of range: ${raw}`,
    );
  }
  return formatPythonFloat(value);
}

function formatPythonFloat(value: number): string {
  // toExponential() drops the sign of negative zero; CPython's repr keeps it.
  // Note this differs from the integer -0, which normalizes to 0 — consistent,
  // because -0 has no `.` or `e` and so classifies as an integer.
  if (Object.is(value, -0)) return "-0.0";

  // Called with no argument, toExponential() yields the shortest digit string
  // that uniquely identifies the double — the same guarantee CPython's repr
  // relies on. Taking digits and exponent separately is what lets us apply
  // CPython's notation threshold instead of JavaScript's.
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");

  let body: string;
  if (exponent >= -4 && exponent < 16) {
    // Fixed notation, built by MOVING the decimal point through the digit
    // string above. Do NOT route this through value.toFixed(): toExponential()
    // has already produced the shortest digits that identify this double, and
    // toFixed performs a second, independent rounding of the full decimal
    // expansion. The two disagree — 1888570120608320.2 formats as
    // ...320.3 via toFixed and ...320.2 in CPython. Measured 2026-07-31.
    if (exponent >= digits.length - 1) {
      body = `${digits}${"0".repeat(exponent - (digits.length - 1))}.0`;
    } else if (exponent >= 0) {
      body = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const sign = exponent < 0 ? "-" : "+";
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    body = `${mantissa.replace("-", "")}e${sign}${magnitude}`;
  }

  return negative ? `-${body}` : body;
}

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
