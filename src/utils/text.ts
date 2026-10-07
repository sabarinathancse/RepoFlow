/** Small string helpers shared by parsers, adapters and analyzers. */

/** Maps character offsets to 1-based line numbers for one source text. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  get count(): number {
    return this.starts.length;
  }
}

export function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

export function sortBy<T>(items: T[], key: (t: T) => string | number): T[] {
  return items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function squash(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function basename(p: string): string {
  const s = toPosix(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  const s = toPosix(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? '.' : s.slice(0, i) || '.';
}

export function stripExt(p: string): string {
  const b = basename(p);
  const i = b.indexOf('.');
  return i <= 0 ? p : p.slice(0, p.length - (b.length - i));
}

/** Joins path segments posix-style and resolves "." and "..". */
export function joinPath(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/') || '.';
}

export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Turns a URL path into a route group label ("/admin/users/5" → "admin"). */
export function routeGroup(path: string): string {
  const seg = path.split('/').filter(Boolean)[0] || '';
  if (!seg || seg.startsWith('{') || seg.startsWith(':') || seg.startsWith('<')) return '(root)';
  return seg;
}

/** Normalizes a URL path: leading slash, no trailing slash, collapsed slashes. */
export function normalizeUrlPath(p: string): string {
  let s = ('/' + p).replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Masks a secret-looking value so reports never contain the real thing. */
export function maskSecret(value: string): string {
  if (value.length <= 6) return '***';
  return value.slice(0, 3) + '…' + '*'.repeat(4) + ` (${value.length} chars)`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
