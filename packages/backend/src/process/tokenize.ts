import { AppError } from '../http/errors.js';

const invalid = (message: string): AppError => new AppError(422, 'INVALID_JVM_ARGS', message);

// Splits a command line into argv: whitespace separates, '…' and "…" group, \" works inside "…"
export function tokenizeArgs(input: string): string[] {
  if (/[\u0000-\u0008\u000a-\u001f]/.test(input)) {
    throw invalid('The additional JVM arguments contain control characters or line breaks.');
  }
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    if (quote === null) {
      if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (char === ' ' || char === '\t') {
        if (started) {
          args.push(current);
          current = '';
          started = false;
        }
      } else {
        current += char;
        started = true;
      }
    } else if (char === quote) {
      quote = null;
    } else if (char === '\\' && quote === '"' && input[i + 1] === '"') {
      current += '"';
      i++;
    } else {
      current += char;
    }
  }
  if (quote !== null) {
    throw invalid(`The additional JVM arguments contain an unclosed quotation mark (${quote}).`);
  }
  if (started) args.push(current);
  return args;
}
