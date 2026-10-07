/** Django adapter: URLconf (incl. DRF routers), views, models, templates and middleware. */
import { Adapter, Detection } from '../types';
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { FieldInfo, ModelNode, RelationInfo } from '../../schema/graph';
import { PyBlock } from '../../parsers/python';
import { splitTopLevel, unquote, matchBracket } from '../../parsers/common';
import { kwargs, positional } from '../../parsers/python';
import { pipVersion } from '../shared/manifest';
import { addTemplates, PyProject, pyHandler } from '../shared/python';
import { dirname, normalizeUrlPath, uniq } from '../../utils/text';

interface UrlCtx {
  prefix: string;
  namespace: string;
  decorators: string[];
}

const GENERIC_GET = /^(ListView|DetailView|TemplateView|RedirectView|ArchiveIndexView|YearArchiveView|MonthArchiveView|DayArchiveView|DateDetailView)$/;
const GENERIC_FORM = /^(CreateView|UpdateView|FormView|DeleteView|LoginView|LogoutView|PasswordChangeView|PasswordResetView|PasswordResetConfirmView)$/;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const VIEWSET_ACTIONS: Array<[string, string, boolean]> = [
  ['list', 'GET', false], ['create', 'POST', false], ['retrieve', 'GET', true], ['update', 'PUT', true], ['partial_update', 'PATCH', true], ['destroy', 'DELETE', true],
];

export const django: Adapter = {
  id: 'django',
  name: 'Django',
  language: 'Python',

  detect(ctx) {
    const out: Detection[] = [];
    for (const f of ctx.files) {
      if (!/(^|\/)manage\.py$/.test(f.path)) continue;
      const src = ctx.read(f.path) || '';
      if (!/django|DJANGO_SETTINGS_MODULE/.test(src)) continue;
      const root = dirname(f.path);
      out.push({
        id: 'django', name: 'Django', language: 'Python', root, confidence: 0.95, evidence: [f.path],
        version: pipVersion(ctx, root, 'django') || pipVersion(ctx, '.', 'django') || pipVersion(ctx, root, 'Django'),
      });
    }
    return out;
  },

  analyze(ctx, det, g) {
    const root = det.root;
    const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
    const py = new PyProject(ctx, [root]);
    const manage = ctx.read(p('manage.py')) || '';
    const settingsModule = /DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)['"]/.exec(manage)?.[1];
    const settingsFile = settingsModule ? py.moduleFile(settingsModule, p('manage.py')) : undefined;
    const settingsFiles = settingsFile ? uniq([settingsFile, ...ctx.under(dirname(settingsFile), '.py').filter((f) => /settings/.test(f.path)).map((f) => f.path)]) : [];
    const settings = settingsFiles.map((f) => ctx.read(f) || '').join('\n');
    const listSetting = (name: string) => {
      const m = new RegExp(`^${name}\\s*\\+?=\\s*[\\[(]`, 'm').exec(settings);
      if (!m) return [] as string[];
      const open = m.index + m[0].length - 1;
      const close = matchBracket(settings, open);
      return splitTopLevel(settings.slice(open + 1, close)).map((x) => unquote(x)).filter((x): x is string => !!x);
    };
    hints(g, root, settingsFile);

    // ---------------------------------------------------------- apps
    const installed = listSetting('INSTALLED_APPS');
    const localApps = uniq(installed.map((a) => a.replace(/\.apps\.\w+Config$/, '')).filter((a) => ctx.has(p(a.replace(/\./g, '/') + '/__init__.py')) || ctx.has(p(a.replace(/\./g, '/') + '/models.py'))));
    const appDirs = localApps.length ? localApps.map((a) => p(a.replace(/\./g, '/'))) : uniq(ctx.under(root, 'models.py').map((f) => dirname(f.path)));

    // -------------------------------------------------------- models
    const models = new Map<string, ModelNode>();
    const modelBlocks: Array<{ file: string; b: PyBlock; app: string }> = [];
    for (const dir of appDirs) {
      for (const f of ctx.under(dir, '.py').filter((x) => /\/models(\.py|\/)/.test(x.path))) {
        const parsed = py.parse(f.path);
        for (const b of parsed?.blocks || []) if (b.kind === 'class') modelBlocks.push({ file: f.path, b, app: dir.split('/').pop()! });
      }
    }
    const isModelBase = (args: string, known: Set<string>) => /models\.Model\b|AbstractUser|AbstractBaseUser|PermissionsMixin|TimeStampedModel|MPTTModel/.test(args) || args.split(',').some((a) => known.has(a.trim()));
    const known = new Set<string>();
    for (let pass = 0; pass < 3; pass++) for (const mb of modelBlocks) if (!known.has(mb.b.name) && isModelBase(mb.b.args, known)) known.add(mb.b.name);
    for (const { file, b, app } of modelBlocks) {
      if (!known.has(b.name)) continue;
      const meta = b.children.find((c) => c.name === 'Meta');
      const abstract = meta?.body.some((l) => /abstract\s*=\s*True/.test(l.text));
      const dbTable = meta?.body.map((l) => /db_table\s*=\s*['"](\w+)['"]/.exec(l.text)?.[1]).find(Boolean);
      const fields: FieldInfo[] = [{ name: 'id', type: 'auto', primary: true }];
      const relations: RelationInfo[] = [];
      for (const l of b.body) {
        if (l.indent <= b.indent || b.children.some((c) => l.line >= c.line && l.line <= c.endLine)) continue;
        const m = /^(\w+)\s*=\s*(?:models\.)?(\w+Field|ForeignKey|OneToOneField|ManyToManyField|GenericForeignKey)\(([\s\S]*)\)\s*$/.exec(l.text);
        if (!m) continue;
        const args = splitTopLevel(m[3]);
        const kw = kwargs(args);
        if (/ForeignKey|OneToOneField|ManyToManyField/.test(m[2])) {
          const targetRaw = positional(args)[0] || kw.to || '';
          const target = (unquote(targetRaw) ?? targetRaw).split('.').pop()!;
          relations.push({ kind: m[2], target: target === 'self' ? b.name : target, via: m[1] });
          if (m[2] !== 'ManyToManyField') fields.push({ name: `${m[1]}_id`, type: m[2], nullable: /True/.test(kw.null || '') || undefined, references: target });
        } else fields.push({ name: m[1], type: m[2].replace(/Field$/, '').toLowerCase(), nullable: /True/.test(kw.null || '') || undefined, primary: /True/.test(kw.primary_key || '') || undefined });
        if (/primary_key\s*=\s*True/.test(m[3])) fields.shift();
      }
      const node = g.addModel({
        id: `model:${py.moduleName(file)}.${b.name}`, name: b.name, kind: 'orm', file, line: b.line,
        table: abstract ? undefined : dbTable || `${app}_${b.name.toLowerCase()}`, fields, relations, framework: 'django',
      });
      models.set(b.name, node);
    }
    // FKs between tables
    for (const m of models.values()) {
      if (!m.table) continue;
      const t = g.ensureTable(m.table);
      for (const f of m.fields) {
        const target = f.references ? models.get(f.references) : undefined;
        if (target?.table && !t.foreignKeys.some((x) => x.column === f.name)) t.foreignKeys.push({ column: f.name, references: `${target.table}.id`, inferred: false });
      }
    }

    // ------------------------------------------------------ templates
    const templateDirs = uniq([
      ...appDirs.map((d) => `${d}/templates`),
      ...Array.from(settings.matchAll(/['"]DIRS['"]\s*:\s*\[([^\]]*)\]/g)).flatMap((m) => Array.from(m[1].matchAll(/['"]([\w\-/]+)['"]/g)).map((x) => p(x[1]))),
      p('templates'),
      ...ctx.files.filter((f) => f.path.startsWith(root === '.' ? '' : root + '/') && /\/templates\//.test(f.path)).map((f) => f.path.slice(0, f.path.indexOf('/templates/') + 10)),
    ]);
    const templates = addTemplates(ctx, g, templateDirs, 'django');
    const resolveTemplate = (n: string) => templates.get(n);

    // ---------------------------------------------------- middleware
    for (const mw of listSetting('MIDDLEWARE')) {
      const name = mw.split('.').pop()!;
      g.addMiddleware({ id: `middleware:${name}`, name, kind: 'global', framework: 'django', description: MIDDLEWARE_DESC[name] || mw });
    }
    if (settingsFile && !listSetting('MIDDLEWARE').some((m) => /CsrfViewMiddleware/.test(m)) && listSetting('MIDDLEWARE').length) {
      g.addFinding({ severity: 'medium', category: 'security', rule: 'django-csrf-middleware', file: settingsFile, title: 'CsrfViewMiddleware is not enabled', detail: 'Django\'s CSRF protection middleware is missing from MIDDLEWARE, so form posts are not protected.' });
    }
    if (/^DEBUG\s*=\s*True/m.test(settings) && settingsFile) {
      g.addFinding({ severity: 'medium', category: 'security', rule: 'django-debug', file: settingsFile, title: 'DEBUG = True in settings', detail: 'If these settings are used in production, error pages leak code, settings and SQL. Read DEBUG from the environment.' });
    }
    if (/ALLOWED_HOSTS\s*=\s*\[\s*['"]\*['"]\s*\]/.test(settings) && settingsFile) {
      g.addFinding({ severity: 'low', category: 'security', rule: 'django-allowed-hosts', file: settingsFile, title: "ALLOWED_HOSTS = ['*']", detail: 'Any Host header is accepted, which enables host-header attacks on password reset links and caches.' });
    }

    // -------------------------------------------------------- views & urls
    const state: DjState = { ctx, g, py, models, resolveTemplate, root, seen: new Set() };
    const rootUrlconf = /^ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/m.exec(settings)?.[1];
    const urlsFile = rootUrlconf ? py.moduleFile(rootUrlconf, p('manage.py')) : ctx.under(root, 'urls.py')[0]?.path;
    if (urlsFile) parseUrls(state, urlsFile, { prefix: '', namespace: '', decorators: [] }, 0);
    else ctx.warn(`Django: could not find ROOT_URLCONF for ${root}`);
    // views that no URL reaches still belong in the code explorer
    for (const dir of appDirs) {
      for (const f of ctx.under(dir, '.py').filter((x) => /\/(views|api|viewsets)(\.py|\/)/.test(x.path))) {
        for (const b of py.parse(f.path)?.blocks || []) {
          if (b.kind === 'def' && /request/.test(b.args)) pyHandler(g, py, f.path, b, { framework: 'django', models, resolveTemplate, area: dir.split('/').pop()! });
          else if (b.kind === 'class' && /View|ViewSet|Mixin|APIView/.test(b.args)) classView(state, f.path, b, dir.split('/').pop()!);
        }
      }
    }

    lifecycle(g, root, listSetting('MIDDLEWARE'));
    recipes(g, root, appDirs[0]);
  },
};

interface DjState {
  ctx: ScanContext;
  g: GraphBuilder;
  py: PyProject;
  models: Map<string, ModelNode>;
  resolveTemplate(n: string): string | undefined;
  root: string;
  seen: Set<string>;
}

function areaOf(file: string): string {
  const parts = file.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : 'project';
}

/** Creates the container + handlers for a class-based view / viewset. Returns handler ids by HTTP method or action. */
function classView(s: DjState, file: string, b: PyBlock, area: string): Map<string, string> {
  const out = new Map<string, string>();
  const cid = `controller:py:${s.py.moduleName(file)}.${b.name}`;
  s.g.addContainer({ id: cid, name: b.name, kind: /ViewSet/.test(b.args) ? 'viewset' : 'controller', file, line: b.line, area, extends: b.args, framework: 'django' });
  const attr = (n: string) => b.body.find((l) => l.indent > b.indent && new RegExp(`^${n}\\s*=`).test(l.text))?.text.replace(/^\w+\s*=\s*/, '');
  for (const child of b.children) {
    if (child.kind !== 'def') continue;
    const h = pyHandler(s.g, s.py, file, child, { framework: 'django', models: s.models, resolveTemplate: s.resolveTemplate, area, container: cid });
    out.set(child.name, h.id);
  }
  const bases = b.args.split(',').map((x) => x.trim().split('.').pop()!);
  const generic = bases.find((x) => GENERIC_GET.test(x) || GENERIC_FORM.test(x) || /ViewSet$/.test(x));
  if (generic) {
    // the framework provides the handler; describe it from the class attributes
    const model = (attr('model') || '').trim() || /^(\w+)\.objects/.exec(attr('queryset') || '')?.[1];
    const template = unquote(attr('template_name'));
    const steps = [] as Array<{ kind: 'db' | 'view' | 'validate' | 'redirect'; line: number; text: string }>;
    if (model) steps.push({ kind: 'db', line: b.line, text: `${/Create|Update|Delete|ModelViewSet/.test(generic) ? 'READ/WRITE' : 'READ'} ${model}` });
    if (attr('form_class') || attr('serializer_class')) steps.push({ kind: 'validate', line: b.line, text: `Validates with ${attr('form_class') || attr('serializer_class')}` });
    if (template) steps.push({ kind: 'view', line: b.line, text: `Renders view ${template}` });
    if (attr('success_url')) steps.push({ kind: 'redirect', line: b.line, text: `Redirects to ${attr('success_url')}` });
    const actions = /ViewSet$/.test(generic) ? VIEWSET_ACTIONS.map((a) => a[0]).filter((a) => /ReadOnly/.test(generic) ? a === 'list' || a === 'retrieve' : /^ModelViewSet$/.test(generic) || out.has(a)) : ['__generic__'];
    for (const action of actions) {
      if (out.has(action)) continue;
      const id = `py:${s.py.moduleName(file)}.${b.name}.${action === '__generic__' ? generic : action}`;
      const modelNode = model ? s.models.get(model) : undefined;
      const tid = template ? s.resolveTemplate(template) : undefined;
      const h = s.g.addHandler({
        id, name: action === '__generic__' ? `${generic} (framework)` : action, container: cid, kind: 'class', file, line: b.line, endLine: b.endLine, framework: 'django', area,
        steps: steps.map((x) => ({ ...x })), models: modelNode ? [modelNode.id] : [], tables: modelNode?.table ? [modelNode.table] : [],
        data: modelNode ? [{ model: modelNode.id, table: modelNode.table, op: /Create|Update|Delete/.test(generic) || /create|update|destroy/.test(action) ? 'write' : 'read', line: b.line }] : [],
        views: template ? [{ view: tid || template, vars: ['object', 'object_list', model ? model.toLowerCase() : ''].filter(Boolean), line: b.line }] : [],
        responses: /ViewSet|APIView/.test(generic) ? ['json'] : template ? ['html'] : [],
      });
      if (tid) s.g.addEdge(id, tid, 'renders');
      const c = s.g.containers.get(cid)!;
      if (!c.handlers.includes(id)) c.handlers.push(id);
      out.set(action === '__generic__' ? 'get' : action, h.id);
      if (action === '__generic__' && GENERIC_FORM.test(generic)) out.set('post', h.id);
    }
  }
  return out;
}

function guards(b: PyBlock | undefined, extra: string[]): string[] {
  const out = [...extra];
  for (const d of b?.decorators || []) {
    const name = /^([\w.]+)/.exec(d.text)?.[1]?.split('.').pop();
    if (name && /login_required|permission_required|staff_member_required|user_passes_test|csrf_exempt|require_\w+|api_view|permission_classes|authentication_classes|cache_page|never_cache|throttle_classes/.test(name)) out.push(name === 'permission_classes' ? d.text.replace(/^permission_classes/, 'perm') : name);
  }
  if (b?.kind === 'class') {
    for (const base of b.args.split(',').map((x) => x.trim())) if (/Mixin$/.test(base)) out.push(base);
    const perm = b.body.find((l) => /^permission_classes\s*=/.test(l.text));
    if (perm) out.push(...Array.from(perm.text.matchAll(/(\w+)(?=\s*[,\])])/g)).map((m) => m[1]).filter((x) => x !== 'permission_classes'));
  }
  return uniq(out);
}

function methodsOf(b: PyBlock): string[] {
  for (const d of b.decorators) {
    if (/^require_POST/.test(d.text)) return ['POST'];
    if (/^require_GET|^require_safe/.test(d.text)) return ['GET'];
    const m = /^(?:require_http_methods|api_view)\(\s*\[([^\]]*)\]/.exec(d.text);
    if (m) return Array.from(m[1].matchAll(/['"](\w+)['"]/g)).map((x) => x[1].toUpperCase());
  }
  const body = b.body.map((l) => l.text).join('\n');
  if (/request\.method\s*==\s*['"]POST['"]|request\.POST/.test(body)) return ['GET', 'POST'];
  return ['GET'];
}

function convertPath(route: string, regex: boolean): string {
  if (!regex) return route.replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
  return route.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}').replace(/\([^)]*\)/g, '{x}').replace(/\\/g, '').replace(/[?*+]/g, '');
}

function parseUrls(s: DjState, file: string, c: UrlCtx, depth: number): void {
  const key = `${file}|${c.prefix}`;
  if (depth > 8 || s.seen.has(key)) return;
  s.seen.add(key);
  const parsed = s.py.parse(file);
  if (!parsed) return;
  const appName = parsed.topLevel.map((l) => /^app_name\s*=\s*['"](\w+)['"]/.exec(l.text)?.[1]).find(Boolean);
  const ns = appName ? (c.namespace ? `${c.namespace}:${appName}` : appName) : c.namespace;
  // routers: router = DefaultRouter(); router.register(r'items', ItemViewSet)
  const routers = new Map<string, Array<{ prefix: string; target: string; line: number }>>();
  for (const l of parsed.topLevel) {
    const r = /^(\w+)\s*=\s*(?:routers\.)?(?:Default|Simple|Nested\w*)Router\(/.exec(l.text);
    if (r) routers.set(r[1], []);
    const reg = /^(\w+)\.register\(\s*(r?['"][^'"]*['"])\s*,\s*([\w.]+)/.exec(l.text);
    if (reg && routers.has(reg[1])) routers.get(reg[1])!.push({ prefix: unquote(reg[2]) || '', target: reg[3], line: l.line });
  }
  const emitRouter = (name: string, prefix: string) => {
    for (const reg of routers.get(name) || []) {
      const resolved = s.py.resolve(reg.target, file);
      const block = resolved ? s.py.block(resolved.file, resolved.qual) : undefined;
      const handlers = block && resolved ? classView(s, resolved.file, block, areaOf(resolved.file)) : new Map<string, string>();
      const base = joinUrl(prefix, reg.prefix);
      for (const [action, m, detail] of VIEWSET_ACTIONS) {
        if (!handlers.has(action)) continue;
        addRoute(s, m, `${base}${detail ? '/{pk}' : ''}`, `${reg.target}.${action}`, handlers.get(action), file, reg.line, guards(block, c.decorators), `${ns ? ns + ':' : ''}${reg.prefix}-${detail ? 'detail' : 'list'}`);
      }
      for (const child of block?.children || []) {
        const act = child.decorators.find((d) => /^action\(/.test(d.text));
        if (!act || !resolved) continue;
        const detail = /detail\s*=\s*True/.test(act.text);
        const methods = Array.from((/methods\s*=\s*\[([^\]]*)\]/.exec(act.text)?.[1] || "'get'").matchAll(/['"](\w+)['"]/g)).map((x) => x[1].toUpperCase());
        const urlPath = unquote(/url_path\s*=\s*(['"][^'"]+['"])/.exec(act.text)?.[1]) || child.name.replace(/_/g, '-');
        const h = pyHandler(s.g, s.py, resolved.file, child, { framework: 'django', models: s.models, resolveTemplate: s.resolveTemplate, area: areaOf(resolved.file), container: `controller:py:${s.py.moduleName(resolved.file)}.${block!.name}` });
        for (const m of methods) addRoute(s, m, `${base}${detail ? '/{pk}' : ''}/${urlPath}`, `${reg.target}.${child.name}`, h.id, file, reg.line, guards(child, guards(block, c.decorators)));
      }
    }
  };

  for (const l of parsed.topLevel) {
    const assign = /^urlpatterns\s*(\+?=)\s*([\s\S]*)$/.exec(l.text);
    if (!assign) continue;
    for (const part of splitTopLevel(assign[2], '+')) {
      const t = part.trim();
      const routerRef = /^(\w+)\.urls$/.exec(t);
      if (routerRef) {
        emitRouter(routerRef[1], c.prefix);
        continue;
      }
      if (!t.startsWith('[')) continue;
      const close = matchBracket(t, 0);
      for (const item of splitTopLevel(t.slice(1, close))) {
        const m = /^(path|re_path|url)\(([\s\S]*)\)$/.exec(item.trim());
        if (!m) continue;
        const args = splitTopLevel(m[2]);
        const kw = kwargs(args);
        const pos = positional(args);
        const route = convertPath(unquote(pos[0]) ?? '', m[1] !== 'path');
        const full = joinUrl(c.prefix, route);
        const target = (pos[1] || kw.view || '').trim();
        const name = unquote(kw.name) || undefined;
        const fullName = name ? (ns ? `${ns}:${name}` : name) : undefined;
        const inc = /^include\(([\s\S]*)\)$/.exec(target);
        if (inc) {
          const iargs = splitTopLevel(inc[1]);
          const iref = iargs[0].trim();
          const inns = unquote(kwargs(iargs).namespace) || '';
          const childNs = inns ? (ns ? `${ns}:${inns}` : inns) : ns;
          const mod = unquote(iref);
          if (mod) {
            const f = s.py.moduleFile(mod, file);
            if (f) parseUrls(s, f, { prefix: full, namespace: childNs, decorators: c.decorators }, depth + 1);
          } else if (/^(\w+)\.urls$/.test(iref)) emitRouter(/^(\w+)\.urls$/.exec(iref)![1], full);
          else if (/^\(/.test(iref)) {
            const tuple = splitTopLevel(iref.slice(1, -1));
            const listRef = tuple[0];
            const r = s.py.resolve(listRef, file);
            if (r) parseUrls(s, r.file, { prefix: full, namespace: unquote(tuple[1]) || childNs, decorators: c.decorators }, depth + 1);
          } else {
            const r = s.py.resolve(iref.replace(/\.urlpatterns$/, ''), file);
            const f = r ? (s.py.moduleFile(`${s.py.moduleName(r.file)}.${r.qual}`, file) || r.file) : undefined;
            if (f) parseUrls(s, f, { prefix: full, namespace: childNs, decorators: c.decorators }, depth + 1);
          }
          continue;
        }
        if (/admin\.site\.urls/.test(target)) {
          s.g.addRoute({ method: 'ANY', path: normalizeUrlPath(full + '/{admin}'), name: 'admin', target: 'django.contrib.admin', middleware: ['staff login'], file, line: l.line, framework: 'django', notes: ['Django admin site (all registered models)'] });
          continue;
        }
        // view callable: views.func, func, Class.as_view(...), decorator(views.func)
        let inner = target;
        const wrappers: string[] = [];
        for (let w = /^([\w.]+)\(([\s\S]*)\)$/.exec(inner); w && !/\.as_view$/.test(w[1]); w = /^([\w.]+)\(([\s\S]*)\)$/.exec(inner)) {
          const first = (splitTopLevel(w[2])[0] || '').trim();
          // a view factory (make_view('Title', …)) rather than a decorator: the factory is the view
          if (!/^[\w.]+(\([\s\S]*\))?$/.test(first) || /^\d/.test(first)) {
            inner = w[1];
            break;
          }
          wrappers.push(w[1].split('.').pop()!);
          inner = first;
        }
        const asView = /^([\w.]+)\.as_view\(([\s\S]*)\)$/.exec(inner);
        const ref = asView ? asView[1] : inner;
        const resolved = /^[\w.]+$/.test(ref) ? s.py.resolve(ref, file) : undefined;
        const block = resolved ? s.py.block(resolved.file, resolved.qual) : undefined;
        const extraGuards = [...c.decorators, ...wrappers];
        if (block && resolved && block.kind === 'class') {
          const handlers = classView(s, resolved.file, block, areaOf(resolved.file));
          const tmpl = asView ? unquote(kwargs(splitTopLevel(asView[2])).template_name) : null;
          const methods = Array.from(handlers.keys()).filter((k) => HTTP_METHODS.includes(k));
          for (const meth of methods.length ? methods : ['get']) {
            addRoute(s, meth.toUpperCase(), full, `${ref}.as_view()`, handlers.get(meth), file, l.line, guards(block, extraGuards), fullName, tmpl ? [`template_name='${tmpl}'`] : undefined);
          }
        } else if (block && resolved) {
          const h = pyHandler(s.g, s.py, resolved.file, block, { framework: 'django', models: s.models, resolveTemplate: s.resolveTemplate, area: areaOf(resolved.file) });
          for (const meth of methodsOf(block)) addRoute(s, meth, full, ref, h.id, file, l.line, guards(block, extraGuards), fullName);
        } else {
          addRoute(s, 'GET', full, ref || target, undefined, file, l.line, extraGuards, fullName, ref ? undefined : ['View could not be resolved statically']);
        }
      }
    }
  }
}

function addRoute(s: DjState, method: string, path: string, target: string, handler: string | undefined, file: string, line: number, middleware: string[], name?: string, notes?: string[]): void {
  const r = s.g.addRoute({ method, path: normalizeUrlPath(path), name, target, handler, middleware, file, line, framework: 'django', notes });
  if (handler) s.g.addEdge(r.id, handler, 'routes-to');
  for (const m of middleware) {
    if (!s.g.middleware.has(`middleware:${m}`)) s.g.addMiddleware({ id: `middleware:${m}`, name: m, kind: /Mixin$/.test(m) ? 'route' : 'decorator', framework: 'django', description: DECORATOR_DESC[m] });
    s.g.addEdge(r.id, `middleware:${m}`, 'protected-by');
  }
}

function joinUrl(a: string, b: string): string {
  return (a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '')).replace(/\/+$/, '');
}

const MIDDLEWARE_DESC: Record<string, string> = {
  SecurityMiddleware: 'HTTPS redirects, HSTS and security headers', SessionMiddleware: 'Loads the session from the cookie',
  CommonMiddleware: 'URL normalization (APPEND_SLASH)', CsrfViewMiddleware: 'Rejects POST requests without a valid CSRF token',
  AuthenticationMiddleware: 'Attaches request.user', MessageMiddleware: 'Flash messages (django.contrib.messages)',
  XFrameOptionsMiddleware: 'Clickjacking protection (X-Frame-Options)', CorsMiddleware: 'CORS headers (django-cors-headers)',
  WhiteNoiseMiddleware: 'Serves static files', LocaleMiddleware: 'Selects the language per request',
};
const DECORATOR_DESC: Record<string, string> = {
  login_required: 'Redirects anonymous users to the login page', LoginRequiredMixin: 'Redirects anonymous users to the login page',
  permission_required: 'Requires a model permission', PermissionRequiredMixin: 'Requires a model permission', staff_member_required: 'Only staff users',
  csrf_exempt: 'Disables CSRF protection for this view', require_POST: 'Only POST is allowed', IsAuthenticated: 'DRF: authenticated users only',
  IsAdminUser: 'DRF: staff users only', AllowAny: 'DRF: no authentication required', api_view: 'DRF function-based API view',
};

function hints(g: GraphBuilder, root: string, settingsFile?: string): void {
  const p = (s: string) => (root === '.' ? s : `${root}/${s}`);
  g.hint(p('manage.py'), 'Django management commands (runserver, migrate, …)', ['entry']);
  if (settingsFile) {
    g.hint(settingsFile, 'Settings: INSTALLED_APPS, MIDDLEWARE, DATABASES, ROOT_URLCONF', ['entry']);
    g.hint(dirname(settingsFile), 'Project package: settings, root URLconf, WSGI/ASGI entry points');
  }
  g.hint(p('templates'), 'Project-wide Django templates');
  g.hint(p('static'), 'Static files (collected with collectstatic)');
  g.hint(p('media'), 'User-uploaded files (MEDIA_ROOT)');
}

function lifecycle(g: GraphBuilder, root: string, mw: string[]): void {
  const routes = Array.from(g.routes.values()).filter((r) => r.framework === 'django').length;
  g.lifecycle.push(
    { id: 'dj-server', title: 'WSGI / ASGI server', subtitle: 'gunicorn, uvicorn, runserver', detail: 'The application server calls the Django handler defined in wsgi.py / asgi.py.' },
    { id: 'dj-mw', title: 'Middleware', subtitle: `${mw.length} in settings.MIDDLEWARE`, detail: `Each request passes through: ${mw.map((m) => m.split('.').pop()).join(' → ') || 'no middleware configured'}.` },
    { id: 'dj-urls', title: 'URLconf', subtitle: 'urls.py', detail: `ROOT_URLCONF and its include()s resolve the path to one of ${routes} views; decorators and mixins (login_required, permissions) wrap it.` },
    { id: 'dj-view', title: 'View', subtitle: 'function or class-based', detail: 'The view reads request.GET / request.POST, validates with a Form or Serializer and works with models.' },
    { id: 'dj-orm', title: 'ORM', subtitle: 'Model.objects…', detail: 'QuerySets read and write the database tables defined in each app\'s models.py.' },
    { id: 'dj-template', title: 'Template / serializer', subtitle: 'render() or Response()', detail: 'HTML views render a template with a context dict; API views return JSON through DRF serializers.' },
    { id: 'dj-response', title: 'Response', subtitle: 'back through middleware', detail: 'The HttpResponse travels back through the middleware stack (sessions, security headers) to the client.' },
  );
}

function recipes(g: GraphBuilder, root: string, app?: string): void {
  const a = app || 'myapp';
  g.recipes.push(
    { id: 'dj-page', title: 'Add a new page', summary: 'View → URL → template.', files: [`${a}/views.py`, `${a}/urls.py`], steps: [
      `Write a view in ${a}/views.py: def my_page(request): return render(request, '${a.split('/').pop()}/my_page.html', {'items': items})`,
      `Add path('my-page/', views.my_page, name='my-page') to ${a}/urls.py.`,
      `Create the template under ${a}/templates/ and {% extends %} the base layout.`,
      "Link to it with {% url 'my-page' %}; add @login_required if it needs a logged-in user.",
    ] },
    { id: 'dj-model', title: 'Add a model / table', summary: 'models.py → makemigrations → migrate → admin.', files: [`${a}/models.py`], steps: [
      `Add a class to ${a}/models.py extending models.Model.`,
      'python manage.py makemigrations && python manage.py migrate',
      `Register it in ${a}/admin.py with admin.site.register(MyModel) to manage it in /admin.`,
    ] },
    { id: 'dj-api', title: 'Add an API endpoint (DRF)', summary: 'Serializer + ViewSet + router.', files: [], steps: [
      'Create a ModelSerializer for the model.',
      'Create a ModelViewSet with queryset and serializer_class (and permission_classes).',
      "router.register(r'things', ThingViewSet) and include(router.urls) in urls.py.",
    ] },
  );
}
