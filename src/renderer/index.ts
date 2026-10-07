/**
 * Builds the standalone repoflow/index.html: one file with the CSS, the
 * framework-agnostic explorer app and the normalized graph inlined.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectGraph } from '../schema/graph';

const ASSETS = join(__dirname, 'assets');
const COMPONENTS = join(__dirname, 'components');

/** JSON that is safe inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function renderHtml(graph: ProjectGraph, manifest: unknown): string {
  const template = readFileSync(join(ASSETS, 'template.html'), 'utf8');
  const css = readFileSync(join(ASSETS, 'explorer.css'), 'utf8');
  const js = readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => readFileSync(join(COMPONENTS, f), 'utf8'))
    .join('\n');
  const fws = graph.frameworks.filter((f) => f.id !== 'generic').map((f) => f.name);
  const description = `Interactive explorer for ${graph.project.name}${fws.length ? ` (${fws.join(', ')})` : ''}: structure, routes, code flow, data, integrations and findings.`;
  const fill: Record<string, string> = {
    VERSION: escapeHtml(graph.generator.version),
    TITLE: escapeHtml(`${graph.project.name} · Project Explorer`),
    DESCRIPTION: escapeHtml(description),
    CSS: css,
    // "</script" can never appear: scriptJson escapes "<"
    GRAPH: scriptJson(graph),
    MANIFEST: scriptJson(manifest),
    JS: js.replace(/<\/script/gi, '<\\/script'),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in fill ? fill[k] : m));
}
