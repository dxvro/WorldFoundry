import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

// Release notes come from GitHub, so they are untrusted. This renders a small subset of Markdown (headings,
// lists, paragraphs, **bold**, `code`, https links) as React elements. Nothing is ever inserted as HTML; every
// other character, including "<script>", is shown as text.

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]{1,200}\]\([^)\s]{1,500}\))/g;

export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyBase}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-raised px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link !== null) {
      const href = safeHref(link[2] as string);
      if (href !== null) {
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
            {link[1]}
          </a>
        );
      }
      return <span key={key}>{link[1]}</span>;
    }
    return part;
  });
}

type Block = { kind: 'heading'; level: number; text: string } | { kind: 'list'; items: string[] } | { kind: 'paragraph'; text: string };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    if (list !== null) blocks.push({ kind: 'list', items: list });
    paragraph = [];
    list = null;
  };
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    if (line.trim() === '') flush();
    else if (heading !== null) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(3, (heading[1] as string).length), text: heading[2] as string });
    } else if (bullet !== null) {
      if (list === null) {
        flush();
        list = [];
      }
      list.push(bullet[1] as string);
    } else {
      if (list !== null) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export function SafeMarkdown({ source, className }: { source: string; className?: string }): ReactNode {
  const { t } = useI18n();
  const blocks = parseBlocks(source);
  if (blocks.length === 0) return <p className="hint">{t.update.noReleaseNotes}</p>;
  return (
    <div className={className ?? 'space-y-2 text-sm text-dim'}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.kind === 'heading') {
          return (
            <p key={key} className="pt-1 font-semibold text-ink">
              {renderInline(block.text, key)}
            </p>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul key={key} className="list-disc space-y-0.5 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}
