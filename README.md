# RepoFlow

Generate an interactive explorer for an existing project from its source code. The project can be PHP, Python or Node.js.

```bash
npx -y repoflow scan .
```

Run it from the root of the project. RepoFlow is a Node.js CLI, but the project it analyzes doesn't need Node.js, a `package.json` or any RepoFlow package. PHP and Python projects work through `npx`. The scan is read-only: RepoFlow never executes project code and makes no network requests.

## Output

```
<your-project>/repoflow/
    index.html            standalone interactive explorer (open it in a browser)
    project-graph.json    the normalized project graph
    project-summary.md    a Markdown digest for reviews and chat
    scan-manifest.json    scan metadata (version, adapters, files, hashes, warnings)
```

`repoflow/` holds generated documentation, not RepoFlow source code. It's excluded from later scans automatically. RepoFlow writes only these four files. It refuses to write into an existing `repoflow/` folder it did not create unless you pass `--force`.

`index.html` is a single self-contained file with the CSS, JavaScript and data inlined. It works offline from `file://`. It contains:

| Section | What it shows |
|---|---|
| Overview | Frameworks, languages, dependencies, and a clickable layer map (client → routing → middleware → handlers → data → external services) |
| How a request works | The framework's request lifecycle, response patterns and every middleware / filter |
| Folder structure | Expandable tree with descriptions and secret / entry-point tags |
| Routes explorer | Every method + path with middleware, handler, tables and response type. Click a row for its execution path |
| Code explorer | Controller → handler → step-by-step flow with line numbers, data access, and the variables passed to each view. A view inspector shows layouts, forms, links and AJAX calls, and which route each one reaches |
| Data & models | Tables, columns, declared and inferred relationships (diagram), and which handlers read or write each table |
| Views & JavaScript | Layouts, templates, client scripts and every `fetch` / axios / jQuery / XHR call, resolved to routes |
| Integrations | Payment, email, SMS, storage, auth, AI, analytics and data stores, with source evidence (secrets redacted) |
| Findings | Heuristic security and maintainability checks to verify (masked secrets, SQL built from variables, unguarded admin routes, GET deletes, missing CSRF, routes pointing to missing methods…) |
| Connections | Pick any node and walk what it depends on and what depends on it (impact analysis) |
| How to change things | Framework-specific recipes that point at the project's own files |

## Supported frameworks

| Adapter id | Framework | Detected from |
|---|---|---|
| `codeigniter4` | CodeIgniter 4 (incl. `app/Modules/*`) | `app/Config/Routes.php`, `composer.json`, `spark` |
| `laravel` | Laravel | `artisan`, `composer.json` |
| `django` | Django + Django REST Framework | `manage.py` |
| `fastapi` | FastAPI | `FastAPI()` in a module importing fastapi |
| `flask` | Flask | `Flask(__name__)` |
| `express` | Express | `express` in a `package.json` |
| `generic-php` | Plain PHP sites | `.php` files, when no PHP framework matches |
| `generic` | Anything else | Fallback: structure, dependencies, SQL schema, integrations, findings |

A repository can contain several apps, for example a CodeIgniter site with a Django service in a subfolder. RepoFlow runs one adapter per app it detects and merges the results into one graph. Run `npx repoflow adapters` to list them.

## Install per project

```bash
npm install --save-dev repoflow
npx repoflow scan .
```

## Options

```
repoflow scan [path]
  -o, --out <dir>         output directory (default: <path>/repoflow)
  -f, --framework <ids>   only run these adapters, e.g. --framework laravel
      --no-gitignore      also scan files that .gitignore excludes
      --max-files <n>     file limit (default 25000)
      --force             write into an existing folder RepoFlow did not create
  -q, --quiet
```

Files ignored by `.gitignore` and `.repoflowignore` are skipped. So are dependencies (`vendor/`, `node_modules/`, virtualenvs), build output and runtime folders (`writable/`, `storage/framework`, uploads).

## How it works

```
your project
  → file walker (ignore rules, repoflow/ excluded)
  → framework detector (each adapter inspects the project)
  → adapter(s): CodeIgniter 4 · Laravel · Django · FastAPI · Flask · Express · plain PHP
  → shared analyzers: templates & JS calls, link resolution, data, integrations, findings, folders
  → normalized project graph (src/schema/graph.ts)
  → renderer: repoflow/index.html + project-graph.json + project-summary.md + scan-manifest.json
```

Adapters only write the normalized graph. The renderer only reads it and knows nothing about frameworks. See [docs/architecture.md](docs/architecture.md) to add an adapter.

## Limits

This is static analysis. Routes registered dynamically (database-driven or built in loops) can be missed. Steps and view variables come from code patterns. Relationships marked as inferred come from `*_id` column names. Findings are leads to verify, not proof of a vulnerability.

## Development

```bash
npm install
npm test          # builds, then runs the parser, CLI and per-framework fixture tests
node dist/cli/index.js scan tests/fixtures/laravel --out /tmp/laravel-report
```
