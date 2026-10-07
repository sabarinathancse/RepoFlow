/**
 * The normalized RepoFlow project graph.
 *
 * Every framework adapter writes into this shape and the HTML renderer reads
 * only this shape, so the renderer never needs to know which framework or
 * language produced it. Bump SCHEMA_VERSION on breaking changes.
 */

export const SCHEMA_VERSION = '1.0';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SourceRef {
  file: string;
  line?: number;
}

export interface FrameworkInfo {
  /** adapter id, e.g. "codeigniter4", "laravel", "django" */
  id: string;
  name: string;
  language: string;
  version?: string;
  /** project-relative directory the framework app lives in ("." for the scan root) */
  root: string;
  /** 0..1 */
  confidence: number;
  evidence: string[];
}

export interface LanguageStat {
  name: string;
  files: number;
  lines: number;
  bytes: number;
}

export interface FolderNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  description?: string;
  tags?: string[];
  /** total files beneath a directory */
  files?: number;
  children?: FolderNode[];
  /** number of children omitted to keep the tree readable */
  truncated?: number;
}

export interface LifecycleStep {
  id: string;
  title: string;
  subtitle?: string;
  detail: string;
  files?: string[];
}

export interface RouteNode {
  id: string;
  method: string;
  path: string;
  name?: string;
  /** handler id, when the target resolved to analyzed code */
  handler?: string;
  /** the target exactly as written, e.g. "Admin\\Blog::index" or "views.home" */
  target: string;
  middleware: string[];
  file: string;
  line: number;
  framework: string;
  /** first path segment, used for grouping in the UI */
  group: string;
  notes?: string[];
}

export type StepKind =
  | 'input' | 'validate' | 'auth' | 'session' | 'model' | 'db' | 'view' | 'redirect' | 'response'
  | 'external' | 'file' | 'log' | 'cache' | 'queue' | 'error' | 'branch' | 'call' | 'mail' | 'event';

export interface Step {
  kind: StepKind;
  line: number;
  text: string;
  code?: string;
}

export type DataOp = 'read' | 'write' | 'delete' | 'access';

export interface DataAccess {
  model?: string;
  table?: string;
  op: DataOp;
  line: number;
}

export interface ViewRef {
  /** view id when resolved, otherwise the raw name */
  view: string;
  vars: string[];
  line: number;
}

export interface HandlerNode {
  id: string;
  name: string;
  container?: string;
  kind: 'method' | 'function' | 'closure' | 'class' | 'script';
  file: string;
  line: number;
  endLine: number;
  params?: string;
  visibility?: string;
  decorators?: string[];
  steps: Step[];
  /** model ids */
  models: string[];
  /** table names */
  tables: string[];
  data: DataAccess[];
  views: ViewRef[];
  /** route ids that reach this handler */
  routes: string[];
  /** coarse response kinds: html, json, redirect, file, text */
  responses: string[];
  framework: string;
  area: string;
}

export interface ContainerNode {
  id: string;
  name: string;
  kind: 'controller' | 'module' | 'viewset' | 'router' | 'script';
  file: string;
  line: number;
  area: string;
  extends?: string;
  handlers: string[];
  framework: string;
}

export interface FieldInfo {
  name: string;
  type?: string;
  nullable?: boolean;
  primary?: boolean;
  /** "table.column" or model name */
  references?: string;
}

export interface RelationInfo {
  kind: string;
  /** model id or table id */
  target: string;
  via?: string;
  inferred?: boolean;
}

export interface ModelNode {
  id: string;
  name: string;
  kind: 'orm' | 'schema' | 'document';
  file: string;
  line: number;
  table?: string;
  fields: FieldInfo[];
  relations: RelationInfo[];
  framework: string;
  usedBy: string[];
}

export interface ForeignKey {
  column: string;
  references: string;
  inferred: boolean;
}

export interface TableNode {
  id: string;
  name: string;
  columns: FieldInfo[];
  sources: Array<SourceRef & { kind: string }>;
  models: string[];
  foreignKeys: ForeignKey[];
  readBy: string[];
  writtenBy: string[];
}

export interface FormInfo {
  action: string;
  method: string;
  line: number;
  multipart?: boolean;
  /** route id the form submits to, when resolved */
  route?: string;
}

export interface LinkInfo {
  url: string;
  line: number;
  route?: string;
}

export interface ClientCall {
  kind: 'fetch' | 'axios' | 'jquery' | 'xhr' | 'form' | 'websocket' | 'other';
  method: string;
  url: string;
  file: string;
  line: number;
  context?: string;
  route?: string;
}

export interface ViewNode {
  id: string;
  name: string;
  file: string;
  engine: string;
  lines: number;
  extends: string[];
  includes: string[];
  sections: string[];
  vars: string[];
  forms: FormInfo[];
  links: LinkInfo[];
  scripts: string[];
  calls: ClientCall[];
  renderedBy: string[];
  isLayout: boolean;
}

export interface ScriptNode {
  id: string;
  file: string;
  lines: number;
  functions: string[];
  events: string[];
  calls: ClientCall[];
  usedBy: string[];
}

export interface MiddlewareNode {
  id: string;
  name: string;
  kind: 'global' | 'alias' | 'route' | 'group' | 'decorator' | 'dependency';
  file?: string;
  line?: number;
  description?: string;
  framework: string;
}

export interface IntegrationNode {
  id: string;
  name: string;
  category: string;
  evidence: Array<SourceRef & { text: string }>;
}

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  rule: string;
  file?: string;
  line?: number;
  evidence?: SourceRef[];
}

export interface Recipe {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  files: string[];
}

export type EdgeKind =
  | 'routes-to' | 'renders' | 'uses-model' | 'maps-to-table' | 'reads' | 'writes' | 'extends' | 'includes'
  | 'submits-to' | 'links-to' | 'calls' | 'relates-to' | 'protected-by' | 'loads-script' | 'contains';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Dependency {
  name: string;
  version: string;
  ecosystem: 'composer' | 'npm' | 'pip';
  dev: boolean;
  manifest: string;
}

export interface ProjectGraph {
  schemaVersion: string;
  generator: { name: string; version: string };
  project: {
    name: string;
    description?: string;
    scannedAt: string;
    git?: { commit?: string; branch?: string };
  };
  frameworks: FrameworkInfo[];
  languages: LanguageStat[];
  dependencies: Dependency[];
  stats: Record<string, number>;
  folders: FolderNode;
  lifecycle: LifecycleStep[];
  routes: RouteNode[];
  containers: ContainerNode[];
  handlers: HandlerNode[];
  models: ModelNode[];
  tables: TableNode[];
  views: ViewNode[];
  scripts: ScriptNode[];
  middleware: MiddlewareNode[];
  integrations: IntegrationNode[];
  findings: Finding[];
  recipes: Recipe[];
  edges: Edge[];
  warnings: string[];
}
