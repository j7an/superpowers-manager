export class UsageError extends Error {}

export function parseFlags(
  argv: readonly string[],
  names: readonly string[],
): Readonly<Record<string, string>> {
  const allowed = new Set(names);
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new UsageError(`unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
    if (!allowed.has(name)) throw new UsageError(`unknown option: --${name}`);
    const value =
      separator === -1 ? argv[index + 1] : token.slice(separator + 1);
    if (value === undefined || (separator === -1 && value.startsWith("--"))) {
      throw new UsageError(`option --${name} requires a value`);
    }
    result[name] = value;
    if (separator === -1) index += 1;
  }
  for (const name of names) {
    if (!Object.hasOwn(result, name)) {
      throw new UsageError(`required option is missing: --${name}`);
    }
  }
  return result;
}

export function oneLine(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ");
}
