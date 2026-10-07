/**
 * Lightweight JavaScript / TypeScript structure parser: comments removed,
 * imports, exports and named functions (with their bodies) located.
 */
import { matchBracket, skipString, splitTopLevel } from '../common';
import { LineIndex } from '../../utils/text';

/** Blanks out comments, preserving offsets. Strings, templates and regex literals are kept. */
export function stripJs(src: string): string {
  const out = src.split('');
  const n = src.length;
  let lastSignificant = '';
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      lastSignificant = 'a';
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') out[j++] = ' ';
      i = j - 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
      i = j - 1;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      i = j;
      lastSignificant = 'a';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? 'a' : c;
  }
  return out.join('');
}

export interface JsFunction {
  name: string;
  params: string;
  line: number;
  endLine: number;
  body: string;
  bodyOffset: number;
  /** "Class.method" container, if declared inside a class */
  owner?: string;
}

export interface JsImport {
  source: string;
  /** imported binding name ("default" for default imports, "*" for namespaces / require) */
  imported: string;
}

export interface JsFile {
  code: string;
  lines: LineIndex;
  imports: Map<string, JsImport>;
  functions: JsFunction[];
  /** exported name → local name */
  exports: Map<string, string>;
  /** local name exported as module default / module.exports, if any */
  defaultExport?: string;
}

export function parseJs(src: string): JsFile {
  const code = stripJs(src);
  const lines = new LineIndex(src);
  const imports = new Map<string, JsImport>();
  const exportsMap = new Map<string, string>();
  let defaultExport: string | undefined;
  let m: RegExpExecArray | null;

  const REQ = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*(['"`])([^'"`]+)\2\s*\)(?:\.(\w+))?/g;
  while ((m = REQ.exec(code))) {
    if (m[1].startsWith('{')) {
      for (const part of m[1].slice(1, -1).split(',')) {
        const pm = /^\s*(\w+)\s*(?::\s*(\w+))?\s*$/.exec(part);
        if (pm) imports.set(pm[2] || pm[1], { source: m[3], imported: pm[1] });
      }
    } else imports.set(m[1], { source: m[3], imported: m[4] || '*' });
  }
  const IMP = /import\s+(?:type\s+)?([\w$]+\s*,?\s*)?(\{[^}]*\}|\*\s+as\s+\w+)?\s*from\s*(['"])([^'"]+)\3/g;
  while ((m = IMP.exec(code))) {
    const def = m[1] ? m[1].replace(/[,\s]/g, '') : '';
    if (def) imports.set(def, { source: m[4], imported: 'default' });
    const rest = m[2] || '';
    if (rest.startsWith('*')) imports.set(rest.split(/\s+as\s+/)[1].trim(), { source: m[4], imported: '*' });
    else if (rest) {
      for (const part of rest.slice(1, -1).split(',')) {
        const pm = /^\s*(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (pm) imports.set(pm[2] || pm[1], { source: m[4], imported: pm[1] });
      }
    }
  }

  const functions: JsFunction[] = [];
  const addFn = (name: string, parenOpen: number, at: number, owner?: string) => {
    const parenClose = matchBracket(code, parenOpen);
    if (parenClose < 0) return -1;
    let k = parenClose + 1;
    while (k < code.length && /[\s:]/.test(code[k])) k++;
    // skip a TypeScript return type annotation
    if (code[parenClose + 1] === ':' || /^\s*:/.test(code.slice(parenClose + 1, parenClose + 4))) {
      while (k < code.length && code[k] !== '{' && !code.startsWith('=>', k)) k++;
    }
    if (code.startsWith('=>', k)) {
      k += 2;
      while (k < code.length && /\s/.test(code[k])) k++;
    }
    let bodyStart = k;
    let bodyEnd: number;
    if (code[k] === '{') {
      bodyEnd = matchBracket(code, k);
      if (bodyEnd < 0) bodyEnd = code.length - 1;
    } else {
      // expression-bodied arrow function: up to the end of the statement
      bodyStart = k;
      bodyEnd = k;
      let depth = 0;
      for (; bodyEnd < code.length; bodyEnd++) {
        const ch = code[bodyEnd];
        if ('\'"`'.includes(ch)) bodyEnd = skipString(code, bodyEnd);
        else if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) {
          if (depth === 0) break;
          depth--;
        } else if ((ch === ';' || ch === ',' || ch === '\n') && depth === 0) break;
      }
    }
    functions.push({
      name,
      params: code.slice(parenOpen + 1, parenClose).replace(/\s+/g, ' ').trim(),
      line: lines.lineAt(at),
      endLine: lines.lineAt(bodyEnd),
      body: code.slice(bodyStart, bodyEnd + 1),
      bodyOffset: bodyStart,
      owner,
    });
    return bodyEnd;
  };

  const FN = /(?:^|[^\w$.])(?:export\s+(default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\(/g;
  while ((m = FN.exec(code))) {
    if (m[1]) defaultExport = m[2];
    if (/export\s/.test(m[0])) exportsMap.set(m[2], m[2]);
    addFn(m[2], m.index + m[0].length - 1, m.index);
  }
  const ARROW = /(?:^|[^\w$.])(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*\(|\(|([\w$]+)\s*=>)/g;
  while ((m = ARROW.exec(code))) {
    if (/export\s/.test(m[0])) exportsMap.set(m[1], m[1]);
    if (m[2]) {
      // single-parameter arrow without parentheses: synthesize a paren range
      const at = m.index + m[0].length;
      const body = code.slice(at).match(/^\s*/)![0].length + at;
      const end = code[body] === '{' ? matchBracket(code, body) : code.indexOf('\n', body);
      functions.push({
        name: m[1], params: m[2], line: lines.lineAt(m.index), endLine: lines.lineAt(end < 0 ? code.length - 1 : end),
        body: code.slice(body, (end < 0 ? code.length : end) + 1), bodyOffset: body,
      });
      continue;
    }
    const open = m.index + m[0].length - 1;
    const parenOpen = code[open] === '(' ? open : code.indexOf('(', open);
    // "= (" can also be a parenthesized expression; require "=>" or a function keyword after it
    if (!/function/.test(m[0])) {
      const close = matchBracket(code, parenOpen);
      if (close < 0 || !/^\s*(?::[^=]{0,80})?=>/.test(code.slice(close + 1, close + 90))) continue;
    }
    addFn(m[1], parenOpen, m.index);
  }
  const ASSIGN = /(?:module\.)?exports\.([\w$]+)\s*=\s*(?:async\s+)?(?:function\s*[\w$]*\s*\(|\(|([\w$]+)\s*=>)/g;
  while ((m = ASSIGN.exec(code))) {
    exportsMap.set(m[1], m[1]);
    const open = m.index + m[0].length - 1;
    if (m[2]) continue;
    addFn(m[1], code[open] === '(' ? open : code.indexOf('(', open), m.index);
  }

  // class methods: "class X { async foo(req, res) { ... } }"
  const CLS = /class\s+([\w$]+)[^{]*\{/g;
  while ((m = CLS.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(code, open);
    if (close < 0) continue;
    const METH = /(?:^|[\s;}])(?:(?:static|async|public|private|protected|get|set)\s+)*([\w$]+)\s*\(/g;
    METH.lastIndex = open + 1;
    let mm: RegExpExecArray | null;
    while ((mm = METH.exec(code)) && mm.index < close) {
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super'].includes(mm[1])) {
        if (mm[1] !== 'constructor') continue;
      }
      const parenOpen = mm.index + mm[0].length - 1;
      const parenClose = matchBracket(code, parenOpen);
      if (parenClose < 0) break;
      const after = code.slice(parenClose + 1, parenClose + 120);
      if (!/^\s*(?::[^{;]+)?\{/.test(after)) {
        METH.lastIndex = parenClose + 1;
        continue;
      }
      const end = addFn(mm[1], parenOpen, mm.index + 1, m[1]);
      if (end < 0) break;
      METH.lastIndex = end + 1;
    }
  }

  m = /module\.exports\s*=\s*(\{|[\w$.]+|new\s+([\w$]+))/.exec(code);
  if (m) {
    if (m[1] === '{') {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(code, open);
      for (const part of splitTopLevel(code.slice(open + 1, close))) {
        const pm = /^(?:async\s+)?([\w$]+)\s*(?::\s*([\w$.]+))?/.exec(part);
        if (pm) exportsMap.set(pm[1], pm[2] || pm[1]);
        // inline method shorthand: { list(req, res) { ... } }
        const im = /^(?:async\s+)?([\w$]+)\s*\(/.exec(part);
        if (im) {
          const pOpen = code.indexOf(part, open) + part.indexOf('(');
          addFn(im[1], pOpen, pOpen);
        }
      }
    } else defaultExport = m[2] || m[1];
  }
  m = /export\s+default\s+(?:new\s+)?([\w$]+)/.exec(code);
  if (m && m[1] !== 'function' && m[1] !== 'class' && m[1] !== 'async') defaultExport = m[1];
  const EXPORT_LIST = /export\s*\{([^}]*)\}/g;
  while ((m = EXPORT_LIST.exec(code))) {
    for (const part of m[1].split(',')) {
      const pm = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (pm) exportsMap.set(pm[2] || pm[1], pm[1]);
    }
  }
  return { code, lines, imports, functions, exports: exportsMap, defaultExport };
}

/** Resolves a relative import ("./routes/users") against the importing file. */
export function resolveImport(source: string, fromFile: string, has: (p: string) => boolean): string | undefined {
  if (!source.startsWith('.')) return undefined;
  const dir = fromFile.split('/').slice(0, -1);
  for (const part of source.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') dir.pop();
    else dir.push(part);
  }
  const base = dir.join('/');
  const exts = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts', '/index.mjs'];
  for (const e of exts) {
    if (has(base + e)) return base + e;
  }
  // "./x.js" imports compiled from "./x.ts"
  if (base.endsWith('.js') && has(base.slice(0, -3) + '.ts')) return base.slice(0, -3) + '.ts';
  return undefined;
}
