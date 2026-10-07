/** FastAPI and Flask adapters: decorator routes, routers/blueprints, dependencies, models and Jinja templates. */
import { Adapter, Detection } from '../types';
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { PyBlock } from '../../parsers/python';
import { kwargs, positional } from '../../parsers/python';
import { splitTopLevel, unquote } from '../../parsers/common';
import { pipVersion } from '../shared/manifest';
import { addTemplates, PyProject, pyHandler, pydanticSchemas, sqlAlchemyModels } from '../shared/python';
import { dirname, normalizeUrlPath, uniq } from '../../utils/text';

type Kind = 'fastapi' | 'flask';

interface Mount {
  parent: string;
  prefix: string;
  deps: string[];
}

const SKIP = /(^|\/)(tests?|migrations|alembic|venv|\.venv|site-packages|scripts)\//;

function detectPy(ctx: ScanContext, kind: Kind): Detection[] {
  const ctor = kind === 'fastapi' ? /\bFastAPI\s*\(/ : /\bFlask\s*\(\s*__name__/;
  const imp = kind === 'fastapi' ? /from\s+fastapi\s+import|import\s+fastapi/ : /from\s+flask\s+import|import\s+flask\b/;
  const apps = ctx.files.filter((f) => f.ext === 'py' && !SKIP.test(f.path)).filter((f) => {
    const t = ctx.read(f.path);
    return !!t && imp.test(t) && ctor.test(t);
  });
  if (!apps.length) return [];
  const roots = uniq(apps.map((a) => projectRoot(ctx, a.path)));
  return roots.map((root) => ({
    id: kind, name: kind === 'fastapi' ? 'FastAPI' : 'Flask', language: 'Python', root, confidence: 0.9,
    evidence: apps.filter((a) => projectRoot(ctx, a.path) === root).slice(0, 3).map((a) => `${a.path} creates ${kind === 'fastapi' ? 'FastAPI()' : 'Flask(__name__)'}`),
    version: pipVersion(ctx, root, kind) || pipVersion(ctx, '.', kind),
  }));
}

/** The nearest ancestor holding a Python manifest, else ".". */
function projectRoot(ctx: ScanContext, file: string): string {
  for (let d = dirname(file); ; d = dirname(d)) {
    const p = (s: string) => (d === '.' ? s : `${d}/${s}`);
    if (['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].some((m) => ctx.has(p(m)))) return d;
    if (d === '.') return '.';
  }
}

function analyzePy(kind: Kind, ctx: ScanContext, det: Detection, g: GraphBuilder): void {
  const root = det.root;
  const files = ctx.under(root, '.py').map((f) => f.path).filter((f) => !SKIP.test(f));
  const appDirs = uniq(det.evidence.map((e) => dirname(e.split(' ')[0])));
  const py = new PyProject(ctx, uniq([root, ...appDirs, ...appDirs.map(dirname)]));
  const fw = kind;

  const models = sqlAlchemyModels(ctx, g, py, files, fw);
  if (kind === 'fastapi') pydanticSchemas(g, py, files, fw);
  const templateDirs = uniq(ctx.files.filter((f) => f.path.startsWith(root === '.' ? '' : root + '/') && /\/templates\//.test('/' + f.path)).map((f) => {
    const s = '/' + f.path;
    return s.slice(1, s.indexOf('/templates/') + 10);
  }));
  const templates = addTemplates(ctx, g, templateDirs, 'jinja');
  const resolveTemplate = (n: string) => templates.get(n);

  // 1. instances: app = FastAPI() / router = APIRouter(prefix=…) / bp = Blueprint('x', __name__, url_prefix=…)
  const instances = new Map<string, { kind: 'app' | 'router'; prefix: string; deps: string[]; name?: string }>();
  const ctorRe = kind === 'fastapi' ? /^(\w+)\s*(?::\s*\w+\s*)?=\s*(?:fastapi\.)?(FastAPI|APIRouter)\(([\s\S]*)\)\s*$/ : /^(\w+)\s*=\s*(?:flask\.)?(Flask|Blueprint)\(([\s\S]*)\)\s*$/;
  for (const f of files) {
    const p = py.parse(f);
    if (!p) continue;
    for (const l of p.topLevel) {
      const m = ctorRe.exec(l.text);
      if (!m) continue;
      const args = splitTopLevel(m[3]);
      const kw = kwargs(args);
      const isApp = m[2] === 'FastAPI' || m[2] === 'Flask';
      instances.set(`${f}#${m[1]}`, {
        kind: isApp ? 'app' : 'router',
        prefix: unquote(kw.prefix || kw.url_prefix) || '',
        deps: depsOf(kw.dependencies),
        name: m[2] === 'Blueprint' ? unquote(positional(args)[0]) || m[1] : undefined,
      });
    }
  }
  const instanceOf = (ref: string, file: string): string | undefined => {
    if (instances.has(`${file}#${ref}`)) return `${file}#${ref}`;
    const r = py.resolve(ref, file);
    if (r && instances.has(`${r.file}#${r.qual}`)) return `${r.file}#${r.qual}`;
    // "from .routers import users" + "users.router"
    if (r) {
      const asModule = py.moduleFile(`${py.moduleName(r.file)}.${r.qual.split('.')[0]}`, file);
      const rest = r.qual.split('.').slice(1).join('.');
      if (asModule && instances.has(`${asModule}#${rest}`)) return `${asModule}#${rest}`;
    }
    return undefined;
  };

  // 2. mounts: app.include_router(x.router, prefix=…) / app.register_blueprint(bp, url_prefix=…)
  const mounts = new Map<string, Mount[]>();
  const includeRe = kind === 'fastapi' ? /^(\w+)\.include_router\(([\s\S]*)\)\s*$/ : /^(\w+)\.register_blueprint\(([\s\S]*)\)\s*$/;
  for (const f of files) {
    const p = py.parse(f);
    if (!p) continue;
    for (const l of p.lines) {
      const m = includeRe.exec(l.text);
      if (!m) continue;
      const parent = instanceOf(m[1], f);
      const args = splitTopLevel(m[2]);
      const kw = kwargs(args);
      const child = instanceOf(positional(args)[0] || '', f);
      if (!parent || !child) continue;
      if (!mounts.has(child)) mounts.set(child, []);
      mounts.get(child)!.push({ parent, prefix: unquote(kw.prefix || kw.url_prefix) || '', deps: depsOf(kw.dependencies) });
    }
  }
  const fullPrefix = (key: string, seen = new Set<string>()): { prefix: string; deps: string[]; mounted: boolean } => {
    const inst = instances.get(key)!;
    if (inst.kind === 'app' || seen.has(key)) return { prefix: inst.prefix, deps: inst.deps, mounted: true };
    seen.add(key);
    const m = (mounts.get(key) || [])[0];
    if (!m) return { prefix: inst.prefix, deps: inst.deps, mounted: false };
    const parent = fullPrefix(m.parent, seen);
    // Flask: register_blueprint(url_prefix=…) replaces the blueprint's own url_prefix
    const own = kind === 'flask' && m.prefix ? '' : inst.prefix;
    return { prefix: join(parent.prefix, m.prefix, own), deps: [...parent.deps, ...m.deps, ...inst.deps], mounted: parent.mounted };
  };

  // 3. routes: decorated functions
  const verbRe = kind === 'fastapi'
    ? /^(\w+)\.(get|post|put|patch|delete|options|head|api_route|websocket)\(([\s\S]*)\)$/
    : /^(\w+)\.(route|get|post|put|patch|delete)\(([\s\S]*)\)$/;
  for (const f of files) {
    const p = py.parse(f);
    if (!p) continue;
    const area = instances.size > 1 ? f.split('/').pop()!.replace(/\.py$/, '') : 'app';
    for (const b of p.all) {
      if (b.kind !== 'def') continue;
      for (const d of b.decorators) {
        const m = verbRe.exec(d.text);
        if (!m) continue;
        const key = instanceOf(m[1], f);
        if (!key) continue;
        const args = splitTopLevel(m[3]);
        const kw = kwargs(args);
        const path = unquote(positional(args)[0] || kw.path || kw.rule) ?? '';
        const methods = m[2] === 'route' || m[2] === 'api_route'
          ? (kw.methods ? Array.from(kw.methods.matchAll(/['"](\w+)['"]/g)).map((x) => x[1].toUpperCase()) : ['GET'])
          : [m[2] === 'websocket' ? 'WS' : m[2].toUpperCase()];
        const mount = fullPrefix(key);
        const guards = uniq([...mount.deps, ...depsOf(kw.dependencies), ...paramDeps(b), ...decoratorGuards(b)]);
        const h = pyHandler(g, py, f, b, { framework: fw, models, resolveTemplate, area });
        if (kind === 'fastapi' && !h.responses.some((r) => r === 'json' || r === 'html' || r === 'file')) h.responses.push('json');
        if (kw.response_model) h.steps.push({ kind: 'response', line: d.line, text: `Serializes with response_model ${kw.response_model}` });
        const inst = instances.get(key)!;
        const endpoint = kind === 'flask' ? (inst.name && inst.kind === 'router' ? `${inst.name}.${b.name}` : unquote(kw.endpoint) || b.name) : unquote(kw.name) || b.name;
        for (const method of methods) {
          const r = g.addRoute({
            method, path: normalizeUrlPath(join(mount.prefix, path)), name: endpoint, target: `${py.moduleName(f)}.${b.name}`, handler: h.id,
            middleware: guards, file: f, line: d.line, framework: fw, notes: mount.mounted ? undefined : ['Router/blueprint is never included in an app'],
          });
          g.addEdge(r.id, h.id, 'routes-to');
          for (const gd of guards) {
            if (!g.middleware.has(`middleware:${gd}`)) g.addMiddleware({ id: `middleware:${gd}`, name: gd, kind: kind === 'fastapi' ? 'dependency' : 'decorator', framework: fw });
            g.addEdge(r.id, `middleware:${gd}`, 'protected-by');
          }
        }
      }
    }
    // global middleware
    for (const l of p.lines) {
      const am = /^\w+\.add_middleware\(\s*([\w.]+)/.exec(l.text);
      if (am) g.addMiddleware({ id: `middleware:${am[1]}`, name: am[1], kind: 'global', file: f, line: l.line, framework: fw, description: MW_DESC[am[1]] });
      if (kind === 'flask' && /^(\w+)\.(before_request|after_request)\b/.test(l.text)) g.addMiddleware({ id: `middleware:${l.text}`, name: l.text.replace(/^\w+\./, ''), kind: 'global', file: f, line: l.line, framework: fw });
      if (kind === 'flask' && /^\w+\.run\([^)]*debug\s*=\s*True/.test(l.text)) {
        g.addFinding({ severity: 'medium', category: 'security', rule: 'flask-debug', file: f, line: l.line, title: 'Flask debug mode enabled in app.run()', detail: 'The Werkzeug debugger allows arbitrary code execution if exposed. Never run with debug=True in production.' });
      }
    }
    for (const b of p.all) {
      if (b.decorators.some((d) => /^\w+\.middleware\(\s*['"]http['"]\s*\)/.test(d.text))) g.addMiddleware({ id: `middleware:${b.name}`, name: b.name, kind: 'global', file: f, line: b.line, framework: fw, description: 'HTTP middleware function' });
      if (kind === 'flask' && b.decorators.some((d) => /^\w+\.(before_request|before_app_request)$/.test(d.text))) g.addMiddleware({ id: `middleware:${b.name}`, name: b.name, kind: 'global', file: f, line: b.line, framework: fw, description: 'Runs before each request' });
    }
  }

  const n = Array.from(g.routes.values()).filter((r) => r.framework === fw).length;
  if (kind === 'fastapi') {
    g.lifecycle.push(
      { id: 'fa-server', title: 'ASGI server', subtitle: 'uvicorn / gunicorn', detail: 'An ASGI server (usually uvicorn) runs the FastAPI() application object.', files: det.evidence.map((e) => e.split(' ')[0]) },
      { id: 'fa-mw', title: 'Middleware', subtitle: 'app.add_middleware', detail: 'Middleware such as CORS, GZip or custom @app.middleware("http") functions wrap every request.' },
      { id: 'fa-router', title: 'Router', subtitle: `${n} path operations`, detail: 'The path and method select a path operation; include_router() prefixes are applied from the app down.' },
      { id: 'fa-deps', title: 'Dependencies', subtitle: 'Depends(…)', detail: 'Dependencies run first: database sessions, current user / auth checks, pagination params.' },
      { id: 'fa-validate', title: 'Validation', subtitle: 'Pydantic', detail: 'Path, query and body parameters are parsed and validated against type hints and Pydantic models (422 on failure).' },
      { id: 'fa-handler', title: 'Path operation', subtitle: 'async def …', detail: 'The function runs business logic and database queries (SQLAlchemy / ORM).' },
      { id: 'fa-response', title: 'Response', subtitle: 'JSON via response_model', detail: 'The return value is serialized to JSON (filtered by response_model) or a custom Response is returned.' },
    );
    g.recipes.push({ id: 'fa-endpoint', title: 'Add an endpoint', summary: 'Router + path operation + schema.', files: [], steps: [
      'Create or open a router module: router = APIRouter(prefix="/things", tags=["things"]).',
      'Add @router.get("/{thing_id}", response_model=ThingOut) async def get_thing(thing_id: int, db: Session = Depends(get_db)).',
      'Define ThingIn / ThingOut Pydantic schemas for the body and response.',
      'app.include_router(things.router) in the main application module.',
      'Protect it with a dependency such as Depends(get_current_user).',
    ] });
  } else {
    g.lifecycle.push(
      { id: 'fl-server', title: 'WSGI server', subtitle: 'gunicorn / flask run', detail: 'A WSGI server calls the Flask application object.', files: det.evidence.map((e) => e.split(' ')[0]) },
      { id: 'fl-before', title: 'before_request hooks', subtitle: 'app / blueprint', detail: 'before_request functions run first (loading the user, opening DB connections).' },
      { id: 'fl-route', title: 'URL map', subtitle: `${n} routes`, detail: 'The URL map selects a view function; blueprint url_prefix values are applied.' },
      { id: 'fl-view', title: 'View function', subtitle: 'request.form / request.args', detail: 'The view reads request data, validates it and queries the database.' },
      { id: 'fl-template', title: 'Template', subtitle: 'render_template (Jinja2)', detail: 'HTML responses are rendered from Jinja2 templates; APIs return jsonify().' },
      { id: 'fl-response', title: 'Response', subtitle: 'after_request', detail: 'after_request hooks run and the response is returned.' },
    );
    g.recipes.push({ id: 'fl-page', title: 'Add a page', summary: 'Blueprint route + template.', files: [], steps: [
      "@bp.route('/my-page') def my_page(): return render_template('my_page.html', items=items)",
      'Create templates/my_page.html extending the base template.',
      "Link with url_for('bp.my_page'); add @login_required if needed.",
    ] });
  }
}

function depsOf(expr: string | undefined): string[] {
  if (!expr) return [];
  return Array.from(expr.matchAll(/Depends\(\s*([\w.]+)/g)).map((m) => m[1].split('.').pop()!);
}

function paramDeps(b: PyBlock): string[] {
  return Array.from(b.args.matchAll(/(?:Depends|Security)\(\s*([\w.]+)/g)).map((m) => m[1].split('.').pop()!).filter((d) => /user|auth|admin|permission|token|role|verify|require|current|security|api_key/i.test(d));
}

function decoratorGuards(b: PyBlock): string[] {
  return b.decorators.map((d) => /^([\w.]+)/.exec(d.text)?.[1].split('.').pop() || '').filter((d) => /login_required|roles?_required|permission|admin_required|auth|jwt_required|limiter|limit/.test(d));
}

function join(...parts: string[]): string {
  return parts.map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

const MW_DESC: Record<string, string> = {
  CORSMiddleware: 'CORS headers for browser clients', GZipMiddleware: 'Compresses responses', TrustedHostMiddleware: 'Rejects unexpected Host headers',
  HTTPSRedirectMiddleware: 'Redirects HTTP to HTTPS', SessionMiddleware: 'Signed cookie sessions',
};

export const fastapi: Adapter = {
  id: 'fastapi', name: 'FastAPI', language: 'Python',
  detect: (ctx) => detectPy(ctx, 'fastapi'),
  analyze: (ctx, det, g) => analyzePy('fastapi', ctx, det, g),
};

export const flask: Adapter = {
  id: 'flask', name: 'Flask', language: 'Python',
  detect: (ctx) => detectPy(ctx, 'flask'),
  analyze: (ctx, det, g) => analyzePy('flask', ctx, det, g),
};
