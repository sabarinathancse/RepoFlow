/**
 * A pragmatic .gitignore matcher (the common subset: globs, "**", anchoring,
 * trailing "/" for directories, "!" negation, nested ignore files).
 */

interface Rule {
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Directories RepoFlow never descends into, whatever the ignore files say. */
export const DEFAULT_IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'bower_components', '__pycache__', '.venv', 'venv',
  '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vscode', '.next', '.nuxt',
  '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'coverage', 'htmlcov', 'dist', 'build', '.repoflow',
  'site-packages', '.terraform', '.gradle', 'Pods', '.archify', '.claude',
]);

/** Project-relative directories that hold runtime state, not source. */
export const DEFAULT_IGNORED_PATHS = [
  'storage/framework', 'storage/logs', 'bootstrap/cache', 'writable/cache', 'writable/logs',
  'writable/session', 'writable/debugbar', 'writable/uploads', 'public/uploads', 'media', 'staticfiles',
];

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += glob.slice(i, end + 1).replace(/^\[!/, '[^');
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp((anchored ? '^' : '(?:^|/)') + re + '(?:/.*)?$');
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  /** Adds the lines of an ignore file found in project-relative directory `base` ("" for root). */
  add(base: string, content: string): void {
    for (let raw of content.split(/\r?\n/)) {
      raw = raw.replace(/\s+$/, '');
      if (!raw || raw.startsWith('#')) continue;
      let negate = false;
      if (raw.startsWith('!')) {
        negate = true;
        raw = raw.slice(1);
      }
      if (raw.startsWith('\\')) raw = raw.slice(1);
      let dirOnly = false;
      if (raw.endsWith('/')) {
        dirOnly = true;
        raw = raw.slice(0, -1);
      }
      const anchored = raw.includes('/');
      if (raw.startsWith('/')) raw = raw.slice(1);
      if (!raw) continue;
      this.rules.push({ base, re: globToRegExp(raw, anchored), negate, dirOnly });
    }
  }

  /** `rel` is project-relative and posix-style. */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      let sub = rel;
      if (r.base) {
        if (!rel.startsWith(r.base + '/')) continue;
        sub = rel.slice(r.base.length + 1);
      }
      if (r.re.test(sub)) ignored = !r.negate;
    }
    return ignored;
  }
}
