/**
 * Language-neutral scanning helpers. They work on source text whose comments
 * were already blanked out (offsets preserved), and skip over string literals.
 */

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket closing the one at `open`, or -1 when unbalanced. */
export function matchBracket(text: string, open: number, quotes = `'"\``): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quotes.includes(c)) {
      i = skipString(text, i);
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Given the index of an opening quote, returns the index of its closing quote. */
export function skipString(text: string, start: number): number {
  const q = text[start];
  if (q === '"' && text.startsWith('"""', start)) {
    const end = text.indexOf('"""', start + 3);
    return end < 0 ? text.length - 1 : end + 2;
  }
  if (q === "'" && text.startsWith("'''", start)) {
    const end = text.indexOf("'''", start + 3);
    return end < 0 ? text.length - 1 : end + 2;
  }
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === q) return i;
    if (c === '\n' && q !== '`' && q !== '"' && q !== "'") return i;
  }
  return text.length - 1;
}

/** Splits on `sep` at bracket depth 0, outside strings. Pieces are trimmed. */
export function splitTopLevel(text: string, sep = ',', quotes = `'"\``): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quotes.includes(c)) {
      i = skipString(text, i);
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(last, i).trim());
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  const tail = text.slice(last).trim();
  if (tail || out.length) out.push(tail);
  return out.filter((s, i, a) => s !== '' || i < a.length - 1);
}

/** Arguments of the call whose "(" is at `open`: [args, closeIndex]. */
export function callArgs(text: string, open: number, quotes?: string): [string[], number] {
  const close = matchBracket(text, open, quotes);
  if (close < 0) return [[], text.length];
  return [splitTopLevel(text.slice(open + 1, close), ',', quotes), close];
}

/** The literal value of a quoted string token, or null for anything else. */
export function unquote(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.trim();
  const m = /^[rRbBuUfF]{0,2}(['"`])([\s\S]*)\1$/.exec(t);
  if (!m) return null;
  if (m[1] === '`' && m[2].includes('${')) return null;
  return m[2].replace(/\\(['"\\])/g, '$1');
}

/** Replaces everything inside string literals with spaces (quotes kept), preserving offsets. */
export function maskStrings(text: string, quotes = `'"\``): string {
  const out = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (quotes.includes(text[i])) {
      const end = skipString(text, i);
      for (let j = i + 1; j < end; j++) if (out[j] !== '\n') out[j] = ' ';
      i = end;
    }
  }
  return out.join('');
}

export function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}
