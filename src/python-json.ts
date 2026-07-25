export function escapePythonJsonString(value: string): string {
  let escaped = "";
  const shortEscapes: Record<number, string> = {
    0x08: "\\b",
    0x09: "\\t",
    0x0a: "\\n",
    0x0c: "\\f",
    0x0d: "\\r",
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) {
      escaped += '\\"';
    } else if (code === 0x5c) {
      escaped += "\\\\";
    } else if (Object.hasOwn(shortEscapes, code)) {
      escaped += shortEscapes[code];
    } else if (code < 0x20 || code >= 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += value[index];
    }
  }
  return escaped;
}
