/** Laravel adapter: routes, middleware, controllers, Eloquent models, migrations and Blade views. */
import { Adapter, Detection } from '../types';
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { FieldInfo, ModelNode, RelationInfo } from '../../schema/graph';
import { parsePhp, parsePhpValue, phpList, PhpFile, PhpValue, resolveClass, stripPhp } from '../../parsers/php';
import { callArgs, maskStrings, matchBracket, unquote } from '../../parsers/common';
import { analyzeBody } from '../../analyzers/steps';
import { analyzePhpControllers, methodExists, parsePhpClasses, ParsedPhpClass } from '../shared/php';
import { composerVersion } from '../shared/manifest';
import { LineIndex, normalizeUrlPath, plural, singular, snake, uniq } from '../../utils/text';

interface Attrs {
  prefix: string;
  middleware: string[];
  name: string;
  controller?: string;
  namespace?: string;
}

interface Seg {
  name: string;
  args: string[];
  open: number;
  close: number;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'resource', 'apiResource', 'resources', 'apiResources', 'view', 'redirect', 'permanentRedirect', 'fallback', 'singleton']);

export const laravel: Adapter = {
  id: 'laravel',
  name: 'Laravel',
  language: 'PHP',

  detect(ctx) {
    const out: Detection[] = [];
    for (const f of ctx.files) {
      const m = /^(?:(.*)\/)?artisan$/.exec(f.path);
      if (!m) continue;
      const root = m[1] || '.';
      const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
      const composer = ctx.readJson(p('composer.json'));
      const hasFramework = !!composer?.require?.['laravel/framework'];
      if (!hasFramework && !ctx.has(p('routes/web.php'))) continue;
      out.push({
        id: 'laravel', name: 'Laravel', language: 'PHP', root, confidence: hasFramework ? 0.98 : 0.7,
        evidence: [f.path, ...(hasFramework ? [`${p('composer.json')} requires laravel/framework`] : []), ...(ctx.has(p('routes/web.php')) ? [p('routes/web.php')] : [])],
        version: composerVersion(ctx, root, 'laravel/framework'),
      });
    }
    return out;
  },

  analyze(ctx, det, g) {
    const root = det.root;
    const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
    hints(g, root);

    // ---------------------------------------------------------- models
    const models = new Map<string, ModelNode>();
    const modelFiles = ctx.under(p('app'), '.php').filter((f) => /\/Models\//.test(f.path) || /^app\/\w+\.php$/.test(root === '.' ? f.path : f.path.slice(root.length + 1))).map((f) => f.path);
    for (const cls of parsePhpClasses(ctx, modelFiles)) {
      if (cls.kind !== 'class' || !/(Model|Authenticatable|Pivot|User)$/.test(cls.extends || '')) continue;
      const prop = (n: string) => cls.properties.find((x) => x.name === n)?.value;
      const table = unquote(prop('table')) || plural(snake(cls.name));
      const fields: FieldInfo[] = [{ name: unquote(prop('primaryKey')) || 'id', primary: true }];
      for (const f of phpList(parsePhpValue(prop('fillable') || '[]'))) if (!fields.some((x) => x.name === f)) fields.push({ name: f });
      const casts = parsePhpValue(prop('casts') || '[]');
      if (casts && typeof casts === 'object' && !Array.isArray(casts) && !('__expr' in casts)) {
        for (const [k, v] of Object.entries(casts)) {
          const f = fields.find((x) => x.name === k);
          if (f) f.type = String(v);
          else fields.push({ name: k, type: String(v) });
        }
      }
      const relations: RelationInfo[] = [];
      for (const m of cls.methods) {
        const r = /return\s+\$this->(hasMany|hasOne|belongsTo|belongsToMany|morphMany|morphOne|morphTo|morphToMany|morphedByMany|hasManyThrough|hasOneThrough)\(\s*(?:\\?([\w\\]+)::class|['"]([\w\\]+)['"])?/.exec(m.body);
        if (r) relations.push({ kind: r[1], target: (r[2] || r[3] || '').split('\\').pop() || '(polymorphic)', via: m.name });
      }
      const node = g.addModel({ id: `model:${cls.fqcn}`, name: cls.name, kind: 'orm', file: cls.file, line: cls.line, table, fields, relations, framework: 'laravel' });
      models.set(cls.name, node);
    }

    // ------------------------------------------------------ migrations
    for (const f of ctx.under(p('database/migrations'), '.php')) parseMigration(ctx, g, f.path);

    // ---------------------------------------------------------- views
    const viewsRoot = p('resources/views');
    const viewByName = new Map<string, string>();
    for (const f of ctx.under(viewsRoot, '.php')) {
      const src = ctx.read(f.path);
      if (src === null) continue;
      const rel = f.path.slice(viewsRoot.length + 1).replace(/\.blade\.php$|\.php$/, '');
      const name = rel.replace(/\//g, '.');
      const blade = f.path.endsWith('.blade.php');
      const grab = (re: RegExp) => uniq(Array.from(src.matchAll(re)).map((m) => m[m.length - 1]));
      const components = uniq(Array.from(src.matchAll(/<x-([\w.\-:]+)/g)).map((m) => componentView(m[1])));
      const id = `view:${f.path}`;
      g.addView({
        id, name, file: f.path, engine: blade ? 'blade' : 'php', lines: new LineIndex(src).count,
        extends: grab(/@extends\(\s*['"]([^'"]+)['"]/g),
        includes: uniq([...grab(/@(?:include|includeIf|includeFirst|component|livewire|each)\(\s*(?:\[\s*)?['"]([^'"]+)['"]/g), ...grab(/@includeWhen\([^,]+,\s*['"]([^'"]+)['"]/g), ...components]),
        sections: uniq([...grab(/@section\(\s*['"]([^'"]+)['"]/g), ...grab(/@yield\(\s*['"]([^'"]+)['"]/g), ...grab(/@stack\(\s*['"]([^'"]+)['"]/g)]),
        vars: bladeVars(src),
        forms: [], links: [], scripts: [], calls: [],
        isLayout: /@yield\(|\{\{\s*\$slot\s*\}\}/.test(src),
      });
      viewByName.set(name, id);
    }
    const resolveView = (raw: string): string | undefined => {
      const n = raw.replace(/\//g, '.').replace(/\.blade\.php$|\.php$/, '');
      return viewByName.get(n) || viewByName.get(`components.${n}`);
    };
    for (const v of g.views.values()) {
      if (!v.file.startsWith(viewsRoot + '/')) continue;
      v.extends = v.extends.map((e) => resolveView(e) || e);
      v.includes = v.includes.map((e) => resolveView(e) || e);
      for (const e of v.extends) if (e.startsWith('view:')) g.addEdge(v.id, e, 'extends');
      for (const e of v.includes) if (e.startsWith('view:')) g.addEdge(v.id, e, 'includes');
    }

    // ---------------------------------------------------- controllers
    const ctlFiles = ctx.under(p('app/Http/Controllers'), '.php').map((f) => f.path);
    const controllers = parsePhpClasses(ctx, ctlFiles);
    analyzePhpControllers(ctx, g, controllers, {
      framework: 'laravel',
      areaOf: (c) => /\/Controllers\/(\w+)\//.exec(c.file)?.[1] || 'app',
      models,
      resolveView: (n) => resolveView(n),
    });

    // ----------------------------------------------------- middleware
    middleware(ctx, g, root);

    // --------------------------------------------------------- routes
    const ctlIndex = new Map(controllers.map((c) => [c.fqcn.toLowerCase(), c]));
    const bootstrap = ctx.read(p('bootstrap/app.php')) || '';
    const apiPrefix = /apiPrefix\s*:\s*['"]([^'"]*)['"]/.exec(bootstrap)?.[1] ?? 'api';
    for (const f of ctx.under(p('routes'), '.php')) {
      const base = f.path.split('/').pop()!;
      if (/^(console|channels)\.php$/.test(base)) continue;
      const attrs: Attrs = base === 'api.php' ? { prefix: apiPrefix, middleware: ['api'], name: '' } : { prefix: '', middleware: ['web'], name: '' };
      parseRouteFile(ctx, g, f.path, attrs, ctlIndex, controllers);
    }

    lifecycle(g, root);
    recipes(g, root);
  },
};

function componentView(tag: string): string {
  const t = tag.replace(/::/g, '.').replace(/:/g, '.');
  if (/-layout$/.test(t)) return `layouts.${t.replace(/-layout$/, '')}`;
  return `components.${t}`;
}

const BLADE_IGNORE = new Set(['loop', 'errors', 'slot', 'attributes', 'message', 'component', '__env', '__data', 'this', 'app', 'key', 'value', 'item', 'i']);
function bladeVars(src: string): string[] {
  const defined = new Set<string>();
  for (const m of src.matchAll(/\bas\s+\$(\w+)(?:\s*=>\s*\$(\w+))?/g)) {
    defined.add(m[1]);
    if (m[2]) defined.add(m[2]);
  }
  for (const m of src.matchAll(/@php[\s\S]*?@endphp|@php\(([^)]*)\)/g)) for (const a of m[0].matchAll(/\$(\w+)\s*=(?!=)/g)) defined.add(a[1]);
  for (const m of src.matchAll(/@props\(\s*\[([\s\S]*?)\]\s*\)/g)) for (const a of m[1].matchAll(/['"](\w+)['"]/g)) defined.add(a[1]);
  const out: string[] = [];
  for (const m of src.matchAll(/\$([a-zA-Z_]\w*)/g)) {
    if (BLADE_IGNORE.has(m[1]) || defined.has(m[1]) || out.includes(m[1])) continue;
    out.push(m[1]);
    if (out.length >= 60) break;
  }
  return out;
}

function parseRouteFile(ctx: ScanContext, g: GraphBuilder, file: string, attrs: Attrs, ctlIndex: Map<string, ParsedPhpClass>, controllers: ParsedPhpClass[], depth = 0): void {
  const src = ctx.read(file);
  if (!src || depth > 4) return;
  const php = parsePhp(src);
  const code = php.code;
  const masked = maskStrings(code, `'"`);
  const lines = new LineIndex(src);
  const allClasses = parsePhpClasses(ctx, ctx.files.filter((f) => f.ext === 'php' && /(^|\/)app\//.test(f.path)).map((f) => f.path));
  parseBlock({ ctx, g, file, php, code, masked, lines, ctlIndex, controllers, allClasses, depth }, 0, code.length, attrs);
}

interface FileState {
  ctx: ScanContext;
  g: GraphBuilder;
  file: string;
  php: PhpFile;
  code: string;
  masked: string;
  lines: LineIndex;
  ctlIndex: Map<string, ParsedPhpClass>;
  controllers: ParsedPhpClass[];
  allClasses: ParsedPhpClass[];
  depth: number;
}

function readChain(s: FileState, from: number): { segs: Seg[]; end: number } {
  const segs: Seg[] = [];
  let i = from;
  for (;;) {
    const re = segs.length ? /^\s*->\s*(\w+)\s*\(/ : /^\s*(?:Route\s*::|\$router\s*->)\s*(\w+)\s*\(/;
    const m = re.exec(s.masked.slice(i, i + 200));
    if (!m) break;
    const open = i + m[0].length - 1;
    const [args, close] = callArgs(s.code, open, `'"`);
    segs.push({ name: m[1], args, open, close });
    i = close + 1;
  }
  return { segs, end: i };
}

function parseBlock(s: FileState, start: number, end: number, attrs: Attrs): void {
  const re = /(?:\bRoute\s*::|\$router\s*->)\s*\w+\s*\(/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.masked)) && m.index < end) {
    const { segs, end: chainEnd } = readChain(s, m.index);
    re.lastIndex = Math.max(chainEnd, m.index + 1);
    if (!segs.length) continue;
    const line = s.lines.lineAt(m.index);
    const local: Attrs = { ...attrs, middleware: [...attrs.middleware] };
    const groupSeg = segs.find((x) => x.name === 'group');
    const verbSeg = segs.find((x) => VERBS.has(x.name));
    const applyAttr = (seg: Seg) => {
      const a0 = seg.args[0];
      if (seg.name === 'prefix') local.prefix = join(local.prefix, unquote(a0) ?? '');
      else if (seg.name === 'middleware') local.middleware.push(...strList(a0));
      else if (seg.name === 'name' || seg.name === 'as') local.name += unquote(a0) ?? '';
      else if (seg.name === 'controller') local.controller = classRef(a0, s.php);
      else if (seg.name === 'namespace') local.namespace = unquote(a0) ?? undefined;
      else if (seg.name === 'withoutMiddleware') {
        const drop = strList(a0);
        local.middleware = local.middleware.filter((x) => !drop.includes(x));
      }
    };
    if (groupSeg) {
      for (const seg of segs) if (seg !== groupSeg) applyAttr(seg);
      const ga = groupSeg.args;
      if (ga.length > 1) {
        const opts = parsePhpValue(ga[0]) as Record<string, PhpValue>;
        if (opts && typeof opts === 'object') {
          if (opts.prefix) local.prefix = join(local.prefix, String(opts.prefix));
          if (opts.middleware) local.middleware.push(...phpList(opts.middleware));
          if (typeof opts.as === 'string') local.name += opts.as;
          if (typeof opts.namespace === 'string') local.namespace = opts.namespace;
        }
      }
      const last = ga[ga.length - 1] || '';
      const brace = last.indexOf('{');
      if (/function|fn\s*\(/.test(last) && brace >= 0) {
        const bodyOpen = s.code.indexOf(last, groupSeg.open) + brace;
        const bodyClose = matchBracket(s.code, bodyOpen, `'"`);
        parseBlock(s, bodyOpen + 1, bodyClose < 0 ? end : bodyClose, local);
      } else {
        // ->group(base_path('routes/admin.php')) / ->group(__DIR__.'/admin.php')
        const f = /['"]([^'"]+\.php)['"]/.exec(last)?.[1];
        if (f) {
          const target = s.ctx.files.find((x) => x.path.endsWith(f.replace(/^\/?(routes\/)?/, 'routes/')));
          if (target) parseRouteFile(s.ctx, s.g, target.path, local, s.ctlIndex, s.controllers, s.depth + 1);
        }
      }
      continue;
    }
    if (!verbSeg) continue;
    const after = segs.slice(segs.indexOf(verbSeg) + 1);
    for (const seg of segs.slice(0, segs.indexOf(verbSeg))) applyAttr(seg);
    let routeName: string | undefined;
    const only: string[] = [];
    const except: string[] = [];
    for (const seg of after) {
      if (seg.name === 'name') routeName = local.name + (unquote(seg.args[0]) ?? '');
      else if (seg.name === 'middleware') local.middleware.push(...strList(seg.args[0]));
      else if (seg.name === 'only') only.push(...strList(seg.args[0]));
      else if (seg.name === 'except') except.push(...strList(seg.args[0]));
      else if (seg.name === 'withoutMiddleware') {
        const drop = strList(seg.args[0]);
        local.middleware = local.middleware.filter((x) => !drop.includes(x));
      }
    }
    addVerb(s, verbSeg, local, line, routeName, only, except);
  }
}

function addVerb(s: FileState, seg: Seg, a: Attrs, line: number, routeName: string | undefined, only: string[], except: string[]): void {
  const args = seg.args;
  const verb = seg.name;
  if (verb === 'resource' || verb === 'apiResource' || verb === 'singleton') {
    const name = unquote(args[0]) || '';
    const ctl = classRef(args[1], s.php, a.namespace);
    const opts = args[2] ? (parsePhpValue(args[2]) as Record<string, PhpValue>) : {};
    only.push(...phpList(opts?.only));
    except.push(...phpList(opts?.except));
    const parts = name.split('.');
    const base = parts.map((seg, i) => (i < parts.length - 1 ? `${seg}/{${singular(seg).replace(/-/g, '_')}}` : seg)).join('/');
    const param = `{${singular(parts[parts.length - 1]).replace(/-/g, '_')}}`;
    let defs: Array<[string, string, string]> = [
      ['GET', '', 'index'], ['GET', '/create', 'create'], ['POST', '', 'store'], ['GET', `/${param}`, 'show'],
      ['GET', `/${param}/edit`, 'edit'], ['PUT', `/${param}`, 'update'], ['PATCH', `/${param}`, 'update'], ['DELETE', `/${param}`, 'destroy'],
    ];
    if (verb === 'apiResource') defs = defs.filter((d) => d[2] !== 'create' && d[2] !== 'edit');
    if (verb === 'singleton') defs = [['GET', '', 'show'], ['GET', '/edit', 'edit'], ['PUT', '', 'update'], ['PATCH', '', 'update']];
    for (const [method, suffix, action] of defs) {
      if ((only.length && !only.includes(action)) || except.includes(action)) continue;
      add(s, a, method, join(a.prefix, base) + suffix, ctl ? `${ctl}@${action}` : action, line, `${a.name}${name}.${action}`, [`generated by Route::${verb}('${name}')`]);
    }
    return;
  }
  if (verb === 'resources' || verb === 'apiResources') {
    const map = parsePhpValue(args[0] || '[]');
    if (map && typeof map === 'object' && !Array.isArray(map) && !('__expr' in map)) {
      for (const [name, c] of Object.entries(map)) {
        const ctlExpr = typeof c === 'string' ? `'${c}'` : (c as { __expr: string }).__expr || '';
        addVerb(s, { ...seg, name: verb === 'resources' ? 'resource' : 'apiResource', args: [`'${name}'`, ctlExpr] }, a, line, undefined, [], []);
      }
    }
    return;
  }
  if (verb === 'view') {
    const path = join(a.prefix, unquote(args[0]) ?? '');
    const view = unquote(args[1]) || '?';
    const r = s.g.addRoute({ method: 'GET', path: normalizeUrlPath(path), name: routeName, target: `view: ${view}`, middleware: uniq(a.middleware), file: s.file, line, framework: 'laravel', notes: ['Renders a Blade view directly'] });
    const v = Array.from(s.g.views.values()).find((x) => x.name === view);
    if (v) s.g.addEdge(r.id, v.id, 'renders');
    return;
  }
  if (verb === 'redirect' || verb === 'permanentRedirect') {
    s.g.addRoute({ method: 'GET', path: normalizeUrlPath(join(a.prefix, unquote(args[0]) ?? '')), name: routeName, target: `redirect → ${unquote(args[1]) ?? args[1]}`, middleware: uniq(a.middleware), file: s.file, line, framework: 'laravel' });
    return;
  }
  if (verb === 'fallback') {
    add(s, a, 'ANY', join(a.prefix, '{fallback}'), args[0] || '', line, routeName, ['Fallback route (no other route matched)']);
    return;
  }
  let methods: string[];
  let rest = args;
  if (verb === 'match') {
    methods = phpList(parsePhpValue(args[0])).map((x) => x.toUpperCase());
    rest = args.slice(1);
  } else methods = [verb === 'any' ? 'ANY' : verb.toUpperCase()];
  const path = join(a.prefix, unquote(rest[0]) ?? '{dynamic}');
  for (const method of methods) add(s, a, method, path, rest[1] || '', line, routeName);
}

function add(s: FileState, a: Attrs, method: string, path: string, rawTarget: string, line: number, name?: string, notes?: string[]): void {
  let target = rawTarget.trim();
  let cls: string | undefined;
  let meth: string | undefined;
  const arr = /^\[\s*(\\?[\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]$/.exec(target);
  const at = /^['"]([\w\\]+)@(\w+)['"]$/.exec(target) || /^([\w\\]+)@(\w+)$/.exec(target);
  const invokable = /^(\\?[\w\\]+)::class$/.exec(target);
  if (arr) {
    cls = resolveClass(arr[1], s.php);
    meth = arr[2];
  } else if (at) {
    cls = at[1].includes('\\') && !a.namespace ? at[1] : `${a.namespace || 'App\\Http\\Controllers'}\\${at[1]}`;
    meth = at[2];
  } else if (invokable) {
    cls = resolveClass(invokable[1], s.php);
    meth = '__invoke';
  } else if (a.controller && unquote(target)) {
    cls = a.controller;
    meth = unquote(target)!;
  }
  let handlerId: string | undefined;
  if (cls && meth) {
    const found = s.ctlIndex.get(cls.toLowerCase()) || s.controllers.find((c) => c.fqcn.toLowerCase().endsWith('\\' + cls!.split('\\').pop()!.toLowerCase()));
    target = `${cls.replace(/^App\\Http\\Controllers\\/, '')}@${meth}`;
    if (found && methodExists(found, meth, s.allClasses) === false) {
      notes = [...(notes || []), `${found.name}::${meth}() does not exist`];
      s.g.addFinding({
        severity: 'medium', category: 'correctness', rule: 'route-missing-method', file: s.file, line,
        title: `Route ${method} ${normalizeUrlPath(path)} → missing ${found.name}::${meth}()`,
        detail: 'The route targets a controller method that is not defined in the class or its parents, so the request fails.',
      });
    } else if (found) handlerId = `${found.fqcn}::${meth}`;
  } else if (/^function\s*\(|^fn\s*\(|^static\s+function/.test(target)) {
    const brace = target.indexOf('{');
    const arrow = target.indexOf('=>');
    const body = brace >= 0 ? target.slice(brace) : arrow >= 0 ? `{ return ${target.slice(arrow + 2)}; }` : '';
    const offset = s.code.indexOf(target) + (brace >= 0 ? brace : 0);
    const res = analyzeBody(body, (o) => s.lines.lineAt(offset + o), { lang: 'php', resolveModel: () => undefined, modelTable: () => undefined });
    handlerId = `closure:${s.file}:${line}:${method}`;
    s.g.addHandler({
      id: handlerId, name: `closure (${method} ${normalizeUrlPath(path)})`, kind: 'closure', file: s.file, line, endLine: line, framework: 'laravel', area: 'routes',
      steps: res.steps, responses: res.responses, views: res.views.map((v) => {
        const vn = Array.from(s.g.views.values()).find((x) => x.name === v.name.replace(/\//g, '.'));
        if (vn) s.g.addEdge(handlerId!, vn.id, 'renders');
        return { view: vn ? vn.id : v.name, vars: v.vars, line: v.line };
      }),
    });
    target = 'Closure';
  }
  const r = s.g.addRoute({ method, path: normalizeUrlPath(path), name, target, handler: handlerId, middleware: uniq(a.middleware), file: s.file, line, framework: 'laravel', notes });
  if (handlerId) s.g.addEdge(r.id, handlerId, 'routes-to');
  for (const mw of r.middleware) s.g.addEdge(r.id, `middleware:${mw.split(':')[0]}`, 'protected-by');
}

function classRef(expr: string | undefined, php: PhpFile, ns?: string): string | undefined {
  if (!expr) return undefined;
  const m = /^(\\?[\w\\]+)::class$/.exec(expr.trim());
  if (m) return resolveClass(m[1], php);
  const s = unquote(expr);
  if (s) return s.includes('\\') ? s.replace(/^\\/, '') : `${ns || 'App\\Http\\Controllers'}\\${s}`;
  return undefined;
}

function strList(expr: string | undefined): string[] {
  if (!expr) return [];
  return phpList(parsePhpValue(expr)).map((x) => x.trim()).filter(Boolean);
}

function join(a: string, b: string): string {
  return [a, b].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

function middleware(ctx: ScanContext, g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  const kernel = ctx.read(p('app/Http/Kernel.php'));
  const add = (name: string, kind: 'global' | 'alias' | 'group', cls: string, desc?: string) => {
    const rel = cls.replace(/^\\/, '').replace(/::class$/, '').replace(/^App\\/, 'app/').replace(/\\/g, '/') + '.php';
    const file = ctx.has(p(rel)) ? p(rel) : undefined;
    g.addMiddleware({ id: `middleware:${name}`, name, kind, file, framework: 'laravel', description: desc || (file ? middlewareDescription(ctx, file) : undefined) || `${cls.replace(/::class$/, '').split('\\').pop()}` });
  };
  if (kernel) {
    const php = parsePhp(kernel);
    const cls = php.classes[0];
    const prop = (n: string) => {
      const v = cls?.properties.find((x) => x.name === n)?.value;
      return v ? parsePhpValue(v) : null;
    };
    for (const c of asExprList(prop('middleware'))) add(c.split('\\').pop()!.replace(/::class$/, ''), 'global', resolveClass(c, php), 'Runs on every request (Kernel::$middleware)');
    const groups = prop('middlewareGroups');
    if (groups && typeof groups === 'object' && !Array.isArray(groups) && !('__expr' in groups)) {
      for (const [name, list] of Object.entries(groups)) {
        const items = asExprList(list).map((c) => c.replace(/::class$/, '').split('\\').pop());
        g.addMiddleware({ id: `middleware:${name}`, name, kind: 'group', framework: 'laravel', file: p('app/Http/Kernel.php'), description: `Group: ${items.join(', ')}` });
      }
    }
    const aliases = prop('middlewareAliases') || prop('routeMiddleware');
    if (aliases && typeof aliases === 'object' && !Array.isArray(aliases) && !('__expr' in aliases)) {
      for (const [name, c] of Object.entries(aliases)) {
        const expr = typeof c === 'string' ? c : (c as { __expr?: string }).__expr || '';
        add(name, 'alias', resolveClass(expr, php));
      }
    }
  }
  const boot = ctx.read(p('bootstrap/app.php'));
  if (boot) {
    const php = parsePhp(boot);
    for (const m of php.code.matchAll(/->alias\(\s*(\[[\s\S]*?\])\s*\)/g)) {
      const v = parsePhpValue(m[1]);
      if (v && typeof v === 'object' && !Array.isArray(v) && !('__expr' in v)) for (const [name, c] of Object.entries(v)) add(name, 'alias', resolveClass((c as { __expr?: string }).__expr || String(c), php));
    }
  }
  const builtin: Record<string, string> = {
    web: 'Cookies, session, CSRF verification and route model binding', api: 'Stateless API stack (throttling, bindings)',
    auth: 'Requires a logged-in user (redirects guests to login)', guest: 'Only for guests (redirects logged-in users)',
    verified: 'Requires a verified email address', throttle: 'Rate limiting', 'auth:sanctum': 'Sanctum token / SPA authentication',
    can: 'Authorization gate / policy check', signed: 'Requires a valid signed URL',
  };
  for (const [name, desc] of Object.entries(builtin)) {
    const existing = g.middleware.get(`middleware:${name}`);
    if (existing) {
      if (!existing.description || /^\w+$/.test(existing.description)) existing.description = desc;
    } else g.addMiddleware({ id: `middleware:${name}`, name, kind: name === 'web' || name === 'api' ? 'group' : 'alias', framework: 'laravel', description: desc });
  }
}

function asExprList(v: PhpValue | null): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && '__expr' in x ? String((x as { __expr: string }).__expr) : '')).filter(Boolean);
}

function middlewareDescription(ctx: ScanContext, file: string): string | undefined {
  const src = ctx.read(file);
  if (!src) return undefined;
  const php = parsePhp(src);
  const h = php.classes[0]?.methods.find((m) => m.name === 'handle');
  if (!h) return undefined;
  const res = analyzeBody(h.body, (o) => php.lines.lineAt(h.bodyOffset + o), { lang: 'php', resolveModel: () => undefined, modelTable: () => undefined });
  const parts = res.steps.slice(0, 4).map((x) => x.text);
  return parts.length ? `Before the controller: ${parts.join('; ')}` : undefined;
}

function parseMigration(ctx: ScanContext, g: GraphBuilder, file: string): void {
  const src = ctx.read(file);
  if (!src) return;
  const code = stripPhp(src);
  const lines = new LineIndex(src);
  for (const m of code.matchAll(/Schema::(create|table)\(\s*['"](\w+)['"]\s*,\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?(?::\s*\w+\s*)?\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBracket(code, open, `'"`);
    const body = code.slice(open, close < 0 ? code.length : close);
    const t = g.ensureTable(m[2]);
    t.sources.push({ file, line: lines.lineAt(m.index!), kind: 'migration' });
    for (const c of body.matchAll(/\$table->(\w+)\(\s*(?:['"](\w+)['"])?([^;]*);/g)) {
      const type = c[1];
      const name = c[2];
      const rest = c[3];
      const push = (f: FieldInfo) => {
        if (!t.columns.some((x) => x.name === f.name)) t.columns.push(f);
      };
      if (type === 'id' || type === 'bigIncrements' || type === 'increments') push({ name: name || 'id', type: 'bigint', primary: true });
      else if (type === 'timestamps' || type === 'timestampsTz' || type === 'nullableTimestamps') {
        push({ name: 'created_at', type: 'timestamp', nullable: true });
        push({ name: 'updated_at', type: 'timestamp', nullable: true });
      } else if (type === 'softDeletes' || type === 'softDeletesTz') push({ name: 'deleted_at', type: 'timestamp', nullable: true });
      else if (type === 'rememberToken') push({ name: 'remember_token', type: 'string', nullable: true });
      else if (type === 'morphs' || type === 'nullableMorphs') {
        push({ name: `${name}_type`, type: 'string' });
        push({ name: `${name}_id`, type: 'bigint' });
      } else if (type === 'foreign' && name) {
        const ref = /references\(\s*['"](\w+)['"]\s*\)\s*->on\(\s*['"](\w+)['"]/.exec(rest);
        if (ref && !t.foreignKeys.some((x) => x.column === name)) t.foreignKeys.push({ column: name, references: `${ref[2]}.${ref[1]}`, inferred: false });
      } else if (name && !/^(index|unique|primary|dropColumn|dropForeign|dropIndex|renameColumn|dropUnique|dropPrimary|dropTimestamps|dropSoftDeletes)$/.test(type)) {
        push({ name, type: type.replace(/^unsigned/, '').toLowerCase(), nullable: /->nullable\(/.test(rest) || undefined, primary: /->primary\(/.test(rest) || undefined });
        if (type === 'foreignId' || type === 'foreignIdFor' || type === 'foreignUuid') {
          const con = /->constrained\(\s*(?:['"](\w+)['"])?/.exec(rest);
          if (con) {
            const target = con[1] || plural(name.replace(/_id$/, ''));
            if (!t.foreignKeys.some((x) => x.column === name)) t.foreignKeys.push({ column: name, references: `${target}.id`, inferred: false });
          }
        }
      }
    }
  }
}

function hints(g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  const H: Array<[string, string, string[]?]> = [
    ['app', 'Application code (Laravel)'], ['app/Http/Controllers', 'Request handlers'], ['app/Http/Middleware', 'HTTP middleware (auth, roles, headers…)'],
    ['app/Http/Requests', 'Form request validation classes'], ['app/Models', 'Eloquent models (one per table)'], ['app/Providers', 'Service providers: bootstrapping and bindings'],
    ['app/Http/Kernel.php', 'Global middleware, groups and aliases'], ['app/Jobs', 'Queued jobs'], ['app/Mail', 'Mailables'], ['app/Policies', 'Authorization policies'],
    ['bootstrap/app.php', 'Application bootstrap (routing and middleware in Laravel 11+)'], ['config', 'Configuration files (read with config())'],
    ['database/migrations', 'Schema migrations (php artisan migrate)'], ['database/seeders', 'Seed data'], ['database/factories', 'Model factories for tests'],
    ['resources/views', 'Blade templates'], ['resources/js', 'Front-end JavaScript (built by Vite/Mix)'], ['resources/css', 'Front-end styles'],
    ['routes', 'Route definitions'], ['routes/web.php', 'Browser routes (session, CSRF)', ['entry']], ['routes/api.php', 'API routes (stateless, /api prefix)', ['entry']],
    ['public', 'Web root: index.php front controller and built assets', ['entry']], ['public/index.php', 'Front controller', ['entry']],
    ['storage', 'Logs, cache, sessions and uploaded files (runtime)'], ['tests', 'PHPUnit / Pest tests'], ['artisan', 'Laravel CLI'],
    ['.env', 'Environment configuration: may contain secrets', ['secret']], ['.env.example', 'Template for .env'],
  ];
  for (const [path, desc, tags] of H) g.hint(p(path), desc, tags);
}

function lifecycle(g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  const routes = Array.from(g.routes.values()).filter((r) => r.framework === 'laravel').length;
  const models = Array.from(g.models.values()).filter((m) => m.framework === 'laravel').length;
  g.lifecycle.push(
    { id: 'lv-entry', title: 'Front controller', subtitle: 'public/index.php', detail: 'Every request enters public/index.php, which boots the application container (bootstrap/app.php).', files: [p('public/index.php'), p('bootstrap/app.php')] },
    { id: 'lv-kernel', title: 'Global middleware', subtitle: 'HTTP kernel', detail: 'Global middleware runs first (trusted proxies, maintenance mode, request size, string trimming).' },
    { id: 'lv-router', title: 'Router', subtitle: 'routes/*.php', detail: `The router matches one of ${routes} routes and applies its middleware group (web or api) and route middleware such as auth.`, files: [p('routes/web.php'), p('routes/api.php')] },
    { id: 'lv-controller', title: 'Controller', subtitle: 'app/Http/Controllers', detail: 'The controller action receives the Request (often a FormRequest that validates first) and route-model-bound models.' },
    { id: 'lv-eloquent', title: 'Eloquent', subtitle: `${models} models`, detail: 'Eloquent models query and persist rows; relations (hasMany, belongsTo…) load related records.' },
    { id: 'lv-view', title: 'Blade view', subtitle: 'resources/views', detail: "view('name', [...]) renders a Blade template, usually @extends a layout or uses <x-…> components." },
    { id: 'lv-response', title: 'Response', subtitle: 'HTML, JSON or redirect', detail: 'The response passes back through middleware (cookies, session) and is sent: HTML, JSON (API resources) or a redirect with flashed session data.' },
  );
}

function recipes(g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  g.recipes.push(
    { id: 'lv-page', title: 'Add a new page', summary: 'Route → controller → Blade view.', files: [p('routes/web.php'), p('app/Http/Controllers'), p('resources/views')], steps: [
      'php artisan make:controller PageController',
      "Route::get('/my-page', [PageController::class, 'show'])->name('my-page'); in routes/web.php (inside the auth group if it needs login).",
      "return view('pages.my-page', ['items' => $items]); and create resources/views/pages/my-page.blade.php that @extends your layout.",
      "Link to it with route('my-page').",
    ] },
    { id: 'lv-crud', title: 'Add CRUD for a resource', summary: 'Model + migration + resource controller.', files: [p('database/migrations'), p('app/Models')], steps: [
      'php artisan make:model Thing -mcr  (model, migration, resource controller)',
      'Define columns in the migration, then php artisan migrate.',
      'Set $fillable on the model.',
      "Route::resource('things', ThingController::class); and implement index/create/store/show/edit/update/destroy.",
      'Validate in a FormRequest (php artisan make:request StoreThingRequest).',
    ] },
    { id: 'lv-api', title: 'Add an API endpoint', summary: 'routes/api.php + JSON response.', files: [p('routes/api.php')], steps: [
      "Route::get('/things', [Api\\ThingController::class, 'index']); in routes/api.php (served under /api).",
      'Protect it with ->middleware(\'auth:sanctum\') if it is private.',
      'Return response()->json(...) or an API Resource (php artisan make:resource ThingResource).',
    ] },
  );
}
