// Parsers, output safety, renderer escaping and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist/cli/index.js');
const { parsePhp, parsePhpValue } = require('../dist/parsers/php');
const { parsePython } = require('../dist/parsers/python');
const { parseJs } = require('../dist/parsers/js');
const { scriptJson } = require('../dist/renderer');
const { IgnoreMatcher } = require('../dist/utils/ignore');

test('php parser: classes, methods, comments, arrays', () => {
  const p = parsePhp(`<?php
namespace App\\X;
use App\\Models\\{A, B as Bee};
// class Fake {}
class Foo extends Bar {
  protected $table = 'foos';
  public function a($x) { if ($x) { return "}"; } }
  private static function b(): array { return []; }
}`);
  assert.equal(p.classes.length, 1);
  assert.equal(p.classes[0].fqcn, 'App\\X\\Foo');
  assert.deepEqual(p.classes[0].methods.map((m) => [m.name, m.visibility]), [['a', 'public'], ['b', 'private']]);
  assert.equal(p.uses.get('Bee'), 'App\\Models\\B');
  assert.deepEqual(parsePhpValue("['a' => 1, 'b' => ['x', 'y']]"), { a: 1, b: ['x', 'y'] });
});

test('python parser: blocks, decorators, imports', () => {
  const p = parsePython('from .views import a, b as c\n\n@deco(1)\ndef f(x,\n      y):\n    return 1\n\nclass K(Base):\n    def m(self):\n        pass\n');
  assert.deepEqual(p.blocks.map((b) => b.name), ['f', 'K']);
  assert.equal(p.blocks[0].decorators[0].text, 'deco(1)');
  assert.equal(p.blocks[1].children[0].name, 'm');
  assert.equal(p.imports.get('c').name, 'b');
});

test('js parser: requires, exports, arrow functions', () => {
  const p = parseJs("const x = require('./x');\nexports.list = async (req, res) => { res.json([]) };\nmodule.exports.y = function () {};\n// fake() {}\n");
  assert.equal(p.imports.get('x').source, './x');
  assert.ok(p.functions.some((f) => f.name === 'list'));
  assert.ok(p.exports.has('list'));
});

test('ignore matcher: gitignore subset', () => {
  const m = new IgnoreMatcher();
  m.add('', '*.log\n/build\nsecret/\n!keep.log\n');
  assert.ok(m.ignores('a/b.log', false));
  assert.ok(!m.ignores('keep.log', false));
  assert.ok(m.ignores('build', true) && !m.ignores('src/build', true));
  assert.ok(m.ignores('x/secret', true));
});

test('renderer: embedded JSON cannot break out of the script tag', () => {
  const s = scriptJson({ a: '</script><img src=x onerror=alert(1)>', b: ' ' });
  assert.ok(!s.includes('</script') && !s.includes('<'));
  assert.deepEqual(JSON.parse(s), { a: '</script><img src=x onerror=alert(1)>', b: ' ' });
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'repoflow-cli-'));
  writeFileSync(join(dir, 'index.php'), '<?php echo "<h1>hi</h1>";');
  return dir;
}

test('cli: writes the four files into <project>/repoflow and excludes it on rescan', () => {
  const dir = project();
  execFileSync('node', [CLI, 'scan', dir, '-q']);
  assert.deepEqual(readdirSync(join(dir, 'repoflow')).sort(), ['index.html', 'project-graph.json', 'project-summary.md', 'scan-manifest.json']);
  execFileSync('node', [CLI, 'scan', dir, '-q']);
  const graph = JSON.parse(readFileSync(join(dir, 'repoflow/project-graph.json'), 'utf8'));
  assert.equal(graph.stats.files, 1, 'repoflow/ output is not scanned');
  assert.ok(readFileSync(join(dir, 'repoflow/index.html'), 'utf8').includes('id="repoflow-graph"'));
});

test('cli: refuses to overwrite a repoflow/ folder it did not create', () => {
  const dir = project();
  mkdirSync(join(dir, 'repoflow'));
  writeFileSync(join(dir, 'repoflow/notes.txt'), 'mine');
  const r = spawnSync('node', [CLI, 'scan', dir, '-q']);
  assert.equal(r.status, 1);
  assert.match(String(r.stderr), /not created by RepoFlow/);
  assert.ok(!existsSync(join(dir, 'repoflow/index.html')));
  assert.equal(spawnSync('node', [CLI, 'scan', dir, '-q', '--force']).status, 0);
  assert.equal(readFileSync(join(dir, 'repoflow/notes.txt'), 'utf8'), 'mine', 'other files are left alone');
});

test('cli: --out, unknown options and frameworks', () => {
  const dir = project();
  execFileSync('node', [CLI, 'scan', dir, '--out', 'docs/explorer', '-q']);
  assert.ok(existsSync(join(dir, 'docs/explorer/index.html')));
  assert.equal(spawnSync('node', [CLI, 'scan', dir, '--bogus']).status, 1);
  assert.equal(spawnSync('node', [CLI, 'scan', dir, '--framework', 'rails']).status, 1);
});
