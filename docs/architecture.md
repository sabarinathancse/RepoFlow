# RepoFlow architecture

RepoFlow has one rule: **adapters write the normalized graph, the renderer reads only the graph.** Framework knowledge lives only in `src/adapters/`.

```
src/
  cli/           argument parsing, output safety, console report
  core/          walker (ignore rules), ScanContext (file access), scan pipeline, output writer, git info
  detectors/     picks adapters: every adapter's detect(), plus generic-php / generic fallbacks
  adapters/      one folder per framework + shared/ helpers (php, python, manifests)
  parsers/       lightweight PHP / Python / JS / HTML-template / SQL parsers (no native deps)
  analyzers/     framework-agnostic passes: steps, frontend, links, data, integrations, findings, structure
  schema/        graph.ts (the normalized graph, SCHEMA_VERSION) and builder.ts (de-duplicating accumulator)
  renderer/      index.ts + summary.ts; assets/ (template, CSS) and components/ (client JS, concatenated in name order)
```

## Pipeline

1. **Walk** (`core/walker.ts`): list project files and skip default-ignored dirs, `.gitignore`, `.repoflowignore` and the output folder.
2. **Detect** (`detectors/`): each adapter returns zero or more detections, one per app root, with a confidence score and evidence.
3. **Analyze**: each selected adapter fills the `GraphBuilder` with routes, containers, handlers (steps, data access, view vars), models, tables, views, middleware, lifecycle steps, recipes and folder hints.
4. **Shared analyzers**:
   - fill forms, links and JS calls for every view
   - resolve URLs to routes
   - link handlers to tables
   - parse `*.sql` schemas and infer foreign keys
   - detect integrations
   - run the heuristic findings
5. **Render**: `renderer/` inlines CSS, the component JS and the graph (escaped for `<script>`) into `index.html`, and writes the JSON, the Markdown summary and the manifest.

## Adding a framework adapter

1. Create `src/adapters/<id>/index.ts` exporting an `Adapter`:

```ts
export const rails: Adapter = {
  id: 'rails', name: 'Ruby on Rails', language: 'Ruby',
  detect(ctx) { /* return [{ id, name, language, root, confidence, evidence, version }] when found */ },
  analyze(ctx, detection, g) {
    // g.addRoute / g.addContainer / g.addHandler / g.addModel / g.ensureTable / g.addView
    // g.addMiddleware / g.addEdge / g.lifecycle.push / g.recipes.push / g.hint(path, description)
  },
};
```

2. Register it in `src/adapters/index.ts`.
3. Add a fixture under `tests/fixtures/<id>/` and assertions in `tests/adapters.test.mjs`.

Reuse `analyzers/steps.ts` (`analyzeBody`) for handler steps whenever the language is PHP, Python or JS. Leave forms, links and AJAX calls to the shared frontend analyzer, and table usage to `linkData`.

## Node ids

| Kind | Id format |
|---|---|
| route | `route:<METHOD> <path>` (suffix ` #n` on duplicates) |
| handler | PHP `Fqcn::method`; Python `py:<module>.<qualname>`; JS `js:<file>#<name>`; closures `closure:…` / `fn:…`; plain PHP pages `page:<file>` |
| container | `controller:<Fqcn>` / `controller:py:<module>.<Class>` / `controller:js:<file>` |
| model | `model:<qualified name>` |
| table | `table:<name>` |
| view | `view:<file>` |
| script | `script:<file>` |
| middleware | `middleware:<name>` |

Edge kinds: `routes-to`, `renders`, `uses-model`, `maps-to-table`, `reads`, `writes`, `extends`, `includes`, `submits-to`, `links-to`, `calls`, `relates-to`, `protected-by`, `loads-script`, `contains`.
