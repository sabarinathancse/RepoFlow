/** CodeIgniter 4 adapter: routes, filters, controllers, models, migrations and views. */
import { Adapter, Detection } from '../types';
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { FieldInfo, ModelNode } from '../../schema/graph';
import { parsePhp, parsePhpValue, phpList, phpStr, PhpValue, stripPhp } from '../../parsers/php';
import { callArgs, maskStrings, matchBracket, unquote } from '../../parsers/common';
import { analyzeBody } from '../../analyzers/steps';
import { analyzePhpControllers, methodExists, parsePhpClasses, phpTemplateVars, ParsedPhpClass } from '../shared/php';
import { composerVersion } from '../shared/manifest';
import { LineIndex, joinPath, normalizeUrlPath, snake, uniq, stripExt } from '../../utils/text';

const ROUTE_VERBS = 'get|post|put|patch|delete|options|head|match|add|cli|resource|presenter|group|view|addRedirect|environment|map';

interface RouteCtx {
  prefix: string;
  filters: string[];
  namespace: string;
}

export const codeigniter4: Adapter = {
  id: 'codeigniter4',
  name: 'CodeIgniter 4',
  language: 'PHP',

  detect(ctx) {
    const out: Detection[] = [];
    for (const f of ctx.files) {
      const m = /^(?:(.*)\/)?app\/Config\/Routes\.php$/.exec(f.path);
      if (!m) continue;
      const root = m[1] || '.';
      const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
      const evidence = [f.path];
      let confidence = 0.6;
      const composer = ctx.readJson(p('composer.json'));
      const req = { ...(composer?.require || {}), ...(composer?.['require-dev'] || {}) };
      if (req['codeigniter4/framework'] || composer?.name === 'codeigniter4/appstarter') {
        confidence += 0.3;
        evidence.push(`${p('composer.json')} requires codeigniter4/framework`);
      }
      if (ctx.has(p('spark'))) {
        confidence += 0.1;
        evidence.push(p('spark'));
      }
      const routes = ctx.read(f.path) || '';
      if (!/\$routes->/.test(routes) && confidence < 0.9) continue;
      out.push({
        id: 'codeigniter4', name: 'CodeIgniter 4', language: 'PHP', root, confidence: Math.min(1, confidence), evidence,
        version: composerVersion(ctx, root, 'codeigniter4/framework') || ciSystemVersion(ctx, root),
      });
    }
    return out;
  },

  analyze(ctx, det, g) {
    const root = det.root;
    const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
    const app = p('app');
    hints(g, root);

    // ---------------------------------------------------------- models
    const modelFiles = ctx.under(app, '.php').filter((f) => /\/Models\//.test(f.path)).map((f) => f.path);
    const models = new Map<string, ModelNode>();
    for (const cls of parsePhpClasses(ctx, modelFiles)) {
      if (cls.kind !== 'class') continue;
      const prop = (n: string) => cls.properties.find((x) => x.name === n)?.value;
      const table = unquote(prop('table'));
      if (!table && !/Model$/.test(cls.extends || '')) continue;
      const fields: FieldInfo[] = [];
      const pk = unquote(prop('primaryKey')) || 'id';
      fields.push({ name: pk, primary: true });
      for (const f of phpList(parsePhpValue(prop('allowedFields') || '[]'))) if (f !== pk) fields.push({ name: f });
      if (/true/i.test(prop('useTimestamps') || '')) fields.push({ name: unquote(prop('createdField')) || 'created_at' }, { name: unquote(prop('updatedField')) || 'updated_at' });
      if (/true/i.test(prop('useSoftDeletes') || '')) fields.push({ name: unquote(prop('deletedField')) || 'deleted_at' });
      const node = g.addModel({
        id: `model:${cls.fqcn}`, name: cls.name, kind: 'orm', file: cls.file, line: cls.line, table: table || undefined,
        fields, relations: [], framework: 'codeigniter4',
      });
      models.set(cls.name, node);
    }

    // ------------------------------------------------------ migrations
    for (const f of ctx.under(app, '.php').filter((x) => /\/Database\/Migrations\//.test(x.path))) parseMigration(ctx, g, f.path);

    // ---------------------------------------------------------- views
    const viewFiles = ctx.under(app, '.php').filter((f) => /\/Views\//.test(f.path));
    const viewByName = new Map<string, string>();
    for (const f of viewFiles) {
      const src = ctx.read(f.path);
      if (src === null) continue;
      const rel = f.path.slice(f.path.indexOf('/Views/') + 7);
      const modulePrefix = /\/Modules\/(\w+)\/Views\//.exec(f.path);
      const name = stripExt(rel);
      const id = `view:${f.path}`;
      const code = stripPhp(src);
      const grab = (re: RegExp) => uniq(Array.from(code.matchAll(re)).map((m) => m[1]));
      const sections = grab(/\$this->section\(\s*['"]([^'"]+)['"]/g);
      const renders = grab(/\$this->renderSection\(\s*['"]([^'"]+)['"]/g);
      g.addView({
        id, name: modulePrefix ? `${modulePrefix[1]}:${name}` : name, file: f.path, engine: 'php',
        lines: new LineIndex(src).count,
        extends: grab(/\$this->extend\(\s*['"]([^'"]+)['"]/g),
        includes: uniq([...grab(/\$this->include\(\s*['"]([^'"]+)['"]/g), ...grab(/\bview\(\s*['"]([^'"]+)['"]/g)]),
        sections: uniq([...sections, ...renders]),
        vars: phpTemplateVars(src),
        forms: [], links: [], scripts: [], calls: [],
        isLayout: renders.length > 0,
      });
      if (!viewByName.has(name)) viewByName.set(name, id);
      if (modulePrefix) {
        viewByName.set(`${modulePrefix[1]}:${name}`, id);
        viewByName.set(`Modules/${modulePrefix[1]}/Views/${name}`, id);
        viewByName.set(`App/Modules/${modulePrefix[1]}/Views/${name}`, id);
      }
    }
    const resolveView = (raw: string): string | undefined => {
      const n = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.php$/, '');
      if (viewByName.has(n)) return viewByName.get(n);
      for (const [k, v] of viewByName) if (k.endsWith('/' + n) || n.endsWith('/' + k)) return v;
      return undefined;
    };
    for (const v of g.views.values()) {
      if (!v.file.startsWith(app + '/')) continue;
      v.extends = v.extends.map((e) => resolveView(e) || e);
      v.includes = v.includes.map((e) => resolveView(e) || e);
      for (const e of v.extends) if (e.startsWith('view:')) g.addEdge(v.id, e, 'extends');
      for (const e of v.includes) if (e.startsWith('view:')) g.addEdge(v.id, e, 'includes');
    }

    // ---------------------------------------------------- controllers
    const ctlFiles = ctx.under(app, '.php').filter((f) => /\/Controllers\//.test(f.path)).map((f) => f.path);
    const controllers = parsePhpClasses(ctx, ctlFiles);
    analyzePhpControllers(ctx, g, controllers, {
      framework: 'codeigniter4',
      areaOf: (c) => areaOf(c),
      models,
      resolveView: (n) => resolveView(n),
    });

    // -------------------------------------------------------- filters
    const filterCfg = p('app/Config/Filters.php');
    const uriFilters: Array<{ name: string; patterns: string[]; except: string[] }> = [];
    const src = ctx.read(filterCfg);
    if (src) {
      const php = parsePhp(src);
      const cls = php.classes[0];
      const prop = (n: string): PhpValue => {
        const v = cls?.properties.find((x) => x.name === n)?.value;
        return v ? parsePhpValue(v) : null;
      };
      const aliases = prop('aliases');
      if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
        for (const [name, target] of Object.entries(aliases)) {
          const cls = target && typeof target === 'object' && '__expr' in target ? String((target as { __expr: string }).__expr) : String(target);
          const fq = cls.replace(/::class$/, '').replace(/^\\/, '');
          const resolved = php.uses.get(fq.split('\\')[0]) ? `${php.uses.get(fq.split('\\')[0])}${fq.includes('\\') ? fq.slice(fq.indexOf('\\')) : ''}` : fq;
          const file = classFile(ctx, root, resolved);
          g.addMiddleware({
            id: `middleware:${name}`, name, kind: 'alias', file, framework: 'codeigniter4',
            description: file ? filterDescription(ctx, file) || `Filter class ${resolved}` : `Framework filter ${resolved.split('\\').pop()}`,
          });
        }
      }
      const globals = prop('globals');
      const before = globals && typeof globals === 'object' && !Array.isArray(globals) ? (globals as Record<string, PhpValue>).before : undefined;
      const after = globals && typeof globals === 'object' && !Array.isArray(globals) ? (globals as Record<string, PhpValue>).after : undefined;
      const globalNames = (v: PhpValue | undefined) => {
        if (!v || typeof v !== 'object') return [] as string[];
        return Array.isArray(v) ? phpList(v) : Object.entries(v).map(([k, val]) => (/^\d+$/.test(k) ? String(val) : k));
      };
      const beforeNames = globalNames(before);
      for (const n of beforeNames) g.addMiddleware({ id: `middleware:${n}`, name: n, kind: 'global', framework: 'codeigniter4', description: 'Runs before every request (Filters::$globals)' });
      for (const n of globalNames(after)) g.addMiddleware({ id: `middleware:${n}`, name: n, kind: 'global', framework: 'codeigniter4', description: 'Runs after every request (Filters::$globals)' });
      if (!beforeNames.includes('csrf')) {
        const line = cls?.properties.find((x) => x.name === 'globals')?.line;
        g.addFinding({
          severity: 'medium', category: 'security', rule: 'ci4-csrf-disabled', file: filterCfg, line,
          title: 'CSRF protection is not enabled globally',
          detail: "The 'csrf' filter is not in Filters::$globals['before'], so POST forms are not protected against cross-site request forgery unless individual routes add it.",
        });
      }
      const filters = prop('filters');
      if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
        for (const [name, cfg] of Object.entries(filters)) {
          const c = cfg as Record<string, PhpValue>;
          const patterns = [...phpList(c?.before), ...phpList(c?.after)];
          if (patterns.length) uriFilters.push({ name, patterns, except: [] });
        }
      }
    }

    // --------------------------------------------------------- routes
    const routing = ctx.read(p('app/Config/Routing.php')) || '';
    let defaultNs = /defaultNamespace\s*=\s*['"]([^'"]+)['"]/.exec(routing)?.[1]?.replace(/\\\\/g, '\\') || 'App\\Controllers';
    const autoRoute = /\$autoRoute\s*=\s*true/.test(stripPhp(routing));
    const routeFiles = ctx.under(app, 'Config/Routes.php').map((f) => f.path).sort((a, b) => (a === `${app}/Config/Routes.php` ? -1 : b === `${app}/Config/Routes.php` ? 1 : a.localeCompare(b)));
    const ctlIndex = new Map(controllers.map((c) => [c.fqcn.toLowerCase(), c]));
    const allClasses = parsePhpClasses(ctx, ctx.under(app, '.php').filter((f) => !/\/Views\//.test(f.path)).map((f) => f.path));
    for (const rf of routeFiles) {
      const text = ctx.read(rf);
      if (!text) continue;
      const code = stripPhp(text);
      if (/->setAutoRoute\(\s*true/.test(code) || (rf === `${app}/Config/Routes.php` && autoRoute)) {
        g.addFinding({
          severity: 'medium', category: 'security', rule: 'ci4-auto-route', file: rf,
          title: 'Auto routing is enabled',
          detail: 'Any public controller method can be reached by URL, including ones never listed in Routes.php. Prefer explicit routes (Config/Routing::$autoRoute = false).',
        });
      }
      const ns = /->setDefaultNamespace\(\s*['"]([^'"]+)['"]/.exec(code);
      if (ns) defaultNs = ns[1].replace(/\\\\/g, '\\');
      const moduleNs = /\/Modules\/(\w+)\/Config\//.exec(rf);
      parseRouteBlock(ctx, g, {
        file: rf, code, masked: maskStrings(code, `'"`), lines: new LineIndex(text), start: 0, end: code.length,
        recv: new Set(['routes']), ctlIndex, controllers, allClasses,
      }, { prefix: '', filters: [], namespace: moduleNs ? `App\\Modules\\${moduleNs[1]}\\Controllers` : defaultNs });
    }
    for (const r of g.routes.values()) {
      if (r.framework !== 'codeigniter4') continue;
      for (const uf of uriFilters) {
        if (uf.patterns.some((pat) => globMatch(pat, r.path)) && !r.middleware.includes(uf.name)) r.middleware.push(uf.name);
      }
      for (const m of r.middleware) {
        const name = m.split(':')[0];
        if (!g.middleware.has(`middleware:${name}`)) g.addMiddleware({ id: `middleware:${name}`, name, kind: 'route', framework: 'codeigniter4' });
        g.addEdge(r.id, `middleware:${name}`, 'protected-by');
      }
    }

    lifecycle(g, root, g.routes.size, models.size);
    recipes(g, root);
  },
};

interface BlockState {
  file: string;
  code: string;
  masked: string;
  lines: LineIndex;
  start: number;
  end: number;
  recv: Set<string>;
  ctlIndex: Map<string, ParsedPhpClass>;
  controllers: ParsedPhpClass[];
  allClasses: ParsedPhpClass[];
}

function parseRouteBlock(ctx: ScanContext, g: GraphBuilder, s: BlockState, rc: RouteCtx): void {
  const re = new RegExp(`\\$(\\w+)\\s*->\\s*(${ROUTE_VERBS})\\s*\\(`, 'g');
  re.lastIndex = s.start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.masked)) && m.index < s.end) {
    if (!s.recv.has(m[1])) continue;
    const verb = m[2];
    const open = m.index + m[0].length - 1;
    const [args, close] = callArgs(s.code, open, `'"`);
    const line = s.lines.lineAt(m.index);
    re.lastIndex = close + 1;
    if (verb === 'group' || verb === 'environment') {
      const closureArg = args[args.length - 1] || '';
      const opts = verb === 'group' && args.length > 2 ? (parsePhpValue(args[1]) as Record<string, PhpValue>) : {};
      const fnAt = s.code.indexOf(closureArg, open);
      const param = /function\s*\(\s*(?:[\w\\]+\s+)?\$(\w+)/.exec(closureArg)?.[1] || /fn\s*\(\s*(?:[\w\\]+\s+)?\$(\w+)/.exec(closureArg)?.[1];
      const braceRel = closureArg.indexOf('{');
      if (fnAt < 0 || braceRel < 0) continue;
      const bodyOpen = fnAt + braceRel;
      const bodyClose = matchBracket(s.code, bodyOpen, `'"`);
      const next: RouteCtx = {
        prefix: verb === 'group' ? joinRoute(rc.prefix, unquote(args[0]) ?? '') : rc.prefix,
        filters: uniq([...rc.filters, ...filterNames(opts?.filter)]),
        namespace: phpStr(opts?.namespace)?.replace(/\\\\/g, '\\').replace(/^\\/, '') || rc.namespace,
      };
      parseRouteBlock(ctx, g, { ...s, start: bodyOpen + 1, end: bodyClose < 0 ? s.end : bodyClose, recv: new Set([...s.recv, ...(param ? [param] : [])]) }, next);
      continue;
    }
    if (verb === 'map') continue;
    if (verb === 'resource' || verb === 'presenter') {
      const name = unquote(args[0]) || '';
      const opts = (args[1] ? parsePhpValue(args[1]) : {}) as Record<string, PhpValue>;
      const ctl = phpStr(opts?.controller) || name.split('/').pop()!.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
      const only = phpList(opts?.only);
      const except = phpList(opts?.except);
      const ph = '{id}';
      const defs: Array<[string, string, string]> = verb === 'resource'
        ? [['GET', '', 'index'], ['GET', '/new', 'new'], ['POST', '', 'create'], ['GET', `/${ph}`, 'show'], ['GET', `/${ph}/edit`, 'edit'], ['PUT', `/${ph}`, 'update'], ['PATCH', `/${ph}`, 'update'], ['DELETE', `/${ph}`, 'delete']]
        : [['GET', '', 'index'], ['GET', `/show/${ph}`, 'show'], ['GET', '/new', 'new'], ['POST', '/create', 'create'], ['GET', `/edit/${ph}`, 'edit'], ['POST', `/update/${ph}`, 'update'], ['GET', `/remove/${ph}`, 'remove'], ['POST', `/delete/${ph}`, 'delete']];
      for (const [method, suffix, action] of defs) {
        if ((only.length && !only.includes(action)) || except.includes(action)) continue;
        addRoute(g, s, rc, method, joinRoute(rc.prefix, name) + suffix, `'${ctl}::${action}'`, filterNames(opts?.filter), line, phpStr(opts?.namespace), [`generated by $routes->${verb}('${name}')`]);
      }
      continue;
    }
    if (verb === 'addRedirect') {
      const from = unquote(args[0]) ?? '?';
      const to = unquote(args[1]) ?? args[1] ?? '?';
      g.addRoute({ method: 'GET', path: displayPath(joinRoute(rc.prefix, from)), target: `redirect → ${to}`, middleware: rc.filters, file: s.file, line, framework: 'codeigniter4', notes: ['Permanent redirect route'] });
      continue;
    }
    if (verb === 'view') {
      const path = displayPath(joinRoute(rc.prefix, unquote(args[0]) ?? '?'));
      const view = unquote(args[1]) || '?';
      const r = g.addRoute({ method: 'GET', path, target: `view: ${view}`, middleware: rc.filters, file: s.file, line, framework: 'codeigniter4', notes: ['Renders a view directly from the route'] });
      const viewNode = Array.from(g.views.values()).find((v) => v.name === view || v.file.endsWith(`/Views/${view}.php`));
      if (viewNode) g.addEdge(r.id, viewNode.id, 'renders');
      continue;
    }
    let methods: string[];
    let rest = args;
    if (verb === 'match') {
      const list = parsePhpValue(args[0]);
      methods = phpList(list).map((x) => x.toUpperCase());
      rest = args.slice(1);
    } else if (verb === 'add') methods = ['ANY'];
    else methods = [verb.toUpperCase()];
    const rawPath = unquote(rest[0]);
    const path = rawPath ?? `{${(rest[0] || 'dynamic').replace(/[^\w]/g, '')}}`;
    const opts = (rest[2] ? parsePhpValue(rest[2]) : {}) as Record<string, PhpValue>;
    const target = rest[1] || '';
    for (const method of methods) {
      addRoute(g, s, rc, method, joinRoute(rc.prefix, path), target, filterNames(opts?.filter), line, phpStr(opts?.namespace), rawPath === null ? ['Path is computed at runtime'] : undefined, phpStr(opts?.as));
    }
  }
}

function addRoute(
  g: GraphBuilder, s: BlockState, rc: RouteCtx, method: string, path: string, rawTarget: string, extraFilters: string[],
  line: number, nsOverride?: string, notes?: string[], name?: string,
): void {
  let target = unquote(rawTarget);
  let handlerId: string | undefined;
  const ns = (nsOverride || rc.namespace).replace(/\\\\/g, '\\').replace(/^\\/, '');
  if (target === null) {
    const arr = /^\[\s*\\?([\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]$/.exec(rawTarget.trim());
    if (arr) target = `${arr[1]}::${arr[2]}`;
    // 'Controller::method/' . $param
    const concat = /^(['"])([\w\\]+::\w+)[^'"]*\1\s*\./.exec(rawTarget.trim());
    if (concat) target = concat[2];
  }
  if (target !== null && target.includes('::')) {
    const [clsRaw, methRaw] = target.split('::');
    const meth = methRaw.split('/')[0];
    const cls = clsRaw.replace(/\\\\/g, '\\');
    const fq = cls.startsWith('\\') ? cls.slice(1) : `${ns}\\${cls}`;
    const found = s.ctlIndex.get(fq.toLowerCase()) || s.controllers.find((c) => c.fqcn.toLowerCase().endsWith('\\' + cls.replace(/^\\/, '').toLowerCase()));
    target = `${cls.replace(/^\\?App\\Controllers\\/, '')}::${meth}`;
    if (found && methodExists(found, meth, s.allClasses) === false) {
      notes = [...(notes || []), `${found.name}::${meth}() does not exist`];
      g.addFinding({
        severity: 'medium', category: 'correctness', rule: 'route-missing-method', file: s.file, line,
        title: `Route ${method} ${displayPath(path)} → missing ${found.name}::${meth}()`,
        detail: 'The route targets a controller method that is not defined in the class or its parents, so the request fails with a 404/500.',
      });
    } else if (found) handlerId = `${found.fqcn}::${meth}`;
  } else if (target === null && /function\s*\(|fn\s*\(/.test(rawTarget)) {
    // closure route
    const at = s.code.indexOf(rawTarget);
    const brace = rawTarget.indexOf('{');
    handlerId = `closure:${s.file}:${line}`;
    const res = brace >= 0 ? analyzeBody(rawTarget.slice(brace), (off) => s.lines.lineAt(at + brace + off), { lang: 'php', resolveModel: () => undefined, modelTable: () => undefined }) : null;
    g.addHandler({
      id: handlerId, name: `closure (${method} ${displayPath(path)})`, kind: 'closure', file: s.file, line, endLine: line,
      framework: 'codeigniter4', area: 'routes', steps: res?.steps || [], responses: res?.responses || [],
      views: (res?.views || []).map((v) => {
        const vn = Array.from(g.views.values()).find((x) => x.name === v.name || x.file.endsWith(`/Views/${v.name}.php`));
        if (vn) g.addEdge(handlerId!, vn.id, 'renders');
        return { view: vn ? vn.id : v.name, vars: v.vars, line: v.line };
      }),
    });
    target = 'Closure';
  }
  const route = g.addRoute({
    method, path: displayPath(path), name, target: target ?? rawTarget.trim(), handler: handlerId,
    middleware: uniq([...rc.filters, ...extraFilters]), file: s.file, line, framework: 'codeigniter4', notes,
  });
  if (handlerId) g.addEdge(route.id, handlerId, 'routes-to');
}

function joinRoute(prefix: string, path: string): string {
  const parts = [prefix, path].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return parts.join('/');
}

function displayPath(p: string): string {
  return normalizeUrlPath(
    p.replace(/\(:num\)/g, '{num}').replace(/\(:segment\)/g, '{segment}').replace(/\(:any\)/g, '{any}')
      .replace(/\(:alpha\)/g, '{alpha}').replace(/\(:alphanum\)/g, '{alphanum}').replace(/\(:hash\)/g, '{hash}'),
  );
}

function filterNames(v: PhpValue | undefined): string[] {
  if (!v) return [];
  if (typeof v === 'string') return v.split(/\s*,\s*(?![^:]*,)/).filter(Boolean).map((x) => x.trim());
  return phpList(v);
}

function globMatch(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\/+/, '');
  const re = new RegExp('^/?' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(path.replace(/^\//, '')) || re.test(path);
}

function areaOf(c: ParsedPhpClass): string {
  const mod = /\/Modules\/(\w+)\//.exec(c.file);
  if (mod) return mod[1];
  const sub = /\/Controllers\/(\w+)\//.exec(c.file);
  return sub ? sub[1] : 'app';
}

function classFile(ctx: ScanContext, root: string, fqcn: string): string | undefined {
  const rel = fqcn.replace(/^App\\/, 'app/').replace(/\\/g, '/') + '.php';
  const p = root === '.' ? rel : `${root}/${rel}`;
  return ctx.has(p) ? p : undefined;
}

function filterDescription(ctx: ScanContext, file: string): string | undefined {
  const src = ctx.read(file);
  if (!src) return undefined;
  const php = parsePhp(src);
  const before = php.classes[0]?.methods.find((m) => m.name === 'before');
  if (!before) return undefined;
  const res = analyzeBody(before.body, (o) => php.lines.lineAt(before.bodyOffset + o), { lang: 'php', resolveModel: () => undefined, modelTable: () => undefined });
  const parts = res.steps.slice(0, 4).map((s) => s.text);
  return parts.length ? `Before the controller: ${parts.join('; ')}` : undefined;
}

function parseMigration(ctx: ScanContext, g: GraphBuilder, file: string): void {
  const src = ctx.read(file);
  if (!src) return;
  const code = stripPhp(src);
  const lines = new LineIndex(src);
  let fields: FieldInfo[] = [];
  let fks: Array<{ column: string; references: string }> = [];
  const re = /->(addField|addForeignKey|createTable|addKey|addPrimaryKey)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const [args] = callArgs(code, m.index + m[0].length - 1, `'"`);
    if (m[1] === 'addField') {
      const v = parsePhpValue(args[0] || '');
      if (v && typeof v === 'object' && !Array.isArray(v) && !('__expr' in v)) {
        for (const [name, def] of Object.entries(v)) {
          const d = def as Record<string, PhpValue>;
          fields.push({ name, type: phpStr(d?.type)?.toLowerCase(), nullable: d?.null === true ? true : undefined });
        }
      }
    } else if (m[1] === 'addPrimaryKey' || (m[1] === 'addKey' && /true/.test(args[1] || ''))) {
      const k = unquote(args[0]);
      const f = fields.find((x) => x.name === k);
      if (f) f.primary = true;
    } else if (m[1] === 'addForeignKey') {
      const col = unquote(args[0]);
      const t = unquote(args[1]);
      const c = unquote(args[2]);
      if (col && t) fks.push({ column: col, references: `${t}.${c || 'id'}` });
    } else if (m[1] === 'createTable') {
      const name = unquote(args[0]);
      if (!name) continue;
      const t = g.ensureTable(name);
      if (!t.columns.length) t.columns = fields;
      for (const fk of fks) if (!t.foreignKeys.some((x) => x.column === fk.column)) t.foreignKeys.push({ ...fk, inferred: false });
      t.sources.push({ file, line: lines.lineAt(m.index), kind: 'migration' });
      fields = [];
      fks = [];
    }
  }
}

function ciSystemVersion(ctx: ScanContext, root: string): string | undefined {
  const p = root === '.' ? 'vendor/codeigniter4/framework/system/CodeIgniter.php' : `${root}/vendor/codeigniter4/framework/system/CodeIgniter.php`;
  const src = ctx.read(p);
  return src ? /CI_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] : undefined;
}

function hints(g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  const H: Array<[string, string, string[]?]> = [
    ['app', 'Application code (CodeIgniter 4)'],
    ['app/Config', 'Framework and app configuration: Routes.php, Filters.php, Database.php, App.php'],
    ['app/Config/Routes.php', 'Every URL → Controller::method mapping', ['entry']],
    ['app/Config/Filters.php', 'Filter (middleware) aliases, global filters and URI-pattern filters'],
    ['app/Controllers', 'Request handlers: one class per area, one method per action'],
    ['app/Models', 'Database models (one per table): allowed fields, timestamps, queries'],
    ['app/Views', 'PHP templates rendered by view()'],
    ['app/Filters', 'Custom filters run before/after controllers (auth, roles, CORS…)'],
    ['app/Helpers', 'Global helper functions loaded with helper()'],
    ['app/Libraries', 'Plain PHP service classes used by controllers'],
    ['app/Database/Migrations', 'Schema migrations (php spark migrate)'],
    ['app/Database/Seeds', 'Seed data (php spark db:seed)'],
    ['app/Modules', 'Self-contained feature modules (own Controllers/Models/Views/Config)'],
    ['app/Language', 'Translation strings, one folder per locale'],
    ['public', 'Web root: index.php front controller and static assets', ['entry']],
    ['public/index.php', 'Front controller: every request enters here', ['entry']],
    ['writable', 'Runtime files: cache, logs, sessions, uploads (not source)'],
    ['tests', 'PHPUnit tests'],
    ['spark', 'CodeIgniter CLI (php spark …)'],
    ['.env', 'Environment configuration: may contain secrets, never commit', ['secret']],
    ['env', 'Template for .env'],
  ];
  for (const [path, desc, tags] of H) g.hint(p(path), desc, tags);
}

function lifecycle(g: GraphBuilder, root: string, routeCount: number, modelCount: number): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  const globals = Array.from(g.middleware.values()).filter((m) => m.kind === 'global' && m.framework === 'codeigniter4').map((m) => m.name);
  const views = Array.from(g.views.values()).filter((v) => v.file.startsWith(p('app'))).length;
  g.lifecycle.push(
    { id: 'ci-entry', title: 'Front controller', subtitle: 'public/index.php', detail: 'The web server sends every request to public/index.php, which boots CodeIgniter (paths, .env, services).', files: [p('public/index.php')] },
    { id: 'ci-router', title: 'Router', subtitle: 'app/Config/Routes.php', detail: `The router matches the HTTP method and URI against ${routeCount} defined routes and picks a Controller::method (or a closure).`, files: [p('app/Config/Routes.php')] },
    { id: 'ci-before', title: 'Before filters', subtitle: 'app/Config/Filters.php', detail: `Global filters (${globals.join(', ') || 'none configured'}) plus any filter attached to the route or its group run first. A filter can stop the request, e.g. redirect to login.`, files: [p('app/Config/Filters.php')] },
    { id: 'ci-controller', title: 'Controller', subtitle: 'app/Controllers', detail: 'The controller method reads input ($this->request), validates it, and calls models or libraries.' },
    { id: 'ci-model', title: 'Model / DB', subtitle: `${modelCount} models`, detail: 'Models extend CodeIgniter\\Model and use the Query Builder to read and write their table.' },
    { id: 'ci-view', title: 'View', subtitle: `${views} templates`, detail: "view('name', $data) renders a PHP template, usually extending a layout with $this->extend() / $this->section()." },
    { id: 'ci-after', title: 'After filters → response', subtitle: 'HTML, JSON or redirect', detail: 'After filters run (e.g. toolbar, secure headers) and the Response is sent: HTML, JSON (setJSON) or a 302 redirect with flash data.' },
  );
}

function recipes(g: GraphBuilder, root: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  g.recipes.push(
    { id: 'ci-page', title: 'Add a new page', summary: 'Route → controller method → view.', files: [p('app/Config/Routes.php'), p('app/Controllers'), p('app/Views')], steps: [
      `Add a route in ${p('app/Config/Routes.php')}: $routes->get('my-page', 'MyController::index');`,
      'Create or extend a controller in app/Controllers with a public method index().',
      "Return view('my_page', $data) from the method and create app/Views/my_page.php (extend your layout with $this->extend()).",
      "If the page needs login, put the route in a group with ['filter' => '<auth filter>'].",
    ] },
    { id: 'ci-form', title: 'Handle a form submission', summary: 'GET shows the form, POST validates and saves, then redirects.', files: [p('app/Config/Routes.php')], steps: [
      "Add both routes: $routes->get('thing/new', …) and $routes->post('thing/save', …).",
      'In the POST method call $this->validate([...rules]) and return redirect()->back()->withInput() on failure.',
      'Save with $model->insert($data) and redirect with ->with(\'success\', \'…\').',
      'Keep csrf_field() in the form; make sure the csrf filter is enabled in app/Config/Filters.php.',
    ] },
    { id: 'ci-table', title: 'Add a database table', summary: 'Migration → model → use it from a controller.', files: [p('app/Database/Migrations'), p('app/Models')], steps: [
      'php spark make:migration CreateThings, define fields with $this->forge->addField() and createTable().',
      'php spark migrate',
      'php spark make:model ThingModel; set $table and $allowedFields.',
      'Use it: $things = model(ThingModel::class)->findAll();',
    ] },
    { id: 'ci-api', title: 'Add a JSON API endpoint', summary: 'A route returning $this->response->setJSON().', files: [p('app/Config/Routes.php')], steps: [
      "Add $routes->get('api/things', 'Api\\ThingController::index') inside an API group with your auth/CORS filter.",
      'Return $this->response->setJSON([...]) (or use ResourceController / ResponseTrait).',
      'Call it from JavaScript with fetch(\'/api/things\').',
    ] },
  );
}
