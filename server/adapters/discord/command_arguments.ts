/** Split positional identities while preserving quoted whitespace and literal backslashes. */
export function quotedArguments(source: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "") && index < source.length) index++;
    if (index === source.length) break;
    const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null;
    let value = "";
    let closed = quote === null;
    while (index < source.length) {
      const character = source[index++]!;
      if (quote && character === quote) { closed = true; break; }
      if (!quote && /\s/.test(character)) break;
      if (quote && character === "\\" && (source[index] === quote || source[index] === "\\")) value += source[index++]!;
      else value += character;
    }
    if (!closed || (quote && index < source.length && !/\s/.test(source[index]!))) throw new Error("Quote each identity containing spaces, and close its quote.");
    if (!value) throw new Error("An identity cannot be empty.");
    values.push(value);
  }
  return values;
}

/** A command with one identity accepts the entire remainder, or one quoted value. */
export function opaqueArgument(source: string): string {
  const value = source.trim();
  if (!value.startsWith('"') && !value.startsWith("'")) return value;
  const values = quotedArguments(value);
  if (values.length !== 1) throw new Error("Supply one identity, quoting it when needed.");
  return values[0]!;
}
