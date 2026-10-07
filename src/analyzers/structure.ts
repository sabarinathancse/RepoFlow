/** Folder tree with descriptions, and per-language size statistics. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { FolderNode, LanguageStat } from '../schema/graph';

const DIR_HINTS: Record<string, string> = {
  src: 'Source code', lib: 'Library code', app: 'Application code', config: 'Configuration', configs: 'Configuration',
  public: 'Web root / static files served as-is', static: 'Static assets (CSS, JS, images)', assets: 'Front-end assets',
  templates: 'Server-side templates', views: 'View templates', components: 'UI components', routes: 'Route definitions',
  controllers: 'Request handlers', models: 'Data models', middleware: 'Request middleware', middlewares: 'Request middleware',
  services: 'Business logic services', utils: 'Utility helpers', helpers: 'Helper functions', tests: 'Automated tests',
  test: 'Automated tests', __tests__: 'Automated tests', spec: 'Automated tests', docs: 'Documentation', doc: 'Documentation',
  scripts: 'Developer / ops scripts', bin: 'Executables', migrations: 'Database schema migrations', seeders: 'Seed data',
  fixtures: 'Test fixtures', locale: 'Translations', locales: 'Translations', lang: 'Translations', i18n: 'Translations',
  '.github': 'GitHub configuration (CI workflows, templates)', docker: 'Container configuration', deploy: 'Deployment configuration',
  api: 'API endpoints', schemas: 'Validation / serialization schemas', serializers: 'API serializers', jobs: 'Background jobs',
  tasks: 'Background tasks', commands: 'CLI commands', storage: 'Runtime storage (logs, cache, uploads)', uploads: 'User uploads',
  images: 'Images', img: 'Images', css: 'Stylesheets', js: 'Browser JavaScript', fonts: 'Web fonts', database: 'Database files',
  node_modules: 'npm dependencies (not scanned)', vendor: 'Composer dependencies (not scanned)', venv: 'Python virtualenv (not scanned)',
  '.venv': 'Python virtualenv (not scanned)', dist: 'Build output (not scanned)', build: 'Build output (not scanned)',
};

const FILE_HINTS: Record<string, [string, string[]?]> = {
  'README.md': ['Project readme'], 'package.json': ['npm manifest: dependencies and scripts'], 'composer.json': ['Composer manifest: PHP dependencies'],
  'requirements.txt': ['Python dependencies'], 'pyproject.toml': ['Python project configuration'], Pipfile: ['Python dependencies (pipenv)'],
  Dockerfile: ['Container image definition'], 'docker-compose.yml': ['Local multi-container setup'], 'docker-compose.yaml': ['Local multi-container setup'],
  '.env': ['Environment configuration: may contain secrets', ['secret']], '.env.example': ['Template for environment variables'],
  'manage.py': ['Django management entry point', ['entry']], artisan: ['Laravel CLI', ['entry']], spark: ['CodeIgniter CLI'],
  Makefile: ['Build / task shortcuts'], '.htaccess': ['Apache rewrite / access rules'], 'index.php': ['PHP entry point', ['entry']],
  'phpunit.xml': ['PHPUnit configuration'], 'phpunit.xml.dist': ['PHPUnit configuration'], 'tsconfig.json': ['TypeScript configuration'],
  'vite.config.js': ['Vite build configuration'], 'webpack.config.js': ['Webpack build configuration'], '.gitignore': ['Files git does not track'],
};

const MAX_CHILDREN = 80;

export function buildFolderTree(ctx: ScanContext, g: GraphBuilder, skippedDirs: string[], name: string): FolderNode {
  const root: FolderNode = { name, path: '.', type: 'dir', children: [], files: 0 };
  const dirs = new Map<string, FolderNode>([['', root]]);
  const ensureDir = (path: string): FolderNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensureDir(parentPath);
    const node: FolderNode = { name: path.slice(path.lastIndexOf('/') + 1), path, type: 'dir', children: [], files: 0 };
    parent.children!.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const f of ctx.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const node = ensureDir(dir);
    node.children!.push({ name: f.path.slice(f.path.lastIndexOf('/') + 1), path: f.path, type: 'file' });
    for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      dirs.get(d)!.files! += 1;
      if (d === '') break;
    }
  }
  for (const s of skippedDirs) {
    const parentPath = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : '';
    if (!dirs.has(parentPath) && parentPath) continue;
    const parent = dirs.get(parentPath) || root;
    parent.children!.push({ name: s.slice(s.lastIndexOf('/') + 1), path: s, type: 'dir', tags: ['not scanned'], files: 0 });
  }
  const describe = (n: FolderNode) => {
    const hint = g.folderHints.get(n.path);
    if (hint) {
      n.description = hint.description;
      if (hint.tags) n.tags = [...(n.tags || []), ...hint.tags];
    } else if (n.type === 'dir' && DIR_HINTS[n.name]) n.description = DIR_HINTS[n.name];
    else if (n.type === 'file' && FILE_HINTS[n.name]) {
      n.description = FILE_HINTS[n.name][0];
      if (FILE_HINTS[n.name][1]) n.tags = [...(n.tags || []), ...FILE_HINTS[n.name][1]!];
    }
    if (n.type === 'file' && /(^|\/)\.env(\.|$)/.test(n.path) && !/example|sample|dist/.test(n.path)) n.tags = Array.from(new Set([...(n.tags || []), 'secret']));
    if (n.children) {
      n.children.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
      if (n.children.length > MAX_CHILDREN) {
        const keep = n.children.filter((c) => c.type === 'dir' || g.folderHints.has(c.path) || FILE_HINTS[c.name]);
        const rest = n.children.filter((c) => !keep.includes(c));
        const room = Math.max(0, MAX_CHILDREN - keep.length);
        n.truncated = Math.max(0, rest.length - room);
        n.children = [...keep, ...rest.slice(0, room)];
      }
      n.children.forEach(describe);
    }
  };
  describe(root);
  return root;
}

export function languageStats(ctx: ScanContext): LanguageStat[] {
  const stats = new Map<string, LanguageStat>();
  for (const f of ctx.files) {
    if (!f.language || /\.min\.(js|css)$|lock\.json$/.test(f.path)) continue;
    let s = stats.get(f.language);
    if (!s) stats.set(f.language, (s = { name: f.language, files: 0, lines: 0, bytes: 0 }));
    s.files++;
    s.bytes += f.size;
    if (f.size < 2_000_000) {
      try {
        const buf = readFileSync(join(ctx.root, f.path));
        let n = 0;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
        s.lines += n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
      } catch {
        /* unreadable */
      }
    }
  }
  return Array.from(stats.values()).sort((a, b) => b.lines - a.lines);
}
