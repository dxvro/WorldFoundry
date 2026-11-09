export interface ParsedJava {
  major: number;
  version: string;
  name: string;
}

// "1.8.0_392" -> 8, "21.0.1" -> 21, "17" -> 17, "25-ea" -> 25
export function parseJavaVersion(output: string): ParsedJava | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const first = lines.find((line) => /version "/.test(line));
  const match = first === undefined ? null : /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(first);
  if (match?.[1] === undefined) return null;
  const leading = Number(match[1]);
  const major = leading === 1 ? Number(match[2] ?? 0) : leading;
  if (!Number.isInteger(major) || major < 1) return null;
  const quoted = /"([^"]+)"/.exec(first ?? '')?.[1] ?? match[1];
  const runtime = lines.find((line) => /runtime environment/i.test(line));
  return { major, version: quoted, name: (runtime ?? first ?? '').slice(0, 120) };
}
