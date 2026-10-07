/**
 * Client-side analysis: forms/links/scripts in templates, and the HTTP calls
 * (fetch, axios, jQuery, XHR) made by browser JavaScript.
 */
import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { ClientCall } from '../schema/graph';
import { extractForms, extractLinks, extractScriptSrcs, inlineScripts, interpretUrl } from '../parsers/html';
import { matchBracket, splitTopLevel, unquote } from '../parsers/common';
import { stripJs } from '../parsers/js';
import { LineIndex, countLines, squash, uniq } from '../utils/text';

const CLIENT_DIRS = /(^|\/)(public|static|assets|webroot|www|resources\/js|resources\/assets|frontend|client|js|scripts?)\//;
const LIBRARY = /(^|\/)(vendor|vendors|lib|libs|plugins?|bower_components|third[-_]?party|externals?|dist)\/|(jquery|bootstrap|popper|chart|select2|datatables?|moment|lodash|underscore|axios|vue|react|angular|alpine|htmx|sweetalert|toastr|summernote|tinymce|ckeditor|fontawesome|swiper|slick|owl\.carousel|gsap|three|leaflet|highcharts|apexcharts|dropzone|flatpickr|daterangepicker|quill|feather|lucide|tabler|adminlte|core-js|polyfill|modernizr)[\w.\-]*\.js$/i;

/** Literal or best-effort URL text of a JS argument expression. */
export function urlFromArg(arg: string): string | undefined {
  const a = (arg || '').trim();
  if (!a) return undefined;
  if (/<\?|\{\{|\{%/.test(a)) {
    const inner = a.replace(/^['"`]|['"`]$/g, '');
    const ref = interpretUrl(inner);
    return ref ? ref.path || (ref.name ? `name:${ref.name}` : undefined) : undefined;
  }
  const lit = unquote(a);
  if (lit !== null) {
    const ref = interpretUrl(lit);
    return ref?.path;
  }
  if (a.startsWith('`')) {
    const ref = interpretUrl(a.slice(1, -1).replace(/\$\{[^}]*\}/g, '{x}'));
    return ref?.path;
  }
  const parts = splitTopLevel(a, '+');
  if (parts.length > 1) {
    const joined = parts.map((p) => unquote(p) ?? '{x}').join('').replace(/^(\{x\})+/, '');
    const ref = interpretUrl(joined || '');
    return ref?.path;
  }
  return undefined;
}

/** HTTP calls inside a chunk of JavaScript. `lineOf` maps an offset in `code` to a file line. */
export function extractCalls(src: string, file: string, lineOf: (o: number) => number): ClientCall[] {
  const code = stripJs(src);
  const out: ClientCall[] = [];
  const constant = (name: string): string | undefined => {
    const m = new RegExp(`(?:const|let|var)\\s+${name.replace(/[$]/g, '\\$')}\\s*=\\s*([^;\\n]+)|\\b${name.replace(/[$]/g, '\\$')}\\s*:\\s*(['"\`][^'"\`]*['"\`])`).exec(code) ||
      new RegExp(`(?:const|let|var)\\s+${name.replace(/[$]/g, '\\$')}\\s*=\\s*([^;\\n]+)`).exec(src);
    return m ? (m[1] || m[2]).trim() : undefined;
  };
  const push = (kind: ClientCall['kind'], method: string, urlArg: string, at: number, context?: string) => {
    let arg = urlArg.trim();
    // URL held in a constant: const SAVE_URL = '<?= base_url("x") ?>'; fetch(SAVE_URL)
    const head = /^([A-Za-z_$][\w$]*)(\s*\+[\s\S]*)?$/.exec(arg);
    if (head && !/^(true|false|null|undefined)$/.test(head[1])) {
      const value = constant(head[1]);
      if (value && value.length < 300) arg = value + (head[2] || '');
    }
    const url = urlFromArg(arg);
    out.push({ kind, method: method.toUpperCase(), url: url || squash(urlArg, 60) || '(dynamic)', file, line: lineOf(at), context });
  };
  let m: RegExpExecArray | null;
  const FETCH = /(?:^|[^\w$.])fetch\s*\(/g;
  while ((m = FETCH.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(code, open);
    const args = splitTopLevel(code.slice(open + 1, close < 0 ? code.length : close));
    const method = /method\s*:\s*['"`](\w+)/i.exec(args[1] || '')?.[1] || 'GET';
    push('fetch', method, args[0] || '', m.index);
  }
  const AXIOS = /\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(/g;
  while ((m = AXIOS.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(code, open);
    push('axios', m[1], splitTopLevel(code.slice(open + 1, close < 0 ? code.length : close))[0] || '', m.index);
  }
  const AXIOS_CFG = /\baxios\s*\(\s*\{/g;
  while ((m = AXIOS_CFG.exec(code))) {
    const open = m.index + m[0].length - 1;
    const body = code.slice(open, matchBracket(code, open) + 1);
    push('axios', /method\s*:\s*['"`](\w+)/i.exec(body)?.[1] || 'GET', /url\s*:\s*([^,\n}]+)/.exec(body)?.[1] || '', m.index);
  }
  const JQ = /\$\s*\.\s*(ajax|post|get|getJSON)\s*\(|\)\s*\.\s*load\s*\(\s*['"`]/g;
  while ((m = JQ.exec(code))) {
    const open = code.indexOf('(', m.index);
    const close = matchBracket(code, open);
    const inner = code.slice(open + 1, close < 0 ? code.length : close);
    const fn = m[1] || 'load';
    if (fn === 'ajax') {
      const args = splitTopLevel(inner);
      const cfg = args.find((x) => x.startsWith('{')) || '';
      const url = args[0] && !args[0].startsWith('{') ? args[0] : /\burl\s*:\s*([^\n]+?)\s*,?\s*(?:\n|$)/.exec(cfg)?.[1]?.replace(/,\s*$/, '') || '';
      push('jquery', /(?:type|method)\s*:\s*['"`](\w+)/i.exec(cfg)?.[1] || 'GET', url, m.index);
    } else push('jquery', fn === 'post' ? 'POST' : 'GET', splitTopLevel(inner)[0] || '', m.index);
  }
  const XHR = /\.open\s*\(\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*,\s*([^,)]+)/gi;
  while ((m = XHR.exec(code))) push('xhr', m[1], m[2], m.index);
  const WS = /new\s+WebSocket\s*\(\s*([^),]+)/g;
  while ((m = WS.exec(code))) push('websocket', 'WS', m[1], m.index);
  return out;
}

function eventsAndFunctions(code: string): { events: string[]; functions: string[] } {
  const events = uniq(Array.from(code.matchAll(/addEventListener\(\s*['"`]([\w:.\-]+)['"`]|\.on\(\s*['"`]([\w:.\- ]+)['"`]|\.(click|change|submit|keyup|keydown|input|blur|focus)\(\s*(?:function|\(|\w+\s*=>)/g)).map((m) => m[1] || m[2] || m[3]));
  const functions = uniq(Array.from(code.matchAll(/function\s+([\w$]+)\s*\(|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/g)).map((m) => m[1] || m[2]));
  return { events: events.slice(0, 40), functions: functions.slice(0, 80) };
}

function csrfToken(engine: string, g: GraphBuilder): RegExp | null {
  if (engine === 'blade') return /@csrf|csrf_field\(|csrf_token\(|_token/;
  if (engine === 'django' || engine === 'jinja') return /csrf_token|csrf_input|hidden_tag\(/;
  if (engine === 'php' && g.middleware.get('middleware:csrf')?.kind === 'global') return /csrf_field\(|csrf_hash\(|csrf_token\(|csrf_meta|_token/;
  if (engine === 'ejs' || engine === 'pug' || engine === 'hbs') return g.middleware.has('middleware:csurf') ? /csrf/i : null;
  return null;
}

/** Fills forms, links, scripts and inline calls of every view, and indexes client-side script files. */
export function analyzeFrontend(ctx: ScanContext, g: GraphBuilder, serverFiles: Set<string>): void {
  for (const v of g.views.values()) {
    const src = ctx.read(v.file);
    if (!src) continue;
    const lines = new LineIndex(src);
    if (!v.forms.length) {
      const forms = extractForms(src, lines);
      v.forms = forms.map((f) => {
        const ref = interpretUrl(f.action);
        return { action: ref?.path || (ref?.name ? `name:${ref.name}` : f.action || '(same URL)'), method: f.method, line: f.line, multipart: f.multipart || undefined };
      });
      const token = csrfToken(v.engine, g);
      const missing = token ? forms.filter((f) => f.method !== 'GET' && !token.test(f.inner)) : [];
      if (missing.length) {
        g.addFinding({
          severity: 'medium', category: 'security', rule: 'form-missing-csrf', file: v.file, line: missing[0].line,
          title: `${missing.length} state-changing form${missing.length > 1 ? 's' : ''} without a CSRF token`,
          detail: 'The form posts data but no CSRF token field was found inside it. Either the request is rejected by the framework or the endpoint is unprotected.',
        });
      }
    }
    if (!v.links.length) {
      const seen = new Set<string>();
      for (const l of extractLinks(src, lines)) {
        const ref = interpretUrl(l.href);
        if (!ref || ref.external) continue;
        const url = ref.path || `name:${ref.name}`;
        if (seen.has(url) || /\.(css|js|png|jpe?g|gif|svg|webp|ico|pdf|zip|xlsx?|docx?|csv|mp4|woff2?)$/i.test(url)) continue;
        seen.add(url);
        v.links.push({ url, line: l.line });
        if (v.links.length >= 120) break;
      }
    }
    if (!v.scripts.length) v.scripts = uniq(extractScriptSrcs(src, lines)).slice(0, 40);
    for (const block of inlineScripts(src)) {
      v.calls.push(...extractCalls(block.code, v.file, (o) => lines.lineAt(block.offset + o)).map((c) => ({ ...c, context: 'inline <script>' })));
    }
  }

  for (const f of ctx.files) {
    if (!/\.(m?js|jsx|ts|tsx|vue|svelte)$/.test(f.path) || /\.min\.js$|\.d\.ts$/.test(f.path)) continue;
    if (serverFiles.has(f.path) || f.size > 400_000 || LIBRARY.test(f.path)) continue;
    const isClient = CLIENT_DIRS.test(f.path) || /\.(vue|svelte|jsx|tsx)$/.test(f.path);
    if (!isClient) continue;
    const src = ctx.read(f.path);
    if (!src) continue;
    const lines = new LineIndex(src);
    const calls = extractCalls(src, f.path, (o) => lines.lineAt(o));
    const { events, functions } = eventsAndFunctions(stripJs(src));
    if (!calls.length && !events.length && functions.length < 2) continue;
    const id = `script:${f.path}`;
    const usedBy = Array.from(g.views.values())
      .filter((v) => v.scripts.some((s) => s && (f.path.endsWith(s.replace(/^\/+/, '')) || (s.length > 3 && s.endsWith('/' + f.path.split('/').pop())))))
      .map((v) => v.id);
    g.scripts.set(id, { id, file: f.path, lines: countLines(src), functions, events, calls, usedBy });
    for (const v of usedBy) g.addEdge(v, id, 'loads-script');
  }
}
