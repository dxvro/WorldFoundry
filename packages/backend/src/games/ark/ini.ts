// Unreal ini files with [Sections]. A value is set inside its section; the section is created when missing.
export function setSectionValue(text: string, section: string, key: string, value: string | null): string {
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim().toLowerCase() === header.toLowerCase());
  if (start === -1) {
    if (value === null) return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    if (lines.length > 0) lines.push('');
    lines.push(header, `${key}=${value}`);
    return `${lines.join('\n')}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*\[.*\]\s*$/.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  const at = lines.slice(start + 1, end).findIndex((line) => line.split('=')[0]?.trim() === key);
  if (at === -1) {
    if (value === null) return `${lines.join('\n')}\n`;
    let insert = end;
    while (insert > start + 1 && (lines[insert - 1] ?? '').trim() === '') insert--;
    lines.splice(insert, 0, `${key}=${value}`);
  } else if (value === null) {
    lines.splice(start + 1 + at, 1);
  } else {
    lines[start + 1 + at] = `${key}=${value}`;
  }
  return `${lines.join('\n')}\n`;
}

export function getSectionValue(text: string, section: string, key: string): string | undefined {
  let inside = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) inside = trimmed.toLowerCase() === `[${section}]`.toLowerCase();
    else if (inside && trimmed.split('=')[0]?.trim() === key) return trimmed.slice(trimmed.indexOf('=') + 1);
  }
  return undefined;
}
