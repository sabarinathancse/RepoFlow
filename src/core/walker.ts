import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { FileEntry, languageOf } from './context';
import { IgnoreMatcher, DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_PATHS } from '../utils/ignore';

export interface WalkOptions {
  /** project-relative paths that must never be scanned (the output directory, for one) */
  exclude: string[];
  useGitignore: boolean;
  maxFiles: number;
}

export interface WalkResult {
  files: FileEntry[];
  skippedDirs: string[];
  truncated: boolean;
}

/** Lists project files, honouring default ignores, .gitignore and .repoflowignore. */
export function walk(root: string, opts: WalkOptions): WalkResult {
  const matcher = new IgnoreMatcher();
  const files: FileEntry[] = [];
  const skippedDirs: string[] = [];
  const excluded = new Set(opts.exclude.map((e) => e.replace(/\/$/, '')));
  const ignoredPaths = new Set(DEFAULT_IGNORED_PATHS);
  let truncated = false;

  const loadIgnore = (dirRel: string) => {
    const names = opts.useGitignore ? ['.gitignore', '.repoflowignore'] : ['.repoflowignore'];
    for (const name of names) {
      const p = join(root, dirRel, name);
      if (existsSync(p)) {
        try {
          matcher.add(dirRel, readFileSync(p, 'utf8'));
        } catch {
          /* unreadable ignore file: skip */
        }
      }
    }
  };

  const visit = (dirRel: string) => {
    if (truncated) return;
    loadIgnore(dirRel);
    let entries: string[];
    try {
      entries = readdirSync(join(root, dirRel)).sort();
    } catch {
      return;
    }
    // A Python virtualenv under any name.
    if (dirRel && entries.includes('pyvenv.cfg')) {
      skippedDirs.push(dirRel);
      return;
    }
    for (const name of entries) {
      const rel = dirRel ? `${dirRel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, rel));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(name) || excluded.has(rel) || ignoredPaths.has(rel) || matcher.ignores(rel, true)) {
          skippedDirs.push(rel);
          continue;
        }
        visit(rel);
      } else if (st.isFile()) {
        if (name === '.DS_Store' || matcher.ignores(rel, false)) continue;
        if (files.length >= opts.maxFiles) {
          truncated = true;
          return;
        }
        const dot = name.lastIndexOf('.');
        files.push({ path: rel, size: st.size, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', language: languageOf(rel) });
      }
    }
  };

  visit('');
  return { files, skippedDirs, truncated };
}
