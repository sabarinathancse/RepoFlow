/** Controller/view analysis shared by the PHP framework adapters. */
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { ModelNode, HandlerNode } from '../../schema/graph';
import { parsePhp, PhpClass, PhpFile, stripPhp } from '../../parsers/php';
import { analyzeBody, phpModelAliases } from '../../analyzers/steps';
import { LineIndex, uniq } from '../../utils/text';

export interface ParsedPhpClass extends PhpClass {
  file: string;
  php: PhpFile;
}

const PHP_CACHE = new WeakMap<ScanContext, Map<string, ParsedPhpClass[]>>();

/** Parses the classes of each file once per scan. */
export function parsePhpClasses(ctx: ScanContext, files: string[]): ParsedPhpClass[] {
  let cache = PHP_CACHE.get(ctx);
  if (!cache) PHP_CACHE.set(ctx, (cache = new Map()));
  const out: ParsedPhpClass[] = [];
  for (const f of files) {
    let classes = cache.get(f);
    if (!classes) {
      const src = ctx.read(f);
      if (!src) continue;
      const php = parsePhp(src);
      classes = php.classes.map((c) => ({ ...c, file: f, php }));
      cache.set(f, classes);
    }
    out.push(...classes);
  }
  return out;
}

export interface ControllerOptions {
  framework: string;
  areaOf(cls: ParsedPhpClass): string;
  /** short model name → model node */
  models: Map<string, ModelNode>;
  resolveView(name: string, fromFile: string): string | undefined;
  /** method names that are framework plumbing, not request handlers */
  skipMethods?: Set<string>;
}

const PLUMBING = new Set(['__construct', 'initController', '__destruct', '__get', '__set', '__call', '__invoke_', '_remap', 'middleware', 'callAction']);

/** Adds containers + handlers for every method of the given controller classes. */
export function analyzePhpControllers(ctx: ScanContext, g: GraphBuilder, classes: ParsedPhpClass[], opts: ControllerOptions): void {
  const skip = opts.skipMethods || PLUMBING;
  for (const cls of classes) {
    if (cls.kind !== 'class') continue;
    const containerId = `controller:${cls.fqcn}`;
    const area = opts.areaOf(cls);
    const container = g.addContainer({
      id: containerId, name: cls.fqcn.replace(/^App\\(Http\\)?Controllers\\/, '').replace(/^App\\/, ''), kind: 'controller', file: cls.file,
      line: cls.line, area, extends: cls.extends, framework: opts.framework,
    });
    const aliases = phpModelAliases(cls.php.code.slice(cls.bodyOffset, cls.bodyEnd + 1));
    const siblings = new Set(cls.methods.map((m) => m.name));
    for (const meth of cls.methods) {
      if (skip.has(meth.name) || !meth.body) continue;
      const local = new Map<string, string>();
      for (const lm of meth.body.matchAll(/\$(\w+)\s*=\s*(?:new\s+\\?([\w\\]+)\s*\(|model\(\s*['"]?\\?([\w\\]+?)(?:::class)?['"]?\s*[,)])/g)) {
        local.set(lm[1], (lm[2] || lm[3]).split('\\').pop()!);
      }
      const resolveModel = (expr: string): string | undefined => {
        const e = expr.trim();
        let name: string | undefined;
        let m = /^\$this->(\w+)$/.exec(e);
        if (m) name = aliases.get(m[1]) || ucfirst(m[1]);
        else if ((m = /^\$(\w+)$/.exec(e))) name = local.get(m[1]) || aliases.get(m[1]) || ucfirst(m[1]);
        else name = e.split('\\').pop();
        if (!name) return undefined;
        const resolved = cls.php.uses.get(name)?.split('\\').pop() || name;
        return opts.models.has(resolved) ? resolved : undefined;
      };
      const lines = cls.php.lines;
      const res = analyzeBody(meth.body, (off) => lines.lineAt(meth.bodyOffset + off), {
        lang: 'php',
        resolveModel,
        modelTable: (n) => opts.models.get(n)?.table,
        siblings,
      });
      const id = `${cls.fqcn}::${meth.name}`;
      const h: HandlerNode = g.addHandler({
        id, name: meth.name, container: containerId, kind: 'method', file: cls.file, line: meth.line, endLine: meth.endLine,
        params: meth.params, visibility: meth.visibility, framework: opts.framework, area,
      });
      Object.assign(h, {
        steps: res.steps,
        models: uniq(res.models.map((n) => opts.models.get(n)!.id)),
        tables: res.tables,
        data: res.data.map((d) => ({ ...d, model: d.model ? opts.models.get(d.model)?.id : undefined })),
        responses: res.responses,
      });
      for (const v of res.views) {
        const viewId = opts.resolveView(v.name, cls.file);
        h.views.push({ view: viewId || v.name, vars: v.vars, line: v.line });
        if (viewId) g.addEdge(id, viewId, 'renders');
      }
      if (!container.handlers.includes(id)) container.handlers.push(id);
      g.addEdge(containerId, id, 'contains');
    }
  }
}

function ucfirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const SUPERGLOBALS = new Set(['this', 'GLOBALS', '_GET', '_POST', '_REQUEST', '_SERVER', '_SESSION', '_COOKIE', '_FILES', '_ENV', 'e', 'key', 'value', 'i', 'k', 'v']);

/** Variables a PHP template reads but does not define itself. */
export function phpTemplateVars(src: string): string[] {
  const code = stripPhp(src);
  const defined = new Set<string>();
  for (const m of code.matchAll(/\bas\s+\$(\w+)(?:\s*=>\s*\$(\w+))?/g)) {
    defined.add(m[1]);
    if (m[2]) defined.add(m[2]);
  }
  for (const m of code.matchAll(/\$(\w+)\s*=(?![=>])/g)) defined.add(m[1]);
  for (const m of code.matchAll(/function\s*\(([^)]*)\)/g)) for (const p of m[1].matchAll(/\$(\w+)/g)) defined.add(p[1]);
  const seen: string[] = [];
  for (const m of code.matchAll(/\$([a-zA-Z_]\w*)/g)) {
    const v = m[1];
    if (SUPERGLOBALS.has(v) || defined.has(v) || seen.includes(v)) continue;
    seen.push(v);
    if (seen.length >= 60) break;
  }
  return seen;
}

export function phpLines(src: string): LineIndex {
  return new LineIndex(src);
}

/** Base classes whose methods are known to come only from the framework (no request actions). */
const PLAIN_BASES = /^(\\?CodeIgniter\\Controller|Controller|BaseController|\\?Illuminate\\Routing\\Controller|\\?App\\Http\\Controllers\\Controller)$/;

/**
 * Whether `method` is defined on `cls` or a parsed ancestor. Returns undefined when an
 * ancestor is outside the scan (e.g. a framework ResourceController) or uses magic dispatch.
 */
export function methodExists(cls: ParsedPhpClass, method: string, all: ParsedPhpClass[], depth = 0): boolean | undefined {
  if (depth > 8) return undefined;
  if (cls.methods.some((m) => m.name.toLowerCase() === method.toLowerCase() || m.name === '_remap' || m.name === '__call')) return true;
  // traits: "use A, B;" inside the class body
  let unknownTrait = false;
  for (const u of cls.classText.matchAll(/(?:^|[;{}])\s*use\s+([\w\\,\s]+?)\s*[;{]/g)) {
    for (const name of u[1].split(',').map((x) => x.trim().split('\\').pop()!).filter(Boolean)) {
      const trait = all.find((c) => c.kind === 'trait' && c.name === name);
      if (!trait) {
        unknownTrait = true;
        continue;
      }
      const r = methodExists(trait, method, all, depth + 1);
      if (r) return true;
      if (r === undefined) unknownTrait = true;
    }
  }
  if (unknownTrait) return undefined;
  if (!cls.extends) return false;
  const parentName = cls.extends.split('\\').pop()!;
  const parent = all.find((c) => c.name === parentName && c !== cls);
  if (parent) return methodExists(parent, method, all, depth + 1);
  return PLAIN_BASES.test(cls.extends) ? false : undefined;
}
