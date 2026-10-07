/**
 * Lightweight PHP structure parser: enough to find namespaces, imports,
 * classes, methods, properties and literal arrays without a full grammar.
 */
import { matchBracket, skipString, splitTopLevel, unquote, maskStrings, blank } from '../common';
import { LineIndex } from '../../utils/text';

const Q = `'"`;

/**
 * Returns the PHP code of a file with comments and inline HTML blanked out.
 * Offsets and line numbers are preserved, strings are kept intact.
 */
export function stripPhp(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  // Files without an opening tag are treated as pure code (snippets, fixtures).
  let php = !src.includes('<?');
  const blankRange = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    if (!php) {
      const open = src.indexOf('<?', i);
      if (open < 0) {
        blankRange(i, n);
        break;
      }
      blankRange(i, open);
      let skip = 2;
      if (src.startsWith('<?php', open)) skip = 5;
      else if (src.startsWith('<?=', open)) skip = 3;
      // "<?=" becomes "echo"-like code; keep it blank so the expression remains.
      blankRange(open, open + skip);
      i = open + skip;
      php = true;
      continue;
    }
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i) + 1;
      continue;
    }
    if (c === '<' && src.startsWith('<<<', i)) {
      const m = /^<<<\s*['"]?(\w+)['"]?/.exec(src.slice(i, i + 80));
      if (m) {
        const end = src.slice(i).search(new RegExp(`\\n\\s*${m[1]}\\b`));
        i = end < 0 ? n : i + end + 1;
        continue;
      }
    }
    if (c === '?' && src[i + 1] === '>') {
      blankRange(i, i + 2);
      out[i] = ';';
      i += 2;
      php = false;
      continue;
    }
    if ((c === '/' && src[i + 1] === '/') || (c === '#' && src[i + 1] !== '[')) {
      let j = i;
      while (j < n && src[j] !== '\n' && !(src[j] === '?' && src[j + 1] === '>')) j++;
      blankRange(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end < 0 ? n : end + 2;
      blankRange(i, j);
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

export interface PhpMethod {
  name: string;
  visibility: string;
  isStatic: boolean;
  params: string;
  line: number;
  endLine: number;
  /** method body including braces, comments blanked */
  body: string;
  /** offset of the body within the stripped file */
  bodyOffset: number;
}

export interface PhpProperty {
  name: string;
  visibility: string;
  value?: string;
  line: number;
}

export interface PhpClass {
  kind: 'class' | 'trait' | 'interface' | 'enum';
  name: string;
  fqcn: string;
  extends?: string;
  implements: string[];
  line: number;
  endLine: number;
  methods: PhpMethod[];
  properties: PhpProperty[];
  /** class-level code with method bodies blanked out */
  classText: string;
  bodyOffset: number;
  /** offset of the closing brace */
  bodyEnd: number;
}

export interface PhpFunction {
  name: string;
  params: string;
  line: number;
  endLine: number;
  body: string;
  bodyOffset: number;
}

export interface PhpFile {
  namespace: string;
  uses: Map<string, string>;
  classes: PhpClass[];
  functions: PhpFunction[];
  /** comments and inline HTML blanked */
  code: string;
  lines: LineIndex;
}

const CLASS_RE = /(^|[^\w$:>\\])(?:(?:abstract|final|readonly)\s+)*(class|trait|interface|enum)\s+(\w+)\s*(?::\s*\w+\s*)?((?:extends|implements)[^{]*)?\{/g;
const METHOD_RE = /((?:(?:public|protected|private|static|final|abstract)\s+)*)function\s+&?\s*(\w+)\s*\(/g;
const PROP_RE = /(public|protected|private|var)\s+(?:static\s+)?(?:readonly\s+)?(?:\??[\w\\|]+\s+)?\$(\w+)\s*(?:=\s*([\s\S]*?))?;/g;

export function parsePhp(src: string): PhpFile {
  const code = stripPhp(src);
  const masked = maskStrings(code, Q);
  const lines = new LineIndex(src);
  const ns = /\bnamespace\s+([\w\\]+)\s*;/.exec(masked);
  const namespace = ns ? code.slice(ns.index, ns.index + ns[0].length).replace(/^namespace\s+|\s*;$/g, '').trim() : '';
  const uses = new Map<string, string>();
  const classes: PhpClass[] = [];
  const functions: PhpFunction[] = [];

  const classRanges: Array<[number, number]> = [];
  CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_RE.exec(masked))) {
    const start = m.index + m[1].length;
    if (/new\s*$/.test(masked.slice(Math.max(0, start - 8), start))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(code, open, Q);
    const end = close < 0 ? code.length - 1 : close;
    const heritage = m[4] || '';
    const ext = /extends\s+([\w\\]+)/.exec(heritage);
    const impl = /implements\s+([\w\\,\s]+)/.exec(heritage);
    const name = m[3];
    const cls: PhpClass = {
      kind: m[2] as PhpClass['kind'],
      name,
      fqcn: namespace ? `${namespace}\\${name}` : name,
      extends: ext ? ext[1] : undefined,
      implements: impl ? impl[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
      line: lines.lineAt(start),
      endLine: lines.lineAt(end),
      methods: [],
      properties: [],
      classText: '',
      bodyOffset: open,
      bodyEnd: end,
    };
    parseClassBody(code, masked, open, end, cls, lines);
    classes.push(cls);
    classRanges.push([open, end]);
    CLASS_RE.lastIndex = end;
  }

  const inClass = (pos: number) => classRanges.some(([a, b]) => pos > a && pos < b);
  const firstClass = classRanges.length ? classRanges[0][0] : masked.length;

  const USE_RE = /(^|[;{}\s])use\s+(function\s+|const\s+)?([\w\\]+)(\\\{([^}]*)\})?(?:\s+as\s+(\w+))?\s*;/g;
  while ((m = USE_RE.exec(masked))) {
    if (m.index > firstClass && inClass(m.index)) continue;
    const base = m[3].replace(/^\\/, '');
    if (m[4]) {
      for (const part of m[5].split(',')) {
        const pm = /([\w\\]+)(?:\s+as\s+(\w+))?/.exec(part.trim());
        if (pm) uses.set(pm[2] || pm[1].split('\\').pop()!, `${base}\\${pm[1]}`);
      }
    } else uses.set(m[6] || base.split('\\').pop()!, base);
  }

  const FN_RE = /(^|[^\w$>:])function\s+&?\s*(\w+)\s*\(/g;
  while ((m = FN_RE.exec(masked))) {
    const at = m.index + m[1].length;
    if (inClass(at)) continue;
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBracket(code, parenOpen, Q);
    if (parenClose < 0) continue;
    const braceOpen = masked.indexOf('{', parenClose);
    if (braceOpen < 0) continue;
    const between = masked.slice(parenClose + 1, braceOpen);
    if (between.includes(';')) continue;
    const braceClose = matchBracket(code, braceOpen, Q);
    const end = braceClose < 0 ? code.length - 1 : braceClose;
    functions.push({
      name: m[2],
      params: squashParams(code.slice(parenOpen + 1, parenClose)),
      line: lines.lineAt(at),
      endLine: lines.lineAt(end),
      body: code.slice(braceOpen, end + 1),
      bodyOffset: braceOpen,
    });
    FN_RE.lastIndex = end;
  }

  return { namespace, uses, classes, functions, code, lines };
}

function squashParams(p: string): string {
  return p.replace(/\s+/g, ' ').trim();
}

function parseClassBody(code: string, masked: string, open: number, close: number, cls: PhpClass, lines: LineIndex) {
  let classText = code.slice(open, close + 1);
  const region = masked.slice(open, close + 1);
  METHOD_RE.lastIndex = 1;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(region))) {
    const mods = m[1] || '';
    const parenOpen = open + m.index + m[0].length - 1;
    const parenClose = matchBracket(code, parenOpen, Q);
    if (parenClose < 0) break;
    // Skip the optional return type, then expect "{" (body) or ";" (abstract / interface).
    let k = parenClose + 1;
    while (k < close && masked[k] !== '{' && masked[k] !== ';') k++;
    const startLine = lines.lineAt(open + m.index);
    if (masked[k] === ';') {
      cls.methods.push({
        name: m[2], visibility: visibility(mods), isStatic: /static/.test(mods),
        params: squashParams(code.slice(parenOpen + 1, parenClose)), line: startLine, endLine: startLine, body: '', bodyOffset: k,
      });
      METHOD_RE.lastIndex = k - open + 1;
      continue;
    }
    const bodyClose = matchBracket(code, k, Q);
    const end = bodyClose < 0 ? close : bodyClose;
    cls.methods.push({
      name: m[2],
      visibility: visibility(mods),
      isStatic: /static/.test(mods),
      params: squashParams(code.slice(parenOpen + 1, parenClose)),
      line: startLine,
      endLine: lines.lineAt(end),
      body: code.slice(k, end + 1),
      bodyOffset: k,
    });
    classText = classText.slice(0, k - open + 1) + blank(classText.slice(k - open + 1, end - open)) + classText.slice(end - open);
    METHOD_RE.lastIndex = end - open + 1;
  }
  cls.classText = classText;
  PROP_RE.lastIndex = 0;
  const maskedClassText = maskStrings(classText, Q);
  while ((m = PROP_RE.exec(maskedClassText))) {
    const valueStart = m[3] !== undefined ? m.index + m[0].lastIndexOf(m[3]) : -1;
    cls.properties.push({
      name: m[2],
      visibility: m[1] === 'var' ? 'public' : m[1],
      value: valueStart >= 0 ? classText.slice(valueStart, valueStart + m[3].length).trim() : undefined,
      line: lines.lineAt(open + m.index),
    });
  }
}

function visibility(mods: string): string {
  const v = /(public|protected|private)/.exec(mods);
  return v ? v[1] : 'public';
}

/** A PHP literal: string, number, bool, null, nested array, or an opaque expression. */
export type PhpValue = string | number | boolean | null | PhpValue[] | { [k: string]: PhpValue } | { __expr: string };

/** Parses a PHP literal expression; non-literals come back as { __expr }. */
export function parsePhpValue(expr: string): PhpValue {
  const t = expr.trim();
  const s = unquote(t);
  if (s !== null && /^['"]/.test(t)) return s;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^null$/i.test(t)) return null;
  let inner: string | null = null;
  if (t.startsWith('[') && t.endsWith(']')) inner = t.slice(1, -1);
  else if (/^array\s*\(/i.test(t) && t.endsWith(')')) inner = t.slice(t.indexOf('(') + 1, -1);
  if (inner === null) return { __expr: t };
  const parts = splitTopLevel(inner, ',', Q).filter((p) => p !== '');
  const keyed = parts.some((p) => splitTopLevel(p, '=>', Q).length > 1);
  if (!keyed) return parts.map(parsePhpValue);
  const obj: { [k: string]: PhpValue } = {};
  let idx = 0;
  for (const p of parts) {
    const kv = splitTopLevel(p, '=>', Q);
    if (kv.length > 1) {
      const k = unquote(kv[0]) ?? kv[0].trim();
      obj[k] = parsePhpValue(kv.slice(1).join('=>'));
    } else obj[String(idx++)] = parsePhpValue(p);
  }
  return obj;
}

export function phpStr(v: PhpValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function phpList(v: PhpValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object' && !('__expr' in v)) return Object.values(v).filter((x): x is string => typeof x === 'string');
  return [];
}

/** Resolves a class reference against the file's namespace and imports. */
export function resolveClass(ref: string, file: Pick<PhpFile, 'namespace' | 'uses'>): string {
  const r = ref.replace(/::class$/, '').trim();
  if (r.startsWith('\\')) return r.slice(1);
  const [head, ...rest] = r.split('\\');
  const imported = file.uses.get(head);
  if (imported) return [imported, ...rest].join('\\');
  return file.namespace ? `${file.namespace}\\${r}` : r;
}

/** Top-level keys of a PHP array literal ("['a' => 1, 'b' => 2]" → [a, b]). */
export function arrayKeys(expr: string): string[] {
  const v = parsePhpValue(expr);
  if (v && typeof v === 'object' && !Array.isArray(v) && !('__expr' in v)) return Object.keys(v).filter((k) => !/^\d+$/.test(k));
  return [];
}
