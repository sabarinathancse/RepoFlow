#!/usr/bin/env node
/**
 * repoflow CLI. Usage:
 *   npx repoflow scan [path] [--out <dir>] [--framework <id,...>] [--no-gitignore] [--max-files <n>] [--force] [--quiet]
 */
import { existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { scanProject } from '../core/scan';
import { assertWritableOutDir, OutputDirError, writeOutputs } from '../core/output';
import { ADAPTERS } from '../adapters';
import { VERSION } from '../version';

const HELP = `RepoFlow ${VERSION}: generate an interactive explorer for an existing project.

Usage
  repoflow scan [path]        Scan a project (default: current directory)
  repoflow adapters           List supported frameworks
  repoflow --version

Options for scan
  -o, --out <dir>             Output directory (default: <path>/repoflow)
  -f, --framework <ids>       Only use these adapters, comma-separated (see "repoflow adapters")
      --no-gitignore          Do not honour .gitignore (.repoflowignore still applies)
      --max-files <n>         Stop listing after n files (default 25000)
      --force                 Write into an existing output folder RepoFlow did not create
  -q, --quiet                 Only print errors

Output
  repoflow/index.html          Standalone interactive project explorer (open in a browser)
  repoflow/project-graph.json  Normalized project graph
  repoflow/project-summary.md  Markdown digest
  repoflow/scan-manifest.json  Scan metadata

The analyzed project does not need Node.js: PHP and Python projects work through npx.`;

interface Args {
  command: string;
  path: string;
  out?: string;
  frameworks?: string[];
  gitignore: boolean;
  maxFiles?: number;
  force: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: '', path: '.', gitignore: true, force: false, quiet: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (v === undefined) fail(`Missing value for ${arg}`);
      return v;
    };
    const name = arg.split('=')[0];
    switch (name) {
      case '-h': case '--help': console.log(HELP); process.exit(0);
      // falls through (process.exit never returns)
      case '-v': case '--version': console.log(VERSION); process.exit(0);
      // falls through
      case '-o': case '--out': a.out = value(); break;
      case '-f': case '--framework': case '--frameworks': a.frameworks = value().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--no-gitignore': a.gitignore = false; break;
      case '--max-files': a.maxFiles = Number(value()); break;
      case '--force': a.force = true; break;
      case '-q': case '--quiet': a.quiet = true; break;
      default:
        if (arg.startsWith('-')) fail(`Unknown option ${arg}. Run "repoflow --help".`);
        positional.push(arg);
    }
  }
  a.command = positional[0] || '';
  if (positional[1]) a.path = positional[1];
  return a;
}

function fail(msg: string): never {
  console.error(`repoflow: ${msg}`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command) {
    console.log(HELP);
    return;
  }
  if (args.command === 'adapters') {
    for (const a of ADAPTERS) console.log(`${a.id.padEnd(14)} ${a.name} (${a.language})`);
    return;
  }
  if (args.command !== 'scan') fail(`Unknown command "${args.command}". Run "repoflow --help".`);

  const root = resolve(args.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`${root} is not a directory`);
  const outDir = resolve(root, args.out || 'repoflow');
  if (args.frameworks) {
    const unknown = args.frameworks.filter((f) => !ADAPTERS.some((a) => a.id === f));
    if (unknown.length) fail(`Unknown framework id(s): ${unknown.join(', ')}. Run "repoflow adapters".`);
  }
  if (args.maxFiles !== undefined && !(args.maxFiles > 0)) fail('--max-files must be a positive number');
  try {
    assertWritableOutDir(outDir, args.force);
  } catch (e) {
    if (e instanceof OutputDirError) fail(e.message);
    throw e;
  }

  const log = (m: string) => {
    if (!args.quiet) console.log(m);
  };
  log(`RepoFlow ${VERSION} · scanning ${root}`);
  const result = scanProject({
    root, outDir, useGitignore: args.gitignore, maxFiles: args.maxFiles, frameworks: args.frameworks,
    onProgress: (m) => log(`  ${m}`),
  });
  const written = writeOutputs(outDir, result, {
    out: relative(root, outDir) || '.', frameworks: args.frameworks || 'auto', gitignore: args.gitignore, maxFiles: args.maxFiles || 25000,
  });
  const g = result.graph;
  const fws = g.frameworks.map((f) => `${f.name}${f.root !== '.' ? ` (${f.root}/)` : ''}`).join(', ');
  log('');
  log(`  Detected   ${fws}`);
  log(`  Found      ${g.stats.routes} routes · ${g.stats.handlers} handlers · ${g.stats.models} models · ${g.stats.tables} tables · ${g.stats.views} views · ${g.stats.integrations} integrations`);
  log(`  Findings   ${g.stats.critical} critical · ${g.stats.high} high · ${g.stats.medium} medium · ${g.stats.low} low · ${g.stats.info} info`);
  for (const w of g.warnings) log(`  Warning    ${w}`);
  log('');
  for (const f of written) log(`  wrote ${relative(process.cwd(), resolve(outDir, f.file)) || f.file}  (${(f.bytes / 1024).toFixed(0)} KB)`);
  log('');
  log(`Open ${relative(process.cwd(), resolve(outDir, 'index.html'))} in a browser. Done in ${(result.manifest.durationMs / 1000).toFixed(1)} s.`);
}

try {
  main();
} catch (e) {
  console.error(`repoflow: unexpected error: ${(e as Error).stack || e}`);
  process.exit(2);
}
