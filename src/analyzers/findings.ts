/**
 * Framework-agnostic heuristic checks. Every finding is a lead to verify,
 * never a verdict; secret values are always masked.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { LineIndex, maskSecret } from '../utils/text';
import { stripPhp } from '../parsers/php';
import { stripJs } from '../parsers/js';

interface CodeRule {
  rule: string;
  langs: RegExp;
  re: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  title: string;
  detail: string;
}

const CODE_RULES: CodeRule[] = [
  {
    rule: 'sql-interpolation', langs: /\.php$/, severity: 'high', category: 'security',
    re: /(?:->query|->simpleQuery|mysqli_query|->exec|->prepare|DB::(?:select|statement|unprepared|insert|update|delete))\s*\([^;]*?(?:"[^"]*\$\w+[^"]*"|['"]\s*\.\s*\$(?!this->db)\w+|\$_(?:GET|POST|REQUEST)\[)/,
    title: 'SQL built from variables', detail: 'A raw SQL query interpolates or concatenates a variable. If the value comes from the request this is SQL injection; use query bindings / prepared statements.',
  },
  {
    rule: 'sql-interpolation', langs: /\.py$/, severity: 'high', category: 'security',
    re: /\.(?:execute|raw|executemany)\(\s*(?:f["']|["'][^"']*["']\s*(?:%|\.format\(|\+))/,
    title: 'SQL built from variables', detail: 'A raw SQL string is formatted with Python values. Pass parameters separately (cursor.execute(sql, params)).',
  },
  {
    rule: 'sql-interpolation', langs: /\.(m?js|ts)$/, severity: 'high', category: 'security',
    re: /\.(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe)\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/,
    title: 'SQL built from variables', detail: 'A raw SQL string is built with template literals or concatenation. Use placeholders and pass values as parameters.',
  },
  {
    rule: 'command-exec', langs: /\.php$/, severity: 'high', category: 'security',
    re: /\b(?:shell_exec|system|passthru|exec|popen|proc_open)\s*\([^)]*\$/,
    title: 'Shell command built from a variable', detail: 'A shell command includes a variable. If any part comes from user input this is command injection; use escapeshellarg() or avoid the shell.',
  },
  {
    rule: 'command-exec', langs: /\.py$/, severity: 'high', category: 'security',
    re: /\bos\.system\(|subprocess\.\w+\([^)]*shell\s*=\s*True/,
    title: 'Shell command execution', detail: 'Commands run through a shell. Make sure no user input reaches the command string.',
  },
  {
    rule: 'command-exec', langs: /\.(m?js|ts)$/, severity: 'high', category: 'security',
    re: /\b(?:exec|execSync)\(\s*(?:`[^`]*\$\{|[^,)]*\+)/,
    title: 'Shell command built from a variable', detail: 'child_process.exec is called with an interpolated string. Use execFile/spawn with an argument array.',
  },
  {
    rule: 'eval', langs: /\.(php|py|m?js|ts)$/, severity: 'medium', category: 'security',
    re: /(?:^|[^\w.$>])eval\s*\(/,
    title: 'Dynamic code evaluation (eval)', detail: 'eval() executes a string as code. Make sure it never receives user-controlled input.',
  },
  {
    rule: 'unsafe-deserialize', langs: /\.(php|py)$/, severity: 'medium', category: 'security',
    re: /\bunserialize\(\s*\$_(?:GET|POST|COOKIE|REQUEST)|\bpickle\.loads?\(|yaml\.load\((?![^)]*Loader)/,
    title: 'Unsafe deserialization', detail: 'Deserializing untrusted data can execute code. Prefer JSON or a safe loader.',
  },
  {
    rule: 'cors-wildcard', langs: /\.(php|py|m?js|ts)$/, severity: 'low', category: 'security',
    re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]?\s*\*|allow_origins\s*=\s*\[\s*["']\*["']|CORS_ALLOW_ALL_ORIGINS\s*=\s*True|origin\s*:\s*['"]\*['"]/,
    title: 'CORS allows any origin', detail: 'Any website can call these endpoints from a browser. Restrict allowed origins if the API uses cookies or returns private data.',
  },
  {
    rule: 'tls-verify-off', langs: /\.(php|py|m?js|ts)$/, severity: 'medium', category: 'security',
    re: /CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|verify\s*=\s*False|rejectUnauthorized\s*:\s*false/,
    title: 'TLS certificate verification disabled', detail: 'Outgoing HTTPS calls accept any certificate, allowing man-in-the-middle attacks.',
  },
  {
    rule: 'debug-output', langs: /\.php$/, severity: 'low', category: 'quality',
    re: /^\s*(?:var_dump|print_r|dd|dump)\s*\(/m,
    title: 'Debug output left in code', detail: 'var_dump/print_r/dd calls can leak data into responses.',
  },
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(AKIA[0-9A-Z]{16})\b/, 'AWS access key id'],
  [/\b(sk_live_[0-9a-zA-Z]{16,})/, 'Stripe live secret key'],
  [/\b(rzp_live_[0-9a-zA-Z]{8,})/, 'Razorpay live key'],
  [/\b(AIza[0-9A-Za-z\-_]{35})\b/, 'Google API key'],
  [/\b(xox[baprs]-[0-9A-Za-z-]{10,})/, 'Slack token'],
  [/\b(ghp_[0-9A-Za-z]{30,})/, 'GitHub token'],
  [/\b(SG\.[\w-]{16,}\.[\w-]{16,})/, 'SendGrid API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----()/, 'Private key'],
  [/(?:password|passwd|secret|api_?key|auth_?token|access_?token|client_secret|SECRET_KEY)['"]?\s*(?:=>|=|:)\s*['"]([^'"\s$]{8,})['"]/i, 'Hard-coded credential'],
];

const PLACEHOLDER = /^(your|change|example|xxx|test|dummy|secret|password|placeholder|<|\*|null|none|todo|replace|insert|django-insecure-)/i;
/** Validation rule strings ("required|min_length[8]") look like credentials but are not. */
const RULE_STRING = /^(required|permit_empty|nullable|sometimes|trim|min|max|valid_|matches|confirmed|string|alpha|numeric|integer|regex|is_unique|in_list|differs)\b|\|/i;
/** Files that never run inside a web request. */
const NOT_REQUEST = /(^|\/)(Database\/Migrations|database\/migrations|migrations|Database\/Seeds|seeders|Commands|management\/commands|scripts|bin|cli)\//;

export function analyzeFindings(ctx: ScanContext, g: GraphBuilder): void {
  const ruleHits = new Map<string, number>();
  for (const f of ctx.files) {
    if (!/\.(php|py|m?js|ts|tsx|jsx|json|ya?ml|ini|conf|env|xml|properties|toml)$/.test(f.path) || f.size > 600_000) continue;
    if (/\.min\.js$|(^|\/)(package-lock|composer\.lock|yarn\.lock)|\.lock$|(^|\/)(tests?|__tests__|spec|fixtures)\//.test(f.path)) continue;
    const raw = ctx.read(f.path);
    if (!raw) continue;
    const code = f.ext === 'php' ? stripPhp(raw) : /\.(m?js|ts|tsx|jsx)$/.test(f.path) ? stripJs(raw) : raw;
    let lines: LineIndex | undefined;
    const lineOf = (i: number) => (lines = lines || new LineIndex(raw)).lineAt(i);

    for (const r of CODE_RULES) {
      if (!r.langs.test(f.path)) continue;
      const m = r.re.exec(code);
      if (!m) continue;
      const n = (ruleHits.get(r.rule) || 0) + 1;
      ruleHits.set(r.rule, n);
      if (n > 25) continue;
      const count = (code.match(new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g')) || []).length;
      const offline = NOT_REQUEST.test(f.path) && (r.rule === 'sql-interpolation' || r.rule === 'command-exec');
      g.addFinding({
        severity: offline ? 'low' : r.severity, category: r.category, rule: r.rule, file: f.path, line: lineOf(m.index),
        title: count > 1 ? `${r.title} (${count}× in this file)` : r.title,
        detail: offline ? `${r.detail} This file is a migration / CLI command, so it is not directly reachable from a web request.` : r.detail,
      });
    }

    if (/(^|\/)\.env\.example$|\.(md|lock)$/.test(f.path)) continue;
    for (const [re, label] of SECRET_PATTERNS) {
      const m = re.exec(code);
      if (!m) continue;
      const value = m[1] || '';
      if (label === 'Hard-coded credential' && (PLACEHOLDER.test(value) || RULE_STRING.test(value) || /env\(|getenv|os\.environ|process\.env|\{\{|\$\{/.test(m[0]))) continue;
      g.addFinding({
        severity: label === 'Hard-coded credential' ? 'high' : 'critical', category: 'secrets', rule: 'hardcoded-secret', file: f.path, line: lineOf(m.index),
        title: `${label} in source`, detail: `A value that looks like a ${label.toLowerCase()} is committed in this file${value ? ` (${maskSecret(value)})` : ''}. Move it to environment configuration and rotate it.`,
      });
      break;
    }
    if (raw.split('\n').length > 1500 && /\.(php|py|m?js|ts)$/.test(f.path)) {
      g.addFinding({
        severity: 'info', category: 'maintainability', rule: 'large-file', file: f.path,
        title: `Very large source file (${raw.split('\n').length} lines)`, detail: 'Large files are hard to review and change safely; consider splitting by responsibility.',
      });
    }
  }

  // .env committed to git
  if (existsSync(join(ctx.root, '.git'))) {
    for (const f of ctx.files) {
      if (/(^|\/)\.env(\.(local|production|prod))?$/.test(f.path)) {
        g.addFinding({
          severity: 'high', category: 'secrets', rule: 'env-not-ignored', file: f.path,
          title: 'Environment file is not git-ignored', detail: 'This .env file is not excluded by .gitignore, so credentials in it can be committed. Add it to .gitignore and rotate anything already pushed.',
        });
      }
    }
  }

  routeChecks(g);
  unusedChecks(g);
  aggregate(g);
}

/** Rules that are noisy one-by-one are merged into a single finding with an evidence list. */
const AGGREGATE: Record<string, (n: number) => string> = {
  'unrouted-controller': (n) => `${n} controllers that no route reaches`,
  'large-file': (n) => `${n} very large source files (over 1,500 lines)`,
  'get-deletes': (n) => `${n} GET routes that delete data`,
  'route-missing-method': (n) => `${n} routes point to controller methods that do not exist`,
  'debug-output': (n) => `${n} files with debug output (var_dump / print_r / dd)`,
  'form-missing-csrf': (n) => `${n} templates with state-changing forms lacking a CSRF token`,
};

function aggregate(g: GraphBuilder): void {
  for (const [rule, title] of Object.entries(AGGREGATE)) {
    const hits = g.findings.filter((f) => f.rule === rule);
    if (hits.length <= 3) continue;
    const first = hits[0];
    g.findings = g.findings.filter((f) => f.rule !== rule);
    g.addFinding({
      severity: first.severity, category: first.category, rule, title: title(hits.length),
      detail: `${first.detail} Examples: ${hits.slice(0, 8).map((h) => h.title.replace(/^.*?: /, '') + (h.file ? ` (${h.file}${h.line ? ':' + h.line : ''})` : '')).join('; ')}${hits.length > 8 ? '; …' : ''}.`,
      evidence: hits.slice(0, 60).map((h) => ({ file: h.file || '', line: h.line })),
    });
  }
}

function routeChecks(g: GraphBuilder): void {
  const adminLike = /(^|\/)(admin|dashboard|manage|backend|cms|panel|settings|staff)(\/|$)/i;
  const unprotected: string[] = [];
  for (const r of g.routes.values()) {
    const h = r.handler ? g.handlers.get(r.handler) : undefined;
    if (adminLike.test(r.path) && r.middleware.length === 0 && !/login|logout|signin|password|forgot|reset/i.test(r.path)) {
      const container = h?.container ? g.containers.get(h.container) : undefined;
      const guarded = h?.steps.some((s) => s.kind === 'auth' || (s.kind === 'session' && /get|has|check/i.test(s.text))) ||
        (container?.extends && !/^(\\?\w+\\)*(BaseController|Controller|AbstractController|ResourceController|APIView|View)$/.test(container.extends)) ||
        h?.decorators?.some((d) => /login_required|permission|auth|staff|Depends/i.test(d));
      if (!guarded) unprotected.push(r.id);
    }
    if (r.method === 'GET' && h && h.data.some((d) => d.op === 'delete') && !/logout/i.test(r.path)) {
      g.addFinding({
        severity: 'medium', category: 'security', rule: 'get-deletes', file: r.file, line: r.line,
        title: `GET request deletes data: ${r.path}`, detail: 'Data is deleted by a GET request. Links can be prefetched, crawled or forged cross-site; use POST/DELETE with CSRF protection.',
      });
    }
  }
  if (unprotected.length) {
    const first = g.routes.get(unprotected[0])!;
    g.addFinding({
      severity: 'high', category: 'security', rule: 'admin-route-unguarded', file: first.file, line: first.line,
      title: `${unprotected.length} admin-looking route${unprotected.length > 1 ? 's' : ''} without middleware or an auth check`,
      detail: `No filter/middleware is attached and no auth or session check was found in the handler or its base class. Verify these are protected: ${unprotected.slice(0, 12).map((id) => g.routes.get(id)!.path).join(', ')}${unprotected.length > 12 ? ', …' : ''}.`,
      evidence: unprotected.slice(0, 30).map((id) => ({ file: g.routes.get(id)!.file, line: g.routes.get(id)!.line })),
    });
  }
}

function unusedChecks(g: GraphBuilder): void {
  if (!g.routes.size) return;
  const routedHandlers = new Set(Array.from(g.routes.values()).map((r) => r.handler).filter(Boolean));
  const autoRoute = g.findings.some((f) => f.rule === 'ci4-auto-route');
  if (!autoRoute) {
    for (const c of g.containers.values()) {
      if (c.kind !== 'controller' || /Base|Abstract/.test(c.name)) continue;
      const unrouted = c.handlers.filter((id) => {
        const h = g.handlers.get(id);
        return h && h.visibility === 'public' && !routedHandlers.has(id) && !h.name.startsWith('_');
      });
      if (unrouted.length && unrouted.length === c.handlers.filter((id) => g.handlers.get(id)?.visibility === 'public').length && c.handlers.length) {
        g.addFinding({
          severity: 'info', category: 'maintainability', rule: 'unrouted-controller', file: c.file, line: c.line,
          title: `No route reaches ${c.name}`, detail: `None of its ${unrouted.length} public method(s) is referenced by a route. It may be dead code, a base class, or reached by auto-routing.`,
        });
      }
    }
  }
  const referenced = new Set<string>();
  for (const e of g.edges) if (e.kind === 'renders' || e.kind === 'extends' || e.kind === 'includes') referenced.add(e.to);
  const unusedViews = Array.from(g.views.values()).filter((v) => !referenced.has(v.id) && !v.isLayout && !/(^|\/)(errors?|emails?|partials?|components?|layouts?|cells?|_)/i.test(v.name));
  if (unusedViews.length >= 1 && g.handlers.size) {
    g.addFinding({
      severity: 'info', category: 'maintainability', rule: 'unreferenced-views',
      title: `${unusedViews.length} template${unusedViews.length > 1 ? 's' : ''} not referenced by any handler or other template`,
      detail: `Possibly dead templates (or rendered with a computed name): ${unusedViews.slice(0, 15).map((v) => v.name).join(', ')}${unusedViews.length > 15 ? ', …' : ''}.`,
      evidence: unusedViews.slice(0, 40).map((v) => ({ file: v.file })),
    });
  }
}
