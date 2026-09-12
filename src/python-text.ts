// Exact CPython strip characters; JavaScript trim()/\s differ at FEFF and C0/NEL.
export function pythonStrip(value: string): string {
  return value.replace(
    // oxlint-disable-next-line no-control-regex -- CPython whitespace includes C0 controls.
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028-\u2029\u202f\u205f\u3000]+$/g,
    "",
  );
}

// CRLF is one boundary; a terminating boundary adds no final empty line.
export function pythonSplitlines(value: string): string[] {
  // oxlint-disable-next-line no-control-regex -- CPython boundaries include C0 controls.
  const lines = value.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Python `sorted()` orders by code point; JavaScript's default sort does not. */
export function compareByCodePoint(left: string, right: string): number {
  // `Array.from` splits by code point, exactly as spreading would; oxlint's
  // `no-misused-spread` rejects the spread form, and grapheme segmentation is
  // the wrong unit here — Python compares code points.
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const a = leftPoints[index]!.codePointAt(0)!;
    const b = rightPoints[index]!.codePointAt(0)!;
    if (a !== b) return a - b;
  }
  return leftPoints.length - rightPoints.length;
}
