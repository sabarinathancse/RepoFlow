// Copies the renderer's static assets (CSS, client JS, HTML template) into dist/.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['renderer/assets', 'renderer/components']) {
  const src = join(root, 'src', dir);
  if (existsSync(src)) cpSync(src, join(root, 'dist', dir), { recursive: true });
}

// Fail the build if src/version.ts drifted from package.json.
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ver = readFileSync(join(root, 'src', 'version.ts'), 'utf8');
if (!ver.includes(`'${pkg.version}'`)) {
  console.error(`src/version.ts does not match package.json version ${pkg.version}`);
  process.exit(1);
}
