// Format-preserving reader/writer for Java .properties files (server.properties).
// Untouched lines (comments, blank lines, unknown keys, odd formatting) are written back byte for byte.

interface RawPart {
  kind: 'raw';
  text: string;
}

interface EntryPart {
  kind: 'entry';
  key: string;
  value: string;
  text: string;
  eol: string;
}

type Part = RawPart | EntryPart;

function unescapeJava(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) break;
    i++;
    switch (next) {
      case 't':
        out += '\t';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u': {
        const hex = input.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
        break;
      }
      default:
        out += next;
    }
  }
  return out;
}

function escapeJava(input: string, isKey: boolean): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    const code = char.charCodeAt(0);
    if (char === '\\') out += '\\\\';
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\f') out += '\\f';
    else if (char === '=' || char === ':' || char === '#' || char === '!') out += `\\${char}`;
    else if (char === ' ' && (isKey || i === 0)) out += '\\ ';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return out;
}

const isBlankOrComment = (line: string): boolean => /^[ \t\f]*([#!].*)?$/.test(line);

function endsWithOddBackslashes(line: string): boolean {
  const match = /\\+$/.exec(line);
  return match !== null && match[0].length % 2 === 1;
}

// splits on unescaped separator; returns raw (still escaped) key and value
function splitEntry(logical: string): { key: string; value: string } {
  let i = 0;
  while (i < logical.length && /[ \t\f]/.test(logical[i] as string)) i++;
  const start = i;
  while (i < logical.length) {
    const char = logical[i] as string;
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '=' || char === ':' || /[ \t\f]/.test(char)) break;
    i++;
  }
  const key = logical.slice(start, Math.min(i, logical.length));
  while (i < logical.length && /[ \t\f]/.test(logical[i] as string)) i++;
  if (logical[i] === '=' || logical[i] === ':') i++;
  while (i < logical.length && /[ \t\f]/.test(logical[i] as string)) i++;
  return { key, value: logical.slice(i) };
}

export class PropertiesDocument {
  private constructor(
    private parts: Part[],
    private readonly newline: string,
    readonly encoding: 'utf8' | 'latin1',
  ) {}

  static empty(newline = '\n'): PropertiesDocument {
    return new PropertiesDocument([], newline, 'utf8');
  }

  static parse(text: string, encoding: 'utf8' | 'latin1' = 'utf8'): PropertiesDocument {
    const physical: Array<{ line: string; eol: string }> = [];
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match[0] === '') break;
      physical.push({ line: match[1] as string, eol: match[2] as string });
      if (match[2] === '') break;
    }
    const parts: Part[] = [];
    for (let index = 0; index < physical.length; index++) {
      const first = physical[index] as { line: string; eol: string };
      if (isBlankOrComment(first.line)) {
        parts.push({ kind: 'raw', text: first.line + first.eol });
        continue;
      }
      let logical = first.line;
      let source = first.line + first.eol;
      let eol = first.eol;
      while (endsWithOddBackslashes(logical) && index + 1 < physical.length) {
        const next = physical[++index] as { line: string; eol: string };
        logical = logical.slice(0, -1) + next.line.replace(/^[ \t\f]+/, '');
        source += next.line + next.eol;
        eol = next.eol;
      }
      const { key, value } = splitEntry(logical);
      parts.push({ kind: 'entry', key: unescapeJava(key), value: unescapeJava(value), text: source, eol });
    }
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
    return new PropertiesDocument(parts, crlf > lf ? '\r\n' : '\n', encoding);
  }

  private entries(): EntryPart[] {
    return this.parts.filter((part): part is EntryPart => part.kind === 'entry');
  }

  get(key: string): string | undefined {
    // like java.util.Properties: the last definition wins
    return this.entries()
      .filter((entry) => entry.key === key)
      .at(-1)?.value;
  }

  toRecord(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const entry of this.entries()) record[entry.key] = entry.value;
    return record;
  }

  // every key once, in the order of its first appearance, with the value Java would use
  pairs(): Array<{ key: string; value: string }> {
    const values = new Map<string, string>();
    for (const entry of this.entries()) values.set(entry.key, entry.value);
    return [...values].map(([key, value]) => ({ key, value }));
  }

  // drops all definitions of the key; comments and every other line stay as they are
  remove(key: string): boolean {
    const before = this.parts.length;
    this.parts = this.parts.filter((part) => part.kind !== 'entry' || part.key !== key);
    return this.parts.length !== before;
  }

  set(key: string, value: string): void {
    const existing = this.entries()
      .filter((entry) => entry.key === key)
      .at(-1);
    if (existing !== undefined) {
      if (existing.value === value) return;
      existing.value = value;
      existing.text = `${escapeJava(key, true)}=${escapeJava(value, false)}${existing.eol}`;
      return;
    }
    const last = this.parts.at(-1);
    if (last !== undefined) {
      const tail = last.kind === 'entry' ? last.eol : /(\r\n|\n|\r)$/.exec(last.text)?.[0] ?? '';
      if (tail === '') {
        if (last.kind === 'entry') last.eol = this.newline;
        last.text += this.newline;
      }
    }
    this.parts.push({ kind: 'entry', key, value, text: `${escapeJava(key, true)}=${escapeJava(value, false)}${this.newline}`, eol: this.newline });
  }

  serialize(): string {
    return this.parts.map((part) => part.text).join('');
  }

  get lineBreak(): string {
    return this.newline;
  }
}

export function decodeProperties(buffer: Buffer): { text: string; encoding: 'utf8' | 'latin1' } {
  const body = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf8' };
  } catch {
    return { text: body.toString('latin1'), encoding: 'latin1' };
  }
}
