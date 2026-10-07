import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toPosix } from '../utils/text';

export interface FileEntry {
  /** project-relative posix path */
  path: string;
  size: number;
  ext: string;
  language?: string;
}

const LANGUAGES: Record<string, string> = {
  php: 'PHP', py: 'Python', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', vue: 'Vue', svelte: 'Svelte',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'Less', sql: 'SQL',
  json: 'JSON', yml: 'YAML', yaml: 'YAML', md: 'Markdown', rb: 'Ruby', go: 'Go', java: 'Java',
  kt: 'Kotlin', dart: 'Dart', sh: 'Shell', ejs: 'EJS', pug: 'Pug', hbs: 'Handlebars', twig: 'Twig',
  jinja: 'Jinja', jinja2: 'Jinja', xml: 'XML', toml: 'TOML', prisma: 'Prisma', cs: 'C#', swift: 'Swift',
};

export function languageOf(path: string): string | undefined {
  if (path.endsWith('.blade.php')) return 'Blade';
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANGUAGES[ext];
}

/** Files bigger than this are listed but never parsed. */
export const MAX_PARSE_BYTES = 1_500_000;

/**
 * Everything an adapter or analyzer may know about the project being scanned.
 * All paths in and out of the context are project-relative and posix-style.
 */
export class ScanContext {
  readonly fileSet: Set<string>;
  readonly warnings: string[] = [];
  private cache = new Map<string, string | null>();
  parsedFiles = new Set<string>();

  constructor(readonly root: string, readonly files: FileEntry[]) {
    this.fileSet = new Set(files.map((f) => f.path));
  }

  has(rel: string): boolean {
    return this.fileSet.has(toPosix(rel));
  }

  /** Reads a project file from disk even if the walker skipped it (e.g. composer.lock). */
  existsOnDisk(rel: string): boolean {
    return existsSync(join(this.root, rel));
  }

  read(rel: string): string | null {
    rel = toPosix(rel);
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    let text: string | null = null;
    try {
      const abs = join(this.root, rel);
      const st = statSync(abs);
      if (st.isFile() && st.size <= MAX_PARSE_BYTES) {
        const buf = readFileSync(abs);
        if (!buf.subarray(0, 8000).includes(0)) text = buf.toString('utf8');
      }
    } catch {
      text = null;
    }
    this.cache.set(rel, text);
    if (text !== null) this.parsedFiles.add(rel);
    return text;
  }

  readJson<T = any>(rel: string): T | null {
    const t = this.read(rel);
    if (!t) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      return null;
    }
  }

  /** Files under a directory prefix ("" = everything), optionally filtered by suffix. */
  under(prefix: string, ...suffixes: string[]): FileEntry[] {
    const p = prefix && prefix !== '.' ? prefix.replace(/\/$/, '') + '/' : '';
    return this.files.filter(
      (f) => (!p || f.path.startsWith(p)) && (suffixes.length === 0 || suffixes.some((s) => f.path.endsWith(s))),
    );
  }

  byName(name: string): FileEntry[] {
    return this.files.filter((f) => f.path === name || f.path.endsWith('/' + name));
  }

  warn(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}
