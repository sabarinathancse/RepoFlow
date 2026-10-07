/**
 * Mutable accumulator adapters write into. It de-duplicates nodes by id so
 * several adapters (e.g. a Django app inside a CodeIgniter repo) can share it.
 */
import {
  ContainerNode, Edge, EdgeKind, Finding, HandlerNode, IntegrationNode, LifecycleStep, MiddlewareNode,
  ModelNode, Recipe, RouteNode, ScriptNode, TableNode, ViewNode, FrameworkInfo, Dependency,
} from './graph';
import { routeGroup } from '../utils/text';

export interface FolderHint {
  description: string;
  tags?: string[];
}

export class GraphBuilder {
  frameworks: FrameworkInfo[] = [];
  routes = new Map<string, RouteNode>();
  containers = new Map<string, ContainerNode>();
  handlers = new Map<string, HandlerNode>();
  models = new Map<string, ModelNode>();
  tables = new Map<string, TableNode>();
  views = new Map<string, ViewNode>();
  scripts = new Map<string, ScriptNode>();
  middleware = new Map<string, MiddlewareNode>();
  integrations = new Map<string, IntegrationNode>();
  findings: Finding[] = [];
  recipes: Recipe[] = [];
  lifecycle: LifecycleStep[] = [];
  dependencies: Dependency[] = [];
  folderHints = new Map<string, FolderHint>();
  private edgeKeys = new Set<string>();
  edges: Edge[] = [];
  description?: string;

  addRoute(r: Omit<RouteNode, 'id' | 'group'> & { id?: string; group?: string }): RouteNode {
    const base = r.id || `route:${r.method} ${r.path}`;
    let id = base;
    for (let n = 2; this.routes.has(id); n++) {
      const existing = this.routes.get(id)!;
      if (existing.target === r.target && existing.file === r.file) return existing;
      id = `${base} #${n}`;
    }
    const route: RouteNode = { ...r, id, group: r.group || routeGroup(r.path) };
    this.routes.set(id, route);
    return route;
  }

  addHandler(h: Partial<HandlerNode> & Pick<HandlerNode, 'id' | 'name' | 'file' | 'line' | 'framework'>): HandlerNode {
    const existing = this.handlers.get(h.id);
    if (existing) return existing;
    const node: HandlerNode = {
      kind: 'method', endLine: h.line, steps: [], models: [], tables: [], data: [], views: [], routes: [], responses: [], area: '',
      ...h,
    } as HandlerNode;
    this.handlers.set(h.id, node);
    return node;
  }

  addContainer(c: Omit<ContainerNode, 'handlers'> & { handlers?: string[] }): ContainerNode {
    const existing = this.containers.get(c.id);
    if (existing) return existing;
    const node: ContainerNode = { handlers: [], ...c };
    this.containers.set(c.id, node);
    return node;
  }

  addModel(m: Omit<ModelNode, 'usedBy'> & { usedBy?: string[] }): ModelNode {
    const existing = this.models.get(m.id);
    if (existing) return existing;
    const node: ModelNode = { usedBy: [], ...m };
    this.models.set(m.id, node);
    if (node.table) {
      const t = this.ensureTable(node.table);
      if (!t.models.includes(node.id)) t.models.push(node.id);
      if (!t.columns.length && node.fields.length) t.columns = node.fields.map((f) => ({ ...f }));
      t.sources.push({ file: node.file, line: node.line, kind: 'model' });
    }
    return node;
  }

  ensureTable(name: string): TableNode {
    const id = `table:${name}`;
    let t = this.tables.get(id);
    if (!t) {
      t = { id, name, columns: [], sources: [], models: [], foreignKeys: [], readBy: [], writtenBy: [] };
      this.tables.set(id, t);
    }
    return t;
  }

  addView(v: Omit<ViewNode, 'renderedBy' | 'isLayout'> & { renderedBy?: string[]; isLayout?: boolean }): ViewNode {
    const existing = this.views.get(v.id);
    if (existing) return existing;
    const node: ViewNode = { renderedBy: [], isLayout: false, ...v };
    this.views.set(v.id, node);
    return node;
  }

  addMiddleware(m: MiddlewareNode): MiddlewareNode {
    const existing = this.middleware.get(m.id);
    if (existing) {
      if (!existing.description && m.description) existing.description = m.description;
      if (!existing.file && m.file) {
        existing.file = m.file;
        existing.line = m.line;
      }
      return existing;
    }
    this.middleware.set(m.id, m);
    return m;
  }

  addFinding(f: Omit<Finding, 'id'>): void {
    const key = `${f.rule}|${f.file || ''}|${f.line || ''}|${f.title}`;
    if (this.findings.some((x) => `${x.rule}|${x.file || ''}|${x.line || ''}|${x.title}` === key)) return;
    this.findings.push({ ...f, id: `finding:${this.findings.length + 1}` });
  }

  addEdge(from: string, to: string, kind: EdgeKind): void {
    if (!from || !to || from === to) return;
    const key = `${from}\u0001${to}\u0001${kind}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ from, to, kind });
  }

  hint(path: string, description: string, tags?: string[]): void {
    if (!this.folderHints.has(path)) this.folderHints.set(path, { description, tags });
  }
}
