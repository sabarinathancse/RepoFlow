/**
 * Framework detection: asks every adapter whether it recognizes the project
 * (or an app inside it) and picks the adapters to run.
 */
import { ScanContext } from '../core/context';
import { Adapter, Detection } from '../adapters/types';

export interface Selected {
  adapter: Adapter;
  detection: Detection;
}

const PHP_FRAMEWORKS = new Set(['codeigniter4', 'laravel']);

export function detectFrameworks(ctx: ScanContext, adapters: Adapter[], only?: string[]): Selected[] {
  const selected: Selected[] = [];
  for (const adapter of adapters) {
    if (adapter.id === 'generic' || adapter.id === 'generic-php') continue;
    if (only && only.length && !only.includes(adapter.id)) continue;
    let found: Detection[] = [];
    try {
      found = adapter.detect(ctx);
    } catch (e) {
      ctx.warn(`Detector ${adapter.id} failed: ${(e as Error).message}`);
    }
    for (const d of found) selected.push({ adapter, detection: d });
  }
  const byId = (id: string) => adapters.find((a) => a.id === id);
  const hasPhpFramework = selected.some((s) => PHP_FRAMEWORKS.has(s.adapter.id));
  const genericPhp = byId('generic-php');
  if (genericPhp && !hasPhpFramework && (!only || !only.length || only.includes('generic-php'))) {
    for (const d of genericPhp.detect(ctx)) {
      // A few stray .php files next to a Python/Node app are not a PHP site.
      const phpCount = ctx.files.filter((f) => f.ext === 'php').length;
      if (selected.length && phpCount < 3) continue;
      selected.push({ adapter: genericPhp, detection: d });
    }
  }
  if (!selected.length) {
    const generic = byId('generic');
    if (generic) for (const d of generic.detect(ctx)) selected.push({ adapter: generic, detection: d });
  }
  return selected.sort((a, b) => b.detection.confidence - a.detection.confidence);
}
