// CPython `str.strip()` whitespace, from Unicode's Bidi/White_Space tables as
// CPython applies them. Deliberately excludes U+FEFF, which JavaScript's
// `trim()` removes and Python's `strip()` does not.
const PYTHON_WHITESPACE = new Set([
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x1f",
  "\x85",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
]);

// CPython `str.splitlines()` boundaries. `\r\n` is handled as a pair below.
const PYTHON_LINE_BOUNDARIES = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  " ",
  " ",
]);

export function pythonStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PYTHON_WHITESPACE.has(value[start]!)) start += 1;
  while (end > start && PYTHON_WHITESPACE.has(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

export function pythonSplitlines(value: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (!PYTHON_LINE_BOUNDARIES.has(character)) {
      index += 1;
      continue;
    }
    lines.push(value.slice(start, index));
    index += character === "\r" && value[index + 1] === "\n" ? 2 : 1;
    start = index;
  }
  if (start < value.length) lines.push(value.slice(start));
  return lines;
}
