/**
 * Writes the generated documentation folder (default <project>/repoflow/).
 * RepoFlow only ever writes its own four files there and refuses to take over
 * a directory it did not create.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScanResult } from './scan';
import { renderHtml } from '../renderer';
import { renderSummary } from '../renderer/summary';

export const OUTPUT_FILES = ['index.html', 'project-graph.json', 'project-summary.md', 'scan-manifest.json'];

export class OutputDirError extends Error {}

/** Throws when `outDir` holds files that RepoFlow did not generate. */
export function assertWritableOutDir(outDir: string, force: boolean): void {
  if (!existsSync(outDir) || force) return;
  const entries = readdirSync(outDir).filter((f) => f !== '.DS_Store');
  if (!entries.length) return;
  const manifestPath = join(outDir, 'scan-manifest.json');
  let ours = false;
  if (existsSync(manifestPath)) {
    try {
      ours = JSON.parse(readFileSync(manifestPath, 'utf8'))?.generator?.name === 'repoflow';
    } catch {
      ours = false;
    }
  }
  if (!ours) {
    throw new OutputDirError(
      `${outDir} already exists and was not created by RepoFlow (no scan-manifest.json). ` +
        'Choose another folder with --out, or pass --force to write RepoFlow\'s four files into it anyway.',
    );
  }
}

export interface WrittenFile {
  file: string;
  bytes: number;
  sha256: string;
}

export function writeOutputs(outDir: string, result: ScanResult, options: Record<string, unknown>): WrittenFile[] {
  mkdirSync(outDir, { recursive: true });
  const { graph, manifest } = result;
  const htmlManifest = {
    files: { listed: manifest.filesListed, parsed: manifest.filesParsed },
    durationMs: manifest.durationMs,
    excluded: manifest.excluded,
  };
  const contents: Array<[string, string]> = [
    ['index.html', renderHtml(graph, htmlManifest)],
    ['project-graph.json', JSON.stringify(graph, null, 2) + '\n'],
    ['project-summary.md', renderSummary(graph)],
  ];
  const written: WrittenFile[] = contents.map(([file, text]) => {
    writeFileSync(join(outDir, file), text);
    return { file, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
  });
  const scanManifest = {
    generator: graph.generator,
    schemaVersion: graph.schemaVersion,
    scannedAt: graph.project.scannedAt,
    project: graph.project.name,
    git: graph.project.git,
    durationMs: manifest.durationMs,
    options,
    adapters: manifest.adapters,
    files: { listed: manifest.filesListed, parsed: manifest.filesParsed, truncated: manifest.truncated },
    excluded: manifest.excluded,
    skippedDirectories: manifest.skippedDirs,
    stats: graph.stats,
    outputs: written,
    warnings: graph.warnings,
    note: 'This folder is generated documentation. Regenerate with: npx repoflow scan .',
  };
  const text = JSON.stringify(scanManifest, null, 2) + '\n';
  writeFileSync(join(outDir, 'scan-manifest.json'), text);
  written.push({ file: 'scan-manifest.json', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  return written;
}
