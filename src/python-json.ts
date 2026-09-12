import { escapeNonAscii } from "./python-json-format.ts";

export function escapePythonJsonString(value: string): string {
  return escapeNonAscii(JSON.stringify(value).slice(1, -1));
}
