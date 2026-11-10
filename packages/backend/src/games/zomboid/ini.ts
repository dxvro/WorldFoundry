// Project Zomboid server settings (<profile>.ini): one "Key=Value" per line. Changes keep every other line,
// comments and the order, so the game's own file stays readable.
export function setIniValues(text: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  const out = lines.map((line) => {
    const index = line.indexOf('=');
    if (index <= 0 || line.trimStart().startsWith('#')) return line;
    const key = line.slice(0, index).trim();
    const value = pending.get(key);
    if (value === undefined) return line;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

export function readIniValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0 || line.trimStart().startsWith('#')) continue;
    values.set(line.slice(0, index).trim(), line.slice(index + 1));
  }
  return values;
}
