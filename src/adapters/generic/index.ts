/**
 * Fallback when no framework is recognized: the report still gets the
 * folder tree, languages, dependencies, integrations, SQL schema and findings.
 */
import { Adapter } from '../types';

export const generic: Adapter = {
  id: 'generic',
  name: 'Generic project',
  language: 'mixed',
  detect() {
    return [{ id: 'generic', name: 'Generic project', language: 'mixed', root: '.', confidence: 0.1, evidence: ['no supported framework detected'] }];
  },
  analyze(ctx, _det, g) {
    const has = (re: RegExp) => ctx.files.some((f) => re.test(f.path));
    g.lifecycle.push(
      { id: 'gen-entry', title: 'Entry points', subtitle: 'scripts, binaries, servers', detail: has(/(^|\/)(main|index|app|server|cli)\.(py|js|ts|php)$/) ? 'Look for main/index/app/server files: they are where execution starts.' : 'No conventional entry file was found; check the README and manifest scripts.' },
      { id: 'gen-code', title: 'Source modules', subtitle: 'see Folder structure', detail: 'No framework adapter matched, so request routing is not mapped. The folder tree, dependencies and integrations are still analyzed.' },
      { id: 'gen-data', title: 'Data', subtitle: 'SQL schema files', detail: 'Tables are read from any .sql schema files in the project.' },
    );
  },
};
