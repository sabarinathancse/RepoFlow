/**
 * The scan pipeline:
 * project files → framework detection → adapters → shared analyzers → normalized graph.
 */
import { basename, resolve, relative, sep } from 'node:path';
import { ScanContext } from './context';
import { walk } from './walker';
import { gitInfo } from './git';
import { ADAPTERS } from '../adapters';
import { detectFrameworks } from '../detectors';
import { GraphBuilder } from '../schema/builder';
import { ProjectGraph, SCHEMA_VERSION } from '../schema/graph';
import { analyzeFrontend } from '../analyzers/frontend';
import { resolveLinks } from '../analyzers/links';
import { analyzeSqlFiles, linkData } from '../analyzers/data';
import { analyzeIntegrations } from '../analyzers/integrations';
import { analyzeFindings } from '../analyzers/findings';
import { buildFolderTree, languageStats } from '../analyzers/structure';
import { collectDependencies } from '../adapters/shared/manifest';
import { sortBy, toPosix } from '../utils/text';
import { VERSION } from '../version';

export interface ScanOptions {
  root: string;
  /** absolute output directory; excluded from the scan when inside root */
  outDir: string;
  useGitignore?: boolean;
  maxFiles?: number;
  /** restrict to these adapter ids */
  frameworks?: string[];
  onProgress?: (msg: string) => void;
}

export interface ScanResult {
  graph: ProjectGraph;
  manifest: {
    filesListed: number;
    filesParsed: number;
    skippedDirs: string[];
    truncated: boolean;
    durationMs: number;
    adapters: Array<{ id: string; root: string; confidence: number }>;
    excluded: string[];
  };
}

export function scanProject(opts: ScanOptions): ScanResult {
  const started = Date.now();
  const root = resolve(opts.root);
  const progress = opts.onProgress || (() => undefined);
  const exclude = ['repoflow'];
  const outRel = toPosix(relative(root, resolve(opts.outDir)));
  if (outRel && !outRel.startsWith('..') && !outRel.startsWith('/') && !outRel.includes(':' + sep)) exclude.push(outRel);

  progress('Listing files…');
  const walked = walk(root, { exclude, useGitignore: opts.useGitignore !== false, maxFiles: opts.maxFiles || 25000 });
  const ctx = new ScanContext(root, walked.files);
  if (walked.truncated) ctx.warn(`File limit reached: only the first ${walked.files.length} files were scanned (use --max-files to raise it).`);

  const g = new GraphBuilder();
  g.dependencies = collectDependencies(ctx);

  progress('Detecting frameworks…');
  const selected = detectFrameworks(ctx, ADAPTERS, opts.frameworks);
  for (const { adapter, detection } of selected) {
    progress(`Analyzing ${detection.name}${detection.root !== '.' ? ` in ${detection.root}/` : ''}…`);
    g.frameworks.push(detection);
    try {
      adapter.analyze(ctx, detection, g);
    } catch (e) {
      ctx.warn(`Adapter ${adapter.id} (${detection.root}) failed: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
  }

  progress('Analyzing templates, scripts, data and integrations…');
  const serverFiles = new Set(Array.from(g.handlers.values()).map((h) => h.file));
  for (const r of g.routes.values()) serverFiles.add(r.file);
  analyzeFrontend(ctx, g, serverFiles);
  resolveLinks(g);
  analyzeSqlFiles(ctx, g);
  linkData(g);
  analyzeIntegrations(ctx, g);
  analyzeFindings(ctx, g);

  // route ↔ handler back-references
  for (const r of g.routes.values()) {
    const h = r.handler ? g.handlers.get(r.handler) : undefined;
    if (r.handler && !h) r.handler = undefined;
    if (h && !h.routes.includes(r.id)) h.routes.push(r.id);
  }
  for (const h of g.handlers.values()) {
    for (const v of h.views) {
      const view = g.views.get(v.view);
      if (view && !view.renderedBy.includes(h.id)) view.renderedBy.push(h.id);
    }
  }

  progress('Building folder tree…');
  const name = projectName(ctx, root, selected.find((x) => x.detection.root === '.')?.detection.language || selected[0]?.detection.language);
  const folders = buildFolderTree(ctx, g, walked.skippedDirs, name);
  const languages = languageStats(ctx);

  const sev = (s: string) => g.findings.filter((f) => f.severity === s).length;
  const graph: ProjectGraph = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'repoflow', version: VERSION },
    project: { name, description: g.description || projectDescription(ctx), scannedAt: new Date().toISOString(), git: gitInfo(root) },
    frameworks: g.frameworks,
    languages,
    dependencies: sortBy(g.dependencies, (d) => `${d.ecosystem}:${d.dev ? 1 : 0}:${d.name}`),
    stats: {
      files: walked.files.length,
      lines: languages.reduce((a, l) => a + l.lines, 0),
      routes: g.routes.size,
      handlers: g.handlers.size,
      containers: g.containers.size,
      models: g.models.size,
      tables: g.tables.size,
      views: g.views.size,
      scripts: g.scripts.size,
      middleware: g.middleware.size,
      integrations: g.integrations.size,
      dependencies: g.dependencies.length,
      findings: g.findings.length,
      critical: sev('critical'),
      high: sev('high'),
      medium: sev('medium'),
      low: sev('low'),
      info: sev('info'),
    },
    folders,
    lifecycle: g.lifecycle,
    routes: Array.from(g.routes.values()).sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))),
    containers: sortBy(Array.from(g.containers.values()), (c) => `${c.area}/${c.name}`),
    handlers: sortBy(Array.from(g.handlers.values()), (h) => `${h.file}:${String(h.line).padStart(6, '0')}`),
    models: sortBy(Array.from(g.models.values()), (m) => m.name),
    tables: sortBy(Array.from(g.tables.values()), (t) => t.name),
    views: sortBy(Array.from(g.views.values()), (v) => v.file),
    scripts: sortBy(Array.from(g.scripts.values()), (s) => s.file),
    middleware: sortBy(Array.from(g.middleware.values()), (m) => `${m.kind}:${m.name}`),
    integrations: sortBy(Array.from(g.integrations.values()), (i) => `${i.category}:${i.name}`),
    findings: g.findings
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (a.file || '').localeCompare(b.file || ''))
      .map((f, i) => ({ ...f, id: `finding:${i + 1}` })),
    recipes: g.recipes,
    edges: g.edges,
    warnings: ctx.warnings,
  };
  return {
    graph,
    manifest: {
      filesListed: walked.files.length,
      filesParsed: ctx.parsedFiles.size,
      skippedDirs: walked.skippedDirs,
      truncated: walked.truncated,
      durationMs: Date.now() - started,
      adapters: selected.map((s) => ({ id: s.adapter.id, root: s.detection.root, confidence: s.detection.confidence })),
      excluded: exclude,
    },
  };
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/** Name from the manifest of the main framework's language; a stray package.json in a PHP app must not win. */
function projectName(ctx: ScanContext, root: string, language?: string): string {
  const composer = ctx.readJson('composer.json');
  const fromComposer = composer?.name && !/^codeigniter4\/appstarter$|^laravel\/laravel$/.test(composer.name) ? String(composer.name) : undefined;
  const py = ctx.read('pyproject.toml');
  const fromPy = py ? /^\s*name\s*=\s*["']([^"']+)["']/m.exec(py)?.[1] : undefined;
  const pkg = ctx.readJson('package.json');
  const fromPkg = pkg?.name ? String(pkg.name) : undefined;
  const order = language === 'PHP' ? [fromComposer] : language === 'Python' ? [fromPy] : language === 'JavaScript' ? [fromPkg] : [fromComposer, fromPy, fromPkg];
  return order.find(Boolean) || basename(root);
}

function projectDescription(ctx: ScanContext): string | undefined {
  const pkg = ctx.readJson('package.json');
  if (pkg?.description) return String(pkg.description);
  const composer = ctx.readJson('composer.json');
  if (composer?.description && !/starter app|The skeleton application/i.test(composer.description)) return String(composer.description);
  const readme = ctx.read('README.md') || ctx.read('readme.md');
  if (readme) {
    const para = readme.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('!') && !p.startsWith('[') && !p.startsWith('<') && p.length > 30);
    if (para) return para.replace(/\s+/g, ' ').slice(0, 280);
  }
  return undefined;
}
