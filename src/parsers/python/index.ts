/**
 * Lightweight Python structure parser built on logical lines (bracketed
 * continuations joined, comments removed) and indentation.
 */
import { skipString } from '../common';

export interface PyLine {
  text: string;
  line: number;
  endLine: number;
  indent: number;
}

export interface PyBlock {
  kind: 'def' | 'class';
  name: string;
  /** parameters for def, base classes for class */
  args: string;
  isAsync: boolean;
  decorators: Array<{ text: string; line: number }>;
  line: number;
  endLine: number;
  indent: number;
  /** logical lines inside the block body */
  body: PyLine[];
  parent?: PyBlock;
  children: PyBlock[];
}

export interface PyImport {
  /** absolute or relative ("." prefixed) module */
  module: string;
  /** imported name, or undefined for "import module" */
  name?: string;
}

export interface PyFile {
  lines: PyLine[];
  blocks: PyBlock[];
  /** every block, nested ones included */
  all: PyBlock[];
  imports: Map<string, PyImport>;
  /** logical lines at module level (indent 0) */
  topLevel: PyLine[];
}

/** Splits source into logical lines. */
export function logicalLines(src: string): PyLine[] {
  const out: PyLine[] = [];
  let buf = '';
  let depth = 0;
  let startLine = 1;
  let line = 1;
  let indent = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (indent < 0) {
      if (c === ' ' || c === '\t') continue;
      if (c === '\n') {
        line++;
        continue;
      }
      if (c === '\r') continue;
      let col = 0;
      for (let k = i - 1; k >= 0 && src[k] !== '\n'; k--) col += src[k] === '\t' ? 4 : 1;
      indent = col;
      startLine = line;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(src, i);
      const s = src.slice(i, end + 1);
      for (const ch of s) if (ch === '\n') line++;
      buf += s;
      i = end;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === '\\' && src[i + 1] === '\n') {
      line++;
      i++;
      buf += ' ';
      continue;
    }
    if (c === '\n') {
      line++;
      if (depth > 0) {
        buf += ' ';
        continue;
      }
      if (buf.trim()) out.push({ text: buf.trim(), line: startLine, endLine: line - 1, indent });
      buf = '';
      indent = -1;
      continue;
    }
    if (c !== '\r') buf += c;
  }
  if (buf.trim()) out.push({ text: buf.trim(), line: startLine, endLine: line, indent: Math.max(indent, 0) });
  return out;
}

const HEAD_RE = /^(async\s+)?(def|class)\s+(\w+)\s*(?:\(([\s\S]*)\))?\s*(?:->[^:]*)?:/;

export function parsePython(src: string): PyFile {
  const lines = logicalLines(src);
  const blocks: PyBlock[] = [];
  const all: PyBlock[] = [];
  const stack: PyBlock[] = [];
  let pendingDecorators: Array<{ text: string; line: number }> = [];
  const lastLine = lines.length ? lines[lines.length - 1].endLine : 1;

  for (const ln of lines) {
    while (stack.length && ln.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.body.push(ln);
    for (let k = 0; k < stack.length - 1; k++) stack[k].body.push(ln);

    if (ln.text.startsWith('@')) {
      pendingDecorators.push({ text: ln.text.slice(1), line: ln.line });
      continue;
    }
    const m = HEAD_RE.exec(ln.text);
    if (m) {
      // A one-line body ("def f(): return 1") stays on the header line.
      const blk: PyBlock = {
        kind: m[2] as 'def' | 'class',
        name: m[3],
        args: (m[4] || '').replace(/\s+/g, ' ').trim(),
        isAsync: !!m[1],
        decorators: pendingDecorators,
        line: pendingDecorators.length ? pendingDecorators[0].line : ln.line,
        endLine: ln.endLine,
        indent: ln.indent,
        body: [],
        parent,
        children: [],
      };
      if (parent) parent.children.push(blk);
      else blocks.push(blk);
      all.push(blk);
      stack.push(blk);
    }
    pendingDecorators = [];
  }
  for (const b of all) b.endLine = b.body.length ? b.body[b.body.length - 1].endLine : Math.min(b.endLine, lastLine);

  const imports = new Map<string, PyImport>();
  for (const ln of lines) {
    let m = /^from\s+([.\w]+)\s+import\s+\(?([^)]*)\)?$/.exec(ln.text);
    if (m) {
      for (const part of m[2].split(',')) {
        const pm = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (pm) imports.set(pm[2] || pm[1], { module: m[1], name: pm[1] });
      }
      continue;
    }
    m = /^import\s+(.+)$/.exec(ln.text);
    if (m) {
      for (const part of m[1].split(',')) {
        const pm = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (pm) imports.set(pm[2] || pm[1].split('.')[0], { module: pm[2] ? pm[1] : pm[1].split('.')[0] });
      }
    }
  }
  return { lines, blocks, all, imports, topLevel: lines.filter((l) => l.indent === 0) };
}

/** Resolves a dotted module ("app.views", ".views") to candidate file paths. */
export function moduleCandidates(module: string, fromFile: string, roots: string[]): string[] {
  const out: string[] = [];
  if (module.startsWith('.')) {
    const dots = /^\.+/.exec(module)![0].length;
    let dir = fromFile.split('/').slice(0, -1);
    dir = dir.slice(0, Math.max(0, dir.length - (dots - 1)));
    const rest = module.slice(dots).split('.').filter(Boolean);
    const base = [...dir, ...rest].join('/');
    out.push(base + '.py', (base ? base + '/' : '') + '__init__.py');
  } else {
    const rel = module.split('.').join('/');
    for (const r of roots) {
      const p = r && r !== '.' ? `${r}/${rel}` : rel;
      out.push(p + '.py', p + '/__init__.py');
    }
  }
  return out;
}

/** Keyword arguments of a call argument list ("a, b=1, c='x'" → {b:'1', c:"'x'"}). */
export function kwargs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function positional(args: string[]): string[] {
  return args.filter((a) => !/^\w+\s*=(?!=)/.test(a) && !a.startsWith('*'));
}
