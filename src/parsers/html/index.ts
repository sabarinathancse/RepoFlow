/**
 * Extracts forms, links and script tags from HTML and server templates
 * (PHP, Blade, Django/Jinja, EJS, Handlebars), with line numbers.
 */
import { LineIndex } from '../../utils/text';

/** Template expressions that may contain ">" or quotes inside an HTML tag. */
const TEMPLATE_SEGMENT = /<\?(?:php|=)?[\s\S]*?\?>|\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}|\{%[\s\S]*?%\}|<%[\s\S]*?%>/g;

export interface TagInfo {
  attrs: Record<string, string>;
  line: number;
  offset: number;
  end: number;
}

/** Finds opening tags of `name` and parses their attributes. */
export function findTags(src: string, name: string, lines?: LineIndex): TagInfo[] {
  const idx = lines || new LineIndex(src);
  const out: TagInfo[] = [];
  const re = new RegExp(`<${name}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    let i = start + m[0].length;
    // find the end of the tag, skipping template segments and quoted values
    let end = -1;
    while (i < src.length) {
      if (src.startsWith('<?', i)) {
        const e = src.indexOf('?>', i + 2);
        i = e < 0 ? src.length : e + 2;
        continue;
      }
      if (src.startsWith('{{', i) || src.startsWith('{%', i) || src.startsWith('{!!', i) || src.startsWith('<%', i)) {
        const closer = src.startsWith('{{', i) ? '}}' : src.startsWith('{%', i) ? '%}' : src.startsWith('{!!', i) ? '!!}' : '%>';
        const e = src.indexOf(closer, i + 2);
        i = e < 0 ? src.length : e + closer.length;
        continue;
      }
      const c = src[i];
      if (c === '"' || c === "'") {
        const e = src.indexOf(c, i + 1);
        // a quote that never closes inside a tag usually means template code; stop at ">" instead
        if (e < 0 || src.slice(i, e).includes('\n<')) {
          i++;
          continue;
        }
        i = e + 1;
        continue;
      }
      if (c === '>') {
        end = i;
        break;
      }
      i++;
    }
    if (end < 0) break;
    out.push({ attrs: parseAttrs(src.slice(start + m[0].length, end)), line: idx.lineAt(start), offset: start, end });
    re.lastIndex = end;
  }
  return out;
}

export function parseAttrs(raw: string): Record<string, string> {
  const segments: string[] = [];
  const masked = raw.replace(TEMPLATE_SEGMENT, (s) => {
    segments.push(s);
    return `\u0000${segments.length - 1}\u0000`;
  });
  const restore = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_, n) => segments[Number(n)]);
  const attrs: Record<string, string> = {};
  const re = /([\w:@.\-]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (/^\u0000/.test(m[0])) continue;
    const v = m[3] ?? m[4] ?? m[2] ?? '';
    attrs[m[1].toLowerCase()] = restore(v);
  }
  return attrs;
}

export interface UrlRef {
  /** a URL path ("/admin/users") */
  path?: string;
  /** a route name or "Controller::method" reference */
  name?: string;
  external?: boolean;
}

/** Interprets an href/action/fetch URL that may contain template helpers. */
export function interpretUrl(raw: string): UrlRef | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^(#|javascript:|mailto:|tel:|data:|sms:|whatsapp:)/i.test(v)) return null;
  let m = /\b(?:route_to|url_to)\(\s*['"]([^'"]+)['"]/.exec(v);
  if (m) return { name: m[1] };
  m = /\{%-?\s*url\s+['"]([^'"]+)['"]/.exec(v);
  if (m) return { name: m[1] };
  m = /\burl_for\(\s*['"]([^'"]+)['"]/.exec(v);
  if (m) return { name: m[1] };
  m = /(?:^|[^\w.>$])route\(\s*['"]([^'"]+)['"]/.exec(v);
  if (m) return { name: m[1] };
  m = /\b(?:base_url|site_url|url|secure_url|action)\(\s*['"]([^'"]*)['"](\s*\.)?/.exec(v);
  if (m) {
    if (/::|@/.test(m[1])) return { name: m[1] };
    // base_url('products/' . $slug) → /products/{x}
    const tail = m[2] && !/[?#]/.test(m[1]) ? (m[1].endsWith('/') ? '{x}' : '/{x}') : '';
    return { path: ('/' + m[1].replace(/^\/+/, '').split(/[?#]/)[0] + tail).replace(/\/{2,}/g, '/') };
  }
  const literal = v.replace(TEMPLATE_SEGMENT, '{x}').replace(/\$\{[^}]*\}/g, '{x}').trim();
  if (/^(https?:)?\/\//i.test(literal)) return { path: literal, external: true };
  const cleaned = literal.replace(/^\{x\}/, '').split(/[?#]/)[0];
  if (!cleaned || cleaned === '{x}') return null;
  if (/^[\w\-./{}]+$/.test(cleaned)) return { path: '/' + cleaned.replace(/^\/+/, '') };
  return null;
}

export interface FormTag {
  action: string;
  method: string;
  line: number;
  multipart: boolean;
  /** the raw template text between <form> and </form> */
  inner: string;
}

export function extractForms(src: string, lines?: LineIndex): FormTag[] {
  const out: FormTag[] = [];
  for (const t of findTags(src, 'form', lines)) {
    const close = src.toLowerCase().indexOf('</form', t.end);
    let method = (t.attrs.method || 'GET').toUpperCase();
    const inner = src.slice(t.end, close < 0 ? Math.min(src.length, t.end + 5000) : close);
    // Spoofed methods: Laravel @method('PUT'), hidden _method inputs.
    const spoof = /@method\(\s*['"](\w+)['"]|name=["']_method["'][^>]*value=["'](\w+)["']|value=["'](\w+)["'][^>]*name=["']_method["']/i.exec(inner);
    if (spoof) method = (spoof[1] || spoof[2] || spoof[3]).toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) method = 'POST';
    out.push({ action: t.attrs.action ?? '', method, line: t.line, multipart: /multipart/i.test(t.attrs.enctype || ''), inner });
  }
  return out;
}

export function extractLinks(src: string, lines?: LineIndex): Array<{ href: string; line: number }> {
  return findTags(src, 'a', lines)
    .filter((t) => t.attrs.href)
    .map((t) => ({ href: t.attrs.href, line: t.line }));
}

export function extractScriptSrcs(src: string, lines?: LineIndex): string[] {
  const out: string[] = [];
  for (const t of findTags(src, 'script', lines)) {
    if (!t.attrs.src) continue;
    const ref = interpretUrl(t.attrs.src);
    const s = t.attrs.src.match(/['"]([^'"]+\.m?js[^'"]*)['"]/)?.[1] || ref?.path || t.attrs.src;
    out.push(s.replace(/[?#].*$/, ''));
  }
  return out;
}

/** Inline <script> blocks (no src), with their starting offset. */
export function inlineScripts(src: string): Array<{ code: string; offset: number }> {
  const out: Array<{ code: string; offset: number }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/\bsrc\s*=/.test(m[1]) || /type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1])) continue;
    out.push({ code: m[2], offset: m.index + m[0].indexOf('>') + 1 });
  }
  return out;
}
