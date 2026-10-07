/** Express adapter: app/router routes and mounts, middleware, controllers, models (Mongoose, Sequelize, Prisma, TypeORM) and views. */
import { Adapter, Detection } from '../types';
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { FieldInfo, ModelNode, RelationInfo } from '../../schema/graph';
import { JsFile, parseJs, resolveImport } from '../../parsers/js';
import { callArgs, matchBracket, splitTopLevel, unquote } from '../../parsers/common';
import { analyzeBody } from '../../analyzers/steps';
import { npmVersion } from '../shared/manifest';
import { dirname, LineIndex, normalizeUrlPath, uniq, joinPath } from '../../utils/text';

const CLIENT = /(^|\/)(public|static|views|client|frontend|dist|build|coverage|tests?|__tests__|spec|e2e|cypress|migrations|seeders)\//;
const VERBS = 'get|post|put|patch|delete|all|options|head|use|route';

interface Mount {
  parent: string;
  prefix: string;
  middleware: string[];
}

export const express: Adapter = {
  id: 'express',
  name: 'Express',
  language: 'JavaScript',

  detect(ctx) {
    const out: Detection[] = [];
    for (const f of ctx.files) {
      if (!/(^|\/)package\.json$/.test(f.path)) continue;
      const pkg = ctx.readJson(f.path);
      if (!pkg?.dependencies?.express && !pkg?.devDependencies?.express) continue;
      const root = dirname(f.path);
      out.push({ id: 'express', name: 'Express', language: 'JavaScript', root, confidence: 0.9, evidence: [`${f.path} depends on express`], version: npmVersion(ctx, root, 'express') });
    }
    return out;
  },

  analyze(ctx, det, g) {
    const root = det.root;
    const files = ctx.under(root).filter((f) => /\.(m?js|cjs|ts)$/.test(f.path) && !/\.d\.ts$|\.min\.js$|\.test\.|\.spec\./.test(f.path) && !CLIENT.test('/' + f.path.slice(root === '.' ? 0 : root.length + 1))).map((f) => f.path);
    const parsed = new Map<string, JsFile>();
    for (const f of files) {
      const src = ctx.read(f);
      if (src !== null) parsed.set(f, parseJs(src));
    }
    const has = (p: string) => parsed.has(p);

    const models = jsModels(ctx, g, parsed, root);
    const resolveModel = (expr: string): string | undefined => {
      const base = expr.split('.');
      if (base[0] === 'prisma' || base[0] === 'db' && base.length > 1) {
        const n = base[1];
        return Array.from(models.keys()).find((k) => k.toLowerCase() === n?.toLowerCase());
      }
      return models.has(base[0]) ? base[0] : undefined;
    };

    // views
    const viewsDirs: string[] = [];
    let engine = 'html';
    for (const [f, js] of parsed) {
      const vd = /\.set\(\s*['"]views['"]\s*,\s*(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?['"`]([^'"`]+)['"`]/.exec(js.code);
      if (vd) viewsDirs.push(joinPath(dirname(f), vd[1]));
      const ve = /\.set\(\s*['"]view engine['"]\s*,\s*['"](\w+)['"]/.exec(js.code);
      if (ve) engine = ve[1];
    }
    viewsDirs.push(root === '.' ? 'views' : `${root}/views`, root === '.' ? 'src/views' : `${root}/src/views`);
    const viewByName = new Map<string, string>();
    for (const dir of uniq(viewsDirs)) {
      for (const f of ctx.under(dir).filter((x) => /\.(ejs|pug|jade|hbs|handlebars|html|njk|twig|mustache)$/.test(x.path))) {
        const src = ctx.read(f.path);
        if (src === null) continue;
        const name = f.path.slice(dir.length + 1).replace(/\.\w+$/, '');
        const ext = f.ext;
        const grab = (re: RegExp) => uniq(Array.from(src.matchAll(re)).map((m) => m[1]));
        const id = `view:${f.path}`;
        g.addView({
          id, name, file: f.path, engine: ext === 'jade' ? 'pug' : ext === 'handlebars' ? 'hbs' : ext, lines: new LineIndex(src).count,
          extends: grab(/^\s*extends\s+([\w./-]+)/gm),
          includes: uniq([...grab(/include\(\s*['"]([^'"]+)['"]/g), ...grab(/^\s*include\s+([\w./-]+)/gm), ...grab(/\{\{>\s*([\w./-]+)/g), ...grab(/\{%\s*(?:include|extends)\s+['"]([^'"]+)['"]/g)]),
          sections: grab(/^\s*block\s+(\w+)/gm),
          vars: templateVars(src, ext),
          forms: [], links: [], scripts: [], calls: [],
          isLayout: /^\s*block\s+\w+\s*$/m.test(src) && !/^\s*extends\b/m.test(src) || /\{\{\{\s*body\s*\}\}\}|<%-\s*body\s*%>/.test(src),
        });
        viewByName.set(name, id);
      }
    }
    for (const v of g.views.values()) {
      if (!viewByName.has(v.name) || viewByName.get(v.name) !== v.id) continue;
      v.extends = v.extends.map((e) => viewByName.get(e.replace(/\.\w+$/, '')) || e);
      v.includes = v.includes.map((e) => viewByName.get(e.replace(/^\.?\//, '').replace(/\.\w+$/, '')) || e);
      for (const e of v.extends) if (e.startsWith('view:')) g.addEdge(v.id, e, 'extends');
      for (const e of v.includes) if (e.startsWith('view:')) g.addEdge(v.id, e, 'includes');
    }

    // instances: const app = express(); const router = express.Router()
    const instances = new Map<string, 'app' | 'router'>();
    for (const [f, js] of parsed) {
      for (const m of js.code.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:(express)\s*\(\s*\)|(?:express\s*\.\s*)?Router\s*\(|new\s+Router\s*\()/g)) instances.set(`${f}#${m[1]}`, m[2] ? 'app' : 'router');
    }
    const exportedInstance = (file: string, name = 'default'): string | undefined => {
      const js = parsed.get(file);
      if (!js) return undefined;
      const local = name === 'default' || name === '*' ? js.defaultExport : js.exports.get(name) || name;
      return local && instances.has(`${file}#${local}`) ? `${file}#${local}` : undefined;
    };
    const resolveRef = (ref: string, file: string): { file: string; name: string } | undefined => {
      const js = parsed.get(file)!;
      const [head, ...rest] = ref.split('.');
      const imp = js.imports.get(head);
      if (!imp) return { file, name: ref };
      const target = resolveImport(imp.source, file, has);
      if (!target) return undefined;
      if (imp.imported === '*' || imp.imported === 'default') return { file: target, name: rest.length ? rest.join('.') : 'default' };
      return { file: target, name: [imp.imported, ...rest].join('.') };
    };
    const instanceOf = (ref: string, file: string): string | undefined => {
      if (instances.has(`${file}#${ref}`)) return `${file}#${ref}`;
      const r = resolveRef(ref, file);
      if (!r) return undefined;
      return exportedInstance(r.file, r.name);
    };

    // calls
    const mounts = new Map<string, Mount[]>();
    const pending: Array<{ key: string; method: string; path: string; args: string[]; file: string; line: number; offset: number }> = [];
    for (const [f, js] of parsed) {
      const re = new RegExp(`\\b(\\w+)\\s*\\.\\s*(${VERBS})\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(js.code))) {
        const key = instances.has(`${f}#${m[1]}`) ? `${f}#${m[1]}` : undefined;
        if (!key) continue;
        const open = m.index + m[0].length - 1;
        const [args, close] = callArgs(js.code, open);
        const line = js.lines.lineAt(m.index);
        if (m[2] === 'route') {
          // app.route('/x').get(h).post(h)
          const path = unquote(args[0]) ?? '{dynamic}';
          let i = close + 1;
          for (;;) {
            const cm = /^\s*\.\s*(get|post|put|patch|delete|all)\s*\(/.exec(js.code.slice(i, i + 40));
            if (!cm) break;
            const o = i + cm[0].length - 1;
            const [cargs, cclose] = callArgs(js.code, o);
            pending.push({ key, method: cm[1].toUpperCase(), path, args: cargs, file: f, line: js.lines.lineAt(o), offset: o });
            i = cclose + 1;
          }
          re.lastIndex = i;
          continue;
        }
        if (m[2] === 'use') {
          const path = unquote(args[0]);
          const rest = path !== null ? args.slice(1) : args;
          const routerArg = rest.map((a) => a.trim()).reverse().find((a) => /^[\w.]+$/.test(a) && instanceOf(a, f)) ||
            rest.map((a) => /^require\(\s*['"]([^'"]+)['"]\s*\)$/.exec(a.trim())?.[1]).find(Boolean);
          let child: string | undefined;
          if (routerArg && routerArg.includes('/')) {
            const target = resolveImport(routerArg, f, has);
            child = target ? exportedInstance(target) : undefined;
          } else if (routerArg) child = instanceOf(routerArg, f);
          const mws = rest.filter((a) => a.trim() !== routerArg && !/^require\(/.test(a.trim())).map(mwName).filter(Boolean) as string[];
          if (child) {
            if (!mounts.has(child)) mounts.set(child, []);
            mounts.get(child)!.push({ parent: key, prefix: path || '', middleware: mws });
          } else if (instances.get(key) === 'app' && path === null) {
            for (const mw of mws) g.addMiddleware({ id: `middleware:${mw}`, name: mw, kind: 'global', file: f, line, framework: 'express', description: MW_DESC[mw.replace(/\(\)$/, '')] });
          } else if (mws.length) {
            for (const mw of mws) g.addMiddleware({ id: `middleware:${mw}`, name: mw, kind: 'route', file: f, line, framework: 'express', description: path ? `Applied to ${path}` : 'Applied to every route of this router' });
          }
          continue;
        }
        pending.push({ key, method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: unquote(args[0]) ?? '{dynamic}', args: args.slice(1), file: f, line, offset: open });
      }
    }
    const routerMw = new Map<string, string[]>();
    for (const [f, js] of parsed) {
      for (const m of js.code.matchAll(/\b(\w+)\s*\.\s*use\s*\(\s*([A-Za-z_$][\w$.]*(?:\([^)]*\))?)\s*\)/g)) {
        const key = `${f}#${m[1]}`;
        if (instances.get(key) === 'router') routerMw.set(key, [...(routerMw.get(key) || []), mwName(m[2])!].filter(Boolean));
      }
    }
    const fullPrefix = (key: string, seen = new Set<string>()): { prefix: string; middleware: string[]; mounted: boolean } => {
      if (instances.get(key) === 'app' || seen.has(key)) return { prefix: '', middleware: [], mounted: true };
      seen.add(key);
      const m = (mounts.get(key) || [])[0];
      const own = routerMw.get(key) || [];
      if (!m) return { prefix: '', middleware: own, mounted: false };
      const parent = fullPrefix(m.parent, seen);
      return { prefix: join(parent.prefix, m.prefix), middleware: [...parent.middleware, ...m.middleware, ...own], mounted: parent.mounted };
    };

    // handlers
    const containers = new Set<string>();
    for (const p of pending) {
      const js = parsed.get(p.file)!;
      const mount = fullPrefix(p.key);
      const handlerArg = (p.args[p.args.length - 1] || '').trim();
      const mws = p.args.slice(0, -1).map(mwName).filter(Boolean) as string[];
      const full = normalizeUrlPath(join(mount.prefix, p.path)).replace(/:(\w+)\??/g, '{$1}');
      let handlerId: string | undefined;
      let target = handlerArg;
      const unwrapped = unwrap(handlerArg);
      if (/^(async\s*)?(function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(unwrapped)) {
        const at = js.code.indexOf(unwrapped, p.offset);
        const brace = unwrapped.indexOf('{');
        const body = brace >= 0 ? unwrapped.slice(brace) : unwrapped;
        const res = analyzeBody(body, (o) => js.lines.lineAt(at + (brace >= 0 ? brace : 0) + o), { lang: 'js', resolveModel, modelTable: (n) => models.get(n)?.table });
        handlerId = `fn:${p.file}:${p.line}:${p.method}`;
        const area = areaOf(p.file, root);
        const h = g.addHandler({ id: handlerId, name: `${p.method} ${full}`, kind: 'closure', file: p.file, line: p.line, endLine: js.lines.lineAt(at + unwrapped.length), framework: 'express', area });
        fill(g, h.id, res, models, viewByName);
        target = 'inline handler';
      } else if (/^[\w$.]+$/.test(unwrapped)) {
        const r = resolveRef(unwrapped, p.file);
        const fileJs = r ? parsed.get(r.file) : undefined;
        if (r && fileJs) {
          const local = r.name === 'default' ? fileJs.defaultExport : fileJs.exports.get(r.name.split('.').pop()!) || r.name.split('.').pop();
          const fn = fileJs.functions.find((x) => x.name === local) || fileJs.functions.find((x) => x.name === r.name.split('.').pop());
          if (fn) {
            handlerId = `js:${r.file}#${fn.owner ? fn.owner + '.' : ''}${fn.name}`;
            const cid = `controller:js:${r.file}`;
            const area = areaOf(r.file, root);
            if (!containers.has(cid)) {
              containers.add(cid);
              g.addContainer({ id: cid, name: r.file.split('/').pop()!.replace(/\.\w+$/, ''), kind: 'module', file: r.file, line: 1, area, framework: 'express' });
            }
            if (!g.handlers.has(handlerId)) {
              const res = analyzeBody(fn.body, (o) => fileJs.lines.lineAt(fn.bodyOffset + o), { lang: 'js', resolveModel, modelTable: (n) => models.get(n)?.table, siblings: new Set(fileJs.functions.map((x) => x.name)) });
              g.addHandler({ id: handlerId, name: fn.name, container: cid, kind: 'function', file: r.file, line: fn.line, endLine: fn.endLine, params: fn.params, framework: 'express', area });
              fill(g, handlerId, res, models, viewByName);
              const c = g.containers.get(cid)!;
              c.handlers.push(handlerId);
              g.addEdge(cid, handlerId, 'contains');
            }
          }
        }
      }
      const middleware = uniq([...mount.middleware, ...mws]);
      const route = g.addRoute({
        method: p.method, path: full, target, handler: handlerId, middleware, file: p.file, line: p.line, framework: 'express',
        notes: mount.mounted ? undefined : instances.get(p.key) === 'router' ? ['Router is not mounted on the app by any statically visible app.use()'] : undefined,
      });
      if (handlerId) g.addEdge(route.id, handlerId, 'routes-to');
      for (const mw of middleware) {
        if (!g.middleware.has(`middleware:${mw}`)) g.addMiddleware({ id: `middleware:${mw}`, name: mw, kind: 'route', framework: 'express', description: MW_DESC[mw.replace(/\(\)$/, '')] });
        g.addEdge(route.id, `middleware:${mw}`, 'protected-by');
      }
    }

    const hasHelmet = g.middleware.has('middleware:helmet()') || g.middleware.has('middleware:helmet');
    if (g.routes.size && !hasHelmet) {
      const appFile = Array.from(instances.entries()).find(([, k]) => k === 'app')?.[0].split('#')[0];
      g.addFinding({ severity: 'low', category: 'security', rule: 'express-no-helmet', file: appFile, title: 'No security-headers middleware (helmet)', detail: 'helmet() was not found among the global middleware; responses may miss headers such as Content-Security-Policy and X-Content-Type-Options.' });
    }

    const n = g.routes.size;
    g.lifecycle.push(
      { id: 'ex-server', title: 'Node server', subtitle: 'app.listen / http.createServer', detail: 'Node.js starts the Express app and listens on a port.' },
      { id: 'ex-mw', title: 'Global middleware', subtitle: 'app.use(…)', detail: `Global middleware runs in registration order: ${Array.from(g.middleware.values()).filter((m) => m.kind === 'global').map((m) => m.name).join(' → ') || 'none detected'}.` },
      { id: 'ex-router', title: 'Routers', subtitle: `${n} routes`, detail: 'app.use(\'/prefix\', router) mounts routers; the first route whose method and path match handles the request.' },
      { id: 'ex-route-mw', title: 'Route middleware', subtitle: 'auth, validation', detail: 'Middleware listed before the handler (auth checks, validators, upload parsers) runs and may end the request early.' },
      { id: 'ex-handler', title: 'Handler / controller', subtitle: '(req, res, next)', detail: 'The handler reads req.params / req.query / req.body, calls services and models.' },
      { id: 'ex-data', title: 'Models', subtitle: `${models.size} models`, detail: 'Mongoose, Sequelize, Prisma or SQL queries read and write data.' },
      { id: 'ex-response', title: 'Response', subtitle: 'res.json / res.render', detail: 'The handler ends the request with res.json(), res.render(view) or res.redirect(); errors go to the error-handling middleware via next(err).' },
    );
    g.recipes.push({ id: 'ex-endpoint', title: 'Add an endpoint', summary: 'Router + controller function.', files: [], steps: [
      'Add a controller function: exports.getThing = async (req, res, next) => { … res.json(thing) }',
      "Register it on a router: router.get('/things/:id', requireAuth, thingController.getThing)",
      "Mount the router once in the app: app.use('/api', router)",
      'Validate req.body (zod / joi / express-validator) before touching the database.',
    ] });
  },
};

function fill(g: GraphBuilder, id: string, res: ReturnType<typeof analyzeBody>, models: Map<string, ModelNode>, views: Map<string, string>): void {
  const h = g.handlers.get(id)!;
  Object.assign(h, {
    steps: res.steps,
    models: uniq(res.models.map((n) => models.get(n)!.id)),
    tables: res.tables,
    data: res.data.map((d) => ({ ...d, model: d.model ? models.get(d.model)?.id : undefined })),
    responses: res.responses,
  });
  for (const v of res.views) {
    const vid = views.get(v.name.replace(/^\//, '').replace(/\.\w+$/, ''));
    h.views.push({ view: vid || v.name, vars: v.vars, line: v.line });
    if (vid) g.addEdge(id, vid, 'renders');
  }
}

function unwrap(expr: string): string {
  let e = expr.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(\w+)\(([\s\S]*)\)$/.exec(e);
    if (!m || /^(async|function)$/.test(m[1])) break;
    e = splitTopLevel(m[2])[0] || e;
  }
  return e;
}

function mwName(expr: string): string | undefined {
  const e = expr.trim();
  if (!e || /^['"`]/.test(e)) return undefined;
  if (/^(async\s*)?(function|\(|\w+\s*=>)/.test(e)) return 'inline middleware';
  const call = /^([\w$.]+)\s*\(/.exec(e);
  if (call) return `${call[1]}()`;
  if (/^[\w$.]+$/.test(e)) return e;
  if (e.startsWith('[')) return splitTopLevel(e.slice(1, -1)).map(mwName).filter(Boolean).join(', ') || undefined;
  return undefined;
}

function areaOf(file: string, root: string): string {
  const rel = root === '.' ? file : file.slice(root.length + 1);
  const parts = rel.split('/');
  return parts.length > 2 ? parts[parts.length - 2] : parts.length > 1 ? parts[0] : 'app';
}

function join(...parts: string[]): string {
  return parts.map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

function templateVars(src: string, ext: string): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    if (!out.includes(v) && !/^(include|locals|if|else|for|each|true|false|null|undefined|this|body|layout|partial|block|with|unless|let|const|var|function|return|new|typeof)$/.test(v)) out.push(v);
  };
  if (ext === 'ejs') for (const m of src.matchAll(/<%[=-]?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  else if (ext === 'pug' || ext === 'jade') for (const m of src.matchAll(/#\{\s*([A-Za-z_$][\w$]*)|^\s*each\s+\w+(?:\s*,\s*\w+)?\s+in\s+([A-Za-z_$][\w$]*)/gm)) add(m[1] || m[2]);
  else for (const m of src.matchAll(/\{\{\{?\s*(?:#\w+\s+)?([A-Za-z_$][\w$]*)/g)) add(m[1]);
  return out.slice(0, 60);
}

/** Mongoose, Sequelize, TypeORM and Prisma models. */
function jsModels(ctx: ScanContext, g: GraphBuilder, parsed: Map<string, JsFile>, root: string): Map<string, ModelNode> {
  const out = new Map<string, ModelNode>();
  const add = (name: string, file: string, line: number, table: string | undefined, fields: FieldInfo[], relations: RelationInfo[], kind: 'orm' | 'document') => {
    if (out.has(name)) return;
    out.set(name, g.addModel({ id: `model:${file}#${name}`, name, kind, file, line, table, fields, relations, framework: 'express' }));
  };
  for (const [f, js] of parsed) {
    const code = js.code;
    // Mongoose
    const schemas = new Map<string, { fields: FieldInfo[]; relations: RelationInfo[] }>();
    for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(code, open);
      const fields: FieldInfo[] = [{ name: '_id', type: 'ObjectId', primary: true }];
      const relations: RelationInfo[] = [];
      for (const part of splitTopLevel(code.slice(open + 1, close))) {
        const pm = /^['"]?(\w+)['"]?\s*:\s*([\s\S]*)$/.exec(part);
        if (!pm) continue;
        const type = /type\s*:\s*\[?\s*([\w.]+)/.exec(pm[2])?.[1] || /^\[?\s*([\w.]+)/.exec(pm[2])?.[1];
        const ref = /ref\s*:\s*['"](\w+)['"]/.exec(pm[2])?.[1];
        fields.push({ name: pm[1], type: type?.split('.').pop(), references: ref });
        if (ref) relations.push({ kind: pm[2].trim().startsWith('[') ? 'hasMany(ref)' : 'ref', target: ref, via: pm[1] });
      }
      schemas.set(m[1], { fields, relations });
    }
    for (const m of code.matchAll(/(?:mongoose\.)?model\s*(?:<[^>]*>)?\(\s*['"](\w+)['"]\s*,\s*(\w+)(?:\s*,\s*['"](\w+)['"])?/g)) {
      const s = schemas.get(m[2]);
      add(m[1], f, js.lines.lineAt(m.index!), m[3] || m[1].toLowerCase() + 's', s?.fields || [], s?.relations || [], 'document');
    }
    // Sequelize define
    for (const m of code.matchAll(/\.define\(\s*['"](\w+)['"]\s*,\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBracket(code, open);
      const fields = splitTopLevel(code.slice(open + 1, close)).map((p) => /^['"]?(\w+)['"]?\s*:\s*(?:\{[^}]*type\s*:\s*)?(?:DataTypes|Sequelize)\.(\w+)/.exec(p)).filter(Boolean).map((x) => ({ name: x![1], type: x![2].toLowerCase() }));
      const opts = code.slice(close, close + 300);
      const table = /tableName\s*:\s*['"](\w+)['"]/.exec(opts)?.[1] || m[1].toLowerCase() + 's';
      add(m[1], f, js.lines.lineAt(m.index!), table, [{ name: 'id', primary: true }, ...fields], [], 'orm');
    }
    // Sequelize class Model.init / TypeORM @Entity
    for (const m of code.matchAll(/class\s+(\w+)\s+extends\s+Model\b/g)) {
      const init = new RegExp(`${m[1]}\\.init\\(\\s*\\{`).exec(code);
      const fields: FieldInfo[] = [{ name: 'id', primary: true }];
      let table = m[1].toLowerCase() + 's';
      if (init) {
        const open = init.index + init[0].length - 1;
        const close = matchBracket(code, open);
        for (const p of splitTopLevel(code.slice(open + 1, close))) {
          const x = /^(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*)?(?:DataTypes|Sequelize)\.(\w+)/.exec(p);
          if (x) fields.push({ name: x[1], type: x[2].toLowerCase() });
        }
        table = /tableName\s*:\s*['"](\w+)['"]/.exec(code.slice(close, close + 300))?.[1] || table;
      }
      add(m[1], f, js.lines.lineAt(m.index!), table, fields, [], 'orm');
    }
    for (const m of code.matchAll(/@Entity\(\s*(?:['"](\w+)['"])?[^)]*\)\s*(?:export\s+)?class\s+(\w+)/g)) {
      const open = code.indexOf('{', m.index! + m[0].length);
      const close = matchBracket(code, open);
      const body = code.slice(open, close);
      const fields = Array.from(body.matchAll(/@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn)\([^)]*\)\s*(\w+)\s*[!?]?\s*:\s*([\w[\]]+)/g)).map((x) => ({ name: x[2], type: x[3], primary: x[1].startsWith('Primary') || undefined }));
      const relations = Array.from(body.matchAll(/@(ManyToOne|OneToMany|OneToOne|ManyToMany)\(\s*\(\)\s*=>\s*(\w+)[^)]*\)[^:]*?(\w+)\s*[!?]?\s*:/g)).map((x) => ({ kind: x[1], target: x[2], via: x[3] }));
      add(m[2], f, js.lines.lineAt(m.index!), m[1] || m[2].toLowerCase(), fields, relations, 'orm');
    }
  }
  // Prisma
  for (const pf of ctx.under(root, 'schema.prisma')) {
    const src = ctx.read(pf.path);
    if (!src) continue;
    const lines = new LineIndex(src);
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const fields: FieldInfo[] = [];
      const relations: RelationInfo[] = [];
      for (const l of m[2].split('\n')) {
        const fm = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(l);
        if (!fm || fm[1].startsWith('@@')) continue;
        const rel = /@relation\(\s*fields:\s*\[(\w+)\]/.exec(fm[5]);
        if (/^[A-Z]/.test(fm[2]) && !/^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)$/.test(fm[2])) {
          relations.push({ kind: fm[3] ? 'hasMany' : 'belongsTo', target: fm[2], via: fm[1] });
          continue;
        }
        fields.push({ name: fm[1], type: fm[2], nullable: fm[4] ? true : undefined, primary: /@id\b/.test(fm[5]) || undefined });
        void rel;
      }
      const table = /@@map\(\s*"(\w+)"/.exec(m[2])?.[1] || m[1];
      add(m[1], pf.path, lines.lineAt(m.index!), table, fields, relations, 'orm');
      const t = g.ensureTable(table);
      for (const r of relations) {
        const fk = new RegExp(`${r.via}\\s+${r.target}\\??\\s+@relation\\(\\s*fields:\\s*\\[(\\w+)\\]\\s*,\\s*references:\\s*\\[(\\w+)\\]`).exec(m[2]);
        if (fk) t.foreignKeys.push({ column: fk[1], references: `${r.target}.${fk[2]}`, inferred: false });
      }
    }
  }
  return out;
}

const MW_DESC: Record<string, string> = {
  'express.json': 'Parses JSON request bodies', 'express.urlencoded': 'Parses form bodies', 'express.static': 'Serves static files',
  cors: 'CORS headers', helmet: 'Security headers', morgan: 'HTTP request logging', 'cookieParser': 'Parses cookies', session: 'Server-side sessions',
  compression: 'Gzip responses', 'passport.initialize': 'Passport authentication', 'passport.session': 'Passport session restore', csurf: 'CSRF protection',
  rateLimit: 'Rate limiting', multer: 'Multipart / file uploads', 'bodyParser.json': 'Parses JSON request bodies', 'bodyParser.urlencoded': 'Parses form bodies',
};
