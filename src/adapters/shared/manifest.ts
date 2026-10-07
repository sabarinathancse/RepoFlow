/** Reads dependency manifests (composer, npm, pip) for versions and the dependency list. */
import { ScanContext } from '../../core/context';
import { Dependency } from '../../schema/graph';

function at(root: string, file: string): string {
  return root === '.' || !root ? file : `${root}/${file}`;
}

/** Installed version from composer.lock, falling back to the composer.json constraint. */
export function composerVersion(ctx: ScanContext, root: string, pkg: string): string | undefined {
  const lock = ctx.readJson(at(root, 'composer.lock'));
  const all = [...(lock?.packages || []), ...(lock?.['packages-dev'] || [])];
  const hit = all.find((p: any) => p.name === pkg);
  if (hit?.version) return String(hit.version).replace(/^v/, '');
  const json = ctx.readJson(at(root, 'composer.json'));
  return json?.require?.[pkg];
}

export function npmVersion(ctx: ScanContext, root: string, pkg: string): string | undefined {
  const lock = ctx.readJson(at(root, 'package-lock.json'));
  const v = lock?.packages?.[`node_modules/${pkg}`]?.version || lock?.dependencies?.[pkg]?.version;
  if (v) return v;
  const json = ctx.readJson(at(root, 'package.json'));
  return json?.dependencies?.[pkg] || json?.devDependencies?.[pkg];
}

export function pipVersion(ctx: ScanContext, root: string, pkg: string): string | undefined {
  for (const f of ['requirements.txt', 'requirements/base.txt', 'requirements/prod.txt', 'requirements-dev.txt']) {
    const t = ctx.read(at(root, f));
    if (!t) continue;
    const m = new RegExp(`^${pkg}(?:\\[[^\\]]*\\])?\\s*([=<>~!]=?\\s*[\\w.*]+)?`, 'im').exec(t);
    if (m) return m[1] ? m[1].replace(/\s+/g, '').replace(/^==/, '') : 'unpinned';
  }
  const py = ctx.read(at(root, 'pyproject.toml'));
  if (py) {
    const m = new RegExp(`["']?${pkg}["']?\\s*(?:=\\s*["']([^"']+)["']|([=<>~^]=?[\\w.*]+))`, 'i').exec(py);
    if (m) return (m[1] || m[2] || '').replace(/^==/, '');
  }
  return undefined;
}

/** Every declared dependency in every manifest that the walker found. */
export function collectDependencies(ctx: ScanContext): Dependency[] {
  const out: Dependency[] = [];
  for (const f of ctx.files) {
    const name = f.path.split('/').pop()!;
    if (name === 'composer.json') {
      const j = ctx.readJson(f.path);
      for (const [n, v] of Object.entries(j?.require || {})) out.push({ name: n, version: String(v), ecosystem: 'composer', dev: false, manifest: f.path });
      for (const [n, v] of Object.entries(j?.['require-dev'] || {})) out.push({ name: n, version: String(v), ecosystem: 'composer', dev: true, manifest: f.path });
    } else if (name === 'package.json') {
      const j = ctx.readJson(f.path);
      for (const [n, v] of Object.entries(j?.dependencies || {})) out.push({ name: n, version: String(v), ecosystem: 'npm', dev: false, manifest: f.path });
      for (const [n, v] of Object.entries(j?.devDependencies || {})) out.push({ name: n, version: String(v), ecosystem: 'npm', dev: true, manifest: f.path });
    } else if (/^requirements.*\.txt$/.test(name) || (f.path.includes('requirements/') && name.endsWith('.txt'))) {
      const t = ctx.read(f.path) || '';
      for (const line of t.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*([=<>~!]=?\s*[^;#\s]+)?/.exec(line);
        if (!m || line.trim().startsWith('#') || line.trim().startsWith('-')) continue;
        out.push({ name: m[1], version: (m[2] || '').replace(/\s+/g, '') || '*', ecosystem: 'pip', dev: /dev|test/.test(name), manifest: f.path });
      }
    } else if (name === 'pyproject.toml') {
      const t = ctx.read(f.path) || '';
      const deps = /\bdependencies\s*=\s*\[([\s\S]*?)\]/.exec(t);
      if (deps) {
        for (const m of deps[1].matchAll(/["']([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*([^"']*)["']/g)) {
          out.push({ name: m[1], version: m[2].trim() || '*', ecosystem: 'pip', dev: false, manifest: f.path });
        }
      }
      const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(t);
      if (poetry) {
        for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/gm)) {
          if (m[1] !== 'python') out.push({ name: m[1], version: m[2] || m[3] || '*', ecosystem: 'pip', dev: false, manifest: f.path });
        }
      }
    }
  }
  return out;
}
