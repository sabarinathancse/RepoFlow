/**
 * Plain PHP sites without a framework: every directly reachable .php file is
 * a page (route + handler + template); included files are partials.
 */
import { Adapter } from '../types';
import { analyzeBody } from '../../analyzers/steps';
import { stripPhp, parsePhp } from '../../parsers/php';
import { phpTemplateVars } from '../shared/php';
import { LineIndex, joinPath, dirname, uniq } from '../../utils/text';

const NON_PAGE_DIR = /(^|\/)(includes?|inc|lib|libs|classes|class|config|core|functions|helpers|partials|templates|layouts|vendor|src|app|tests?|cron|scripts|migrations|models|controllers)\//i;

export const genericPhp: Adapter = {
  id: 'generic-php',
  name: 'PHP (no framework)',
  language: 'PHP',

  detect(ctx) {
    const php = ctx.files.filter((f) => f.ext === 'php' && !f.path.endsWith('.blade.php'));
    if (!php.length) return [];
    return [{ id: 'generic-php', name: 'PHP (no framework)', language: 'PHP', root: '.', confidence: 0.3, evidence: [`${php.length} .php files`] }];
  },

  analyze(ctx, det, g) {
    const php = ctx.files.filter((f) => f.ext === 'php' && !f.path.endsWith('.blade.php') && (det.root === '.' || f.path.startsWith(det.root + '/')));
    const included = new Map<string, string[]>();
    const sources = new Map<string, string>();
    for (const f of php) {
      const src = ctx.read(f.path);
      if (src === null) continue;
      sources.set(f.path, src);
      const code = stripPhp(src);
      for (const m of code.matchAll(/\b(?:include|require)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.(?:php|phtml|inc))['"]/g)) {
        const target = resolveInclude(m[1], f.path, ctx.has.bind(ctx));
        if (target) included.set(target, [...(included.get(target) || []), f.path]);
      }
    }
    const webRoots = ['public', 'public_html', 'htdocs', 'www', 'web'].filter((d) => php.some((f) => f.path.startsWith(d + '/')));
    for (const [file, src] of sources) {
      const code = stripPhp(src);
      const lines = new LineIndex(src);
      const isPartial = included.has(file) && !/\$_(GET|POST|REQUEST)|<form|<html/i.test(src);
      const parsed = parsePhp(src);
      const onlyDefinitions = !/<html|<body|echo|print|\?>\s*</i.test(src) && (parsed.classes.length > 0 || parsed.functions.length > 0) && !/\$_(GET|POST|REQUEST)/.test(code);
      const viewId = `view:${file}`;
      const hasMarkup = /<\w+[^>]*>/.test(src.replace(/<\?[\s\S]*?\?>/g, ''));
      if (hasMarkup) {
        const grab = (re: RegExp) => uniq(Array.from(code.matchAll(re)).map((m) => resolveInclude(m[1], file, ctx.has.bind(ctx)) || m[1]));
        const includes = grab(/\b(?:include|require)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.(?:php|phtml|inc))['"]/g);
        g.addView({
          id: viewId, name: file, file, engine: 'php', lines: lines.count, extends: [], includes: includes.map((i) => `view:${i}`),
          sections: [], vars: phpTemplateVars(src), forms: [], links: [], scripts: [], calls: [], isLayout: /header|footer|layout/i.test(file),
        });
        for (const i of includes) if (sources.has(i)) g.addEdge(viewId, `view:${i}`, 'includes');
      }
      if (isPartial || onlyDefinitions || (NON_PAGE_DIR.test(file) && !webRoots.some((w) => file.startsWith(w + '/')))) continue;
      const res = analyzeBody(code, (o) => lines.lineAt(o), { lang: 'php', resolveModel: () => undefined, modelTable: () => undefined });
      const handlerId = `page:${file}`;
      g.addHandler({
        id: handlerId, name: file.split('/').pop()!, kind: 'script', file, line: 1, endLine: lines.count, framework: 'generic-php',
        area: dirname(file) === '.' ? 'root' : dirname(file), steps: res.steps, tables: res.tables, data: res.data, responses: res.responses.length ? res.responses : hasMarkup ? ['html'] : [],
      });
      if (hasMarkup) g.addEdge(handlerId, viewId, 'renders');
      const web = webRoots.find((w) => file.startsWith(w + '/'));
      const urlPath = '/' + (web ? file.slice(web.length + 1) : file);
      const methods = /\$_POST|REQUEST_METHOD['"]\]\s*===?\s*['"]POST/.test(code) ? ['GET', 'POST'] : ['GET'];
      for (const method of methods) {
        const r = g.addRoute({ method, path: urlPath.replace(/(^|\/)index\.php$/, '$1') || '/', target: file, handler: handlerId, middleware: [], file, line: 1, framework: 'generic-php' });
        g.addEdge(r.id, handlerId, 'routes-to');
        const h = g.handlers.get(handlerId)!;
        if (!h.routes.includes(r.id)) h.routes.push(r.id);
      }
    }
    g.lifecycle.push(
      { id: 'php-server', title: 'Web server', subtitle: 'Apache / Nginx + PHP', detail: 'The web server maps the URL straight to a .php file on disk (plus any .htaccess rewrites).' },
      { id: 'php-page', title: 'Page script', subtitle: `${g.handlers.size} pages`, detail: 'The requested .php file runs top to bottom: it reads $_GET/$_POST, includes shared files and decides what to output.' },
      { id: 'php-includes', title: 'Includes', subtitle: 'config, db, header/footer', detail: 'include/require pull in configuration, the database connection, helper functions and shared header/footer markup.' },
      { id: 'php-db', title: 'Database', subtitle: 'mysqli / PDO', detail: 'SQL queries run directly through mysqli or PDO.' },
      { id: 'php-out', title: 'Output', subtitle: 'HTML, JSON or redirect', detail: 'The script echoes HTML, prints JSON, or sends header("Location: …") and exits.' },
    );
    g.recipes.push({
      id: 'php-page', title: 'Add a page', summary: 'Create a .php file and link to it.', files: [],
      steps: ['Create my-page.php next to the existing pages.', 'include the shared header/footer and config/db files the other pages use.', 'Use prepared statements (mysqli_prepare / PDO::prepare) for any query with user input.', 'Link to it from the navigation partial.'],
    });
  },
};

function resolveInclude(target: string, from: string, has: (p: string) => boolean): string | undefined {
  const t = target.replace(/^\.?\//, '');
  const candidates = [joinPath(dirname(from), target), t, joinPath(dirname(from), '..', t)];
  return candidates.find((c) => has(c));
}
