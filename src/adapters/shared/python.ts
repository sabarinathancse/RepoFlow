/** Python helpers shared by the Django, FastAPI and Flask adapters. */
import { ScanContext } from '../../core/context';
import { GraphBuilder } from '../../schema/builder';
import { FieldInfo, HandlerNode, ModelNode, RelationInfo } from '../../schema/graph';
import { moduleCandidates, parsePython, PyBlock, PyFile } from '../../parsers/python';
import { splitTopLevel, unquote } from '../../parsers/common';
import { analyzeBody } from '../../analyzers/steps';
import { LineIndex, uniq } from '../../utils/text';

export class PyProject {
  private cache = new Map<string, PyFile | null>();
  constructor(readonly ctx: ScanContext, readonly roots: string[]) {}

  parse(file: string): PyFile | null {
    if (this.cache.has(file)) return this.cache.get(file)!;
    const src = this.ctx.read(file);
    const parsed = src === null ? null : parsePython(src);
    this.cache.set(file, parsed);
    return parsed;
  }

  /** File path of a dotted module, resolved from `fromFile`. */
  moduleFile(module: string, fromFile: string): string | undefined {
    return moduleCandidates(module, fromFile, this.roots).find((c) => this.ctx.has(c));
  }

  /** Resolves a name used in `file` (e.g. "views.index", "ItemViewSet") to the file + qualified name that defines it. */
  resolve(expr: string, file: string): { file: string; qual: string } | undefined {
    const py = this.parse(file);
    if (!py) return undefined;
    const parts = expr.split('.');
    const head = parts[0];
    if (py.blocks.some((b) => b.name === head)) return { file, qual: parts.join('.') };
    const imp = py.imports.get(head);
    if (!imp) return undefined;
    if (imp.name) {
      // from X import head  → head is a module or a symbol of module X
      const asModule = this.moduleFile(imp.module === '.' || /^\.+$/.test(imp.module) ? imp.module + imp.name : `${imp.module}.${imp.name}`, file);
      if (asModule && parts.length > 1) return { file: asModule, qual: parts.slice(1).join('.') };
      const mod = this.moduleFile(imp.module, file);
      if (mod) return { file: mod, qual: [imp.name, ...parts.slice(1)].join('.') };
      return undefined;
    }
    // import a.b.c as head
    const mod = this.moduleFile(imp.module, file);
    if (mod && parts.length > 1) return { file: mod, qual: parts.slice(1).join('.') };
    return undefined;
  }

  block(file: string, qual: string): PyBlock | undefined {
    const py = this.parse(file);
    if (!py) return undefined;
    const [first, ...rest] = qual.split('.');
    let b = py.blocks.find((x) => x.name === first);
    for (const r of rest) b = b?.children.find((x) => x.name === r);
    if (!b && rest.length === 0) {
      // re-exported symbol: "from .views import *" / "from .x import name"
      const imp = py.imports.get(first);
      if (imp?.name) {
        const mod = this.moduleFile(imp.module, file);
        if (mod && mod !== file) return this.block(mod, imp.name);
      }
    }
    return b;
  }

  moduleName(file: string): string {
    let rel = file;
    for (const r of this.roots) if (r !== '.' && file.startsWith(r + '/')) rel = file.slice(r.length + 1);
    return rel.replace(/\/__init__\.py$/, '').replace(/\.py$/, '').replace(/\//g, '.');
  }
}

export interface PyHandlerOptions {
  framework: string;
  models: Map<string, ModelNode>;
  resolveTemplate(name: string): string | undefined;
  area: string;
  container?: string;
  id?: string;
  name?: string;
}

/** Creates (or returns) the handler for a Python function / method block. */
export function pyHandler(g: GraphBuilder, py: PyProject, file: string, block: PyBlock, opts: PyHandlerOptions): HandlerNode {
  const id = opts.id || `py:${py.moduleName(file)}.${qualOf(block)}`;
  const existing = g.handlers.get(id);
  if (existing) return existing;
  const siblings = new Set((block.parent ? block.parent.children : py.parse(file)?.blocks || []).map((b) => b.name));
  const res = analyzeBody(block.body, () => 0, {
    lang: 'python',
    resolveModel: (e) => (opts.models.has(e) ? e : undefined),
    modelTable: (n) => opts.models.get(n)?.table,
    siblings,
  });
  const h = g.addHandler({
    id, name: opts.name || block.name, container: opts.container, kind: block.parent?.kind === 'class' ? 'method' : 'function', file,
    line: block.line, endLine: block.endLine, params: block.args, decorators: block.decorators.map((d) => d.text), framework: opts.framework, area: opts.area,
  });
  Object.assign(h, {
    steps: res.steps,
    models: uniq(res.models.map((n) => opts.models.get(n)!.id)),
    tables: res.tables,
    data: res.data.map((d) => ({ ...d, model: d.model ? opts.models.get(d.model)?.id : undefined })),
    responses: res.responses,
  });
  for (const v of res.views) {
    const vid = opts.resolveTemplate(v.name);
    h.views.push({ view: vid || v.name, vars: v.vars, line: v.line });
    if (vid) g.addEdge(id, vid, 'renders');
  }
  if (opts.container) {
    const c = g.containers.get(opts.container);
    if (c && !c.handlers.includes(id)) c.handlers.push(id);
    g.addEdge(opts.container, id, 'contains');
  }
  return h;
}

export function qualOf(b: PyBlock): string {
  const names: string[] = [];
  for (let x: PyBlock | undefined = b; x; x = x.parent) names.unshift(x.name);
  return names.join('.');
}

/** SQLAlchemy / SQLModel / Flask-SQLAlchemy declarative models. */
export function sqlAlchemyModels(ctx: ScanContext, g: GraphBuilder, py: PyProject, files: string[], framework: string): Map<string, ModelNode> {
  const out = new Map<string, ModelNode>();
  const pending: Array<{ file: string; b: PyBlock }> = [];
  for (const f of files) {
    const p = py.parse(f);
    if (!p) continue;
    for (const b of p.blocks) if (b.kind === 'class') pending.push({ file: f, b });
  }
  const isModel = (b: PyBlock, known: Set<string>) =>
    /\b(Base|db\.Model|DeclarativeBase|Model)\b/.test(b.args) && !/BaseModel|Schema/.test(b.args) || /SQLModel\s*,\s*table\s*=\s*True/.test(b.args) ||
    b.args.split(',').some((x) => known.has(x.trim())) || b.body.some((l) => l.indent > b.indent && /^__tablename__\s*=/.test(l.text));
  const known = new Set<string>();
  for (let pass = 0; pass < 2; pass++) {
    for (const { file, b } of pending) {
      if (known.has(b.name) || !isModel(b, known)) continue;
      if (!b.body.some((l) => /=\s*(?:db\.)?(?:Column|mapped_column|relationship|Field)\(|:\s*Mapped\[/.test(l.text) || /^__tablename__/.test(l.text))) continue;
      known.add(b.name);
      const fields: FieldInfo[] = [];
      const relations: RelationInfo[] = [];
      let table: string | undefined;
      for (const l of b.body) {
        if (l.indent <= b.indent || (b.children.length && b.children.some((c) => l.line >= c.line && l.line <= c.endLine))) continue;
        const tn = /^__tablename__\s*=\s*(['"])(\w+)\1/.exec(l.text);
        if (tn) table = tn[2];
        const col = /^(\w+)\s*(?::\s*([^=]+))?=\s*(?:db\.|sa\.|sqlalchemy\.)?(Column|mapped_column|Field)\(([\s\S]*)\)\s*$/.exec(l.text);
        if (col) {
          const args = splitTopLevel(col[4]);
          const typ = /Mapped\[\s*(?:Optional\[)?\s*([\w.]+)/.exec(col[2] || '')?.[1] || (args[0] && !/=/.test(args[0]) ? args[0].replace(/^(db|sa|sqlalchemy)\./, '').replace(/\(.*$/, '') : col[2]?.trim());
          const fk = /ForeignKey\(\s*['"]([\w.]+)['"]/.exec(col[4]);
          fields.push({ name: col[1], type: typ, primary: /primary_key\s*=\s*True/.test(col[4]) || undefined, nullable: /nullable\s*=\s*False/.test(col[4]) ? false : undefined, references: fk?.[1] });
          continue;
        }
        const ann = /^(\w+)\s*:\s*Mapped\[\s*(?:Optional\[)?\s*([\w.'"]+)/.exec(l.text);
        if (ann && !/relationship\(/.test(l.text)) fields.push({ name: ann[1], type: ann[2].replace(/['"]/g, '') });
        const rel = /^(\w+)\s*(?::[^=]+)?=\s*(?:db\.)?relationship\(\s*['"]?(\w+)/.exec(l.text);
        if (rel) relations.push({ kind: 'relationship', target: rel[2], via: rel[1] });
      }
      const node = g.addModel({ id: `model:${py.moduleName(file)}.${b.name}`, name: b.name, kind: 'orm', file, line: b.line, table: table || snakeCase(b.name), fields, relations, framework });
      out.set(b.name, node);
      if (table) {
        const t = g.ensureTable(table);
        for (const f of fields) if (f.references && !t.foreignKeys.some((x) => x.column === f.name)) t.foreignKeys.push({ column: f.name, references: f.references, inferred: false });
      }
    }
  }
  return out;
}

/** Pydantic schemas (request/response bodies), listed as models of kind "schema". */
export function pydanticSchemas(g: GraphBuilder, py: PyProject, files: string[], framework: string): void {
  for (const f of files) {
    const p = py.parse(f);
    if (!p) continue;
    for (const b of p.blocks) {
      if (b.kind !== 'class' || !/\bBaseModel\b|\bSchema\b/.test(b.args) || g.models.has(`model:${py.moduleName(f)}.${b.name}`)) continue;
      const fields = b.body.filter((l) => l.indent > b.indent && /^\w+\s*:/.test(l.text)).map((l) => {
        const m = /^(\w+)\s*:\s*([^=]+)/.exec(l.text)!;
        return { name: m[1], type: m[2].trim() };
      }).filter((x) => x.name !== 'model_config' && x.name !== 'Config');
      g.addModel({ id: `model:${py.moduleName(f)}.${b.name}`, name: b.name, kind: 'schema', file: f, line: b.line, fields, relations: [], framework });
    }
  }
}

function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const TEMPLATE_IGNORE = new Set(['forloop', 'request', 'user', 'csrf_token', 'perms', 'messages', 'block', 'loop', 'self', 'super', 'url_for', 'get_flashed_messages',
  'config', 'session', 'g', 'range', 'true', 'false', 'none', 'True', 'False', 'None', 'not', 'and', 'or', 'in', 'is', 'if', 'else', 'static', 'form', 'view', 'debug', 'STATIC_URL', 'MEDIA_URL', 'LANGUAGE_CODE']);

/** Django / Jinja2 template structure. */
export function djangoLikeTemplate(src: string): { extends: string[]; includes: string[]; sections: string[]; vars: string[]; isLayout: boolean } {
  const grab = (re: RegExp) => uniq(Array.from(src.matchAll(re)).map((m) => m[1]));
  const loopVars = new Set<string>();
  for (const m of src.matchAll(/\{%-?\s*for\s+([\w\s,]+?)\s+in\b/g)) m[1].split(',').forEach((v) => loopVars.add(v.trim()));
  for (const m of src.matchAll(/\{%-?\s*(?:with|set)\s+(\w+)\s*=/g)) loopVars.add(m[1]);
  for (const m of src.matchAll(/\{%-?\s*with\s+[^%]*?\bas\s+(\w+)/g)) loopVars.add(m[1]);
  for (const m of src.matchAll(/\{%-?\s*macro\s+\w+\(([^)]*)\)/g)) m[1].split(',').forEach((v) => loopVars.add(v.trim().split('=')[0]));
  const vars: string[] = [];
  const consider = (expr: string) => {
    for (const m of expr.matchAll(/(?:^|[^\w.'"|])([a-zA-Z_]\w*)/g)) {
      const v = m[1];
      if (TEMPLATE_IGNORE.has(v) || loopVars.has(v) || vars.includes(v)) continue;
      vars.push(v);
    }
  };
  for (const m of src.matchAll(/\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g)) consider(m[1].split('(')[0]);
  for (const m of src.matchAll(/\{%-?\s*(?:if|elif|for\s+[\w\s,]+?\s+in)\s+([^%]+?)\s*-?%\}/g)) consider(m[1].replace(/\|[\w:"' ]+/g, ''));
  return {
    extends: grab(/\{%-?\s*extends\s+['"]([^'"]+)['"]/g),
    includes: uniq([...grab(/\{%-?\s*include\s+['"]([^'"]+)['"]/g), ...grab(/\{%-?\s*(?:import|from)\s+['"]([^'"]+)['"]/g)]),
    sections: grab(/\{%-?\s*block\s+(\w+)/g),
    vars: vars.slice(0, 60),
    isLayout: /\{%-?\s*block\s+\w+\s*-?%\}\s*\{%-?\s*endblock/.test(src) || (/\{%-?\s*block\b/.test(src) && !/\{%-?\s*extends\b/.test(src)),
  };
}

/** Adds every template under the given template directories; returns name → view id. */
export function addTemplates(ctx: ScanContext, g: GraphBuilder, dirs: string[], engine: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const dir of uniq(dirs)) {
    for (const f of ctx.under(dir)) {
      if (!/\.(html|htm|jinja2?|j2|txt|xml)$/.test(f.path)) continue;
      const src = ctx.read(f.path);
      if (src === null) continue;
      const name = f.path.slice(dir.length + 1);
      const t = djangoLikeTemplate(src);
      const id = `view:${f.path}`;
      g.addView({ id, name, file: f.path, engine, lines: new LineIndex(src).count, ...t, forms: [], links: [], scripts: [], calls: [] });
      if (!byName.has(name)) byName.set(name, id);
    }
  }
  for (const id of byName.values()) {
    const v = g.views.get(id)!;
    v.extends = v.extends.map((e) => byName.get(e) || e);
    v.includes = v.includes.map((e) => byName.get(e) || e);
    for (const e of v.extends) if (e.startsWith('view:')) g.addEdge(id, e, 'extends');
    for (const e of v.includes) if (e.startsWith('view:')) g.addEdge(id, e, 'includes');
  }
  return byName;
}

export function pyString(expr: string | undefined): string | null {
  return unquote(expr);
}
