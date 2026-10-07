import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads the current branch and commit from .git without running git. */
export function gitInfo(root: string): { commit?: string; branch?: string } | undefined {
  const dir = join(root, '.git');
  try {
    if (!existsSync(join(dir, 'HEAD'))) return undefined;
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return { commit: head.slice(0, 12) };
    const branch = ref[1].replace(/^refs\/heads\//, '');
    let commit: string | undefined;
    const loose = join(dir, ref[1]);
    if (existsSync(loose)) commit = readFileSync(loose, 'utf8').trim();
    else if (existsSync(join(dir, 'packed-refs'))) {
      const line = readFileSync(join(dir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref[1]));
      commit = line?.split(' ')[0];
    }
    return { branch, commit: commit ? commit.slice(0, 12) : undefined };
  } catch {
    return undefined;
  }
}
