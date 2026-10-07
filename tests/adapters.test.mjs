// End-to-end adapter tests: scan each fixture project and check the normalized graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanProject } = require('../dist/index.js');
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function scan(name) {
  const out = mkdtempSync(join(tmpdir(), 'repoflow-'));
  return scanProject({ root: join(FIX, name), outDir: out }).graph;
}
const route = (g, method, path) => g.routes.find((r) => r.method === method && r.path === path);
const handler = (g, id) => g.handlers.find((h) => h.id === id);

test('codeigniter4: routes, groups, filters and resources', () => {
  const g = scan('codeigniter4');
  assert.deepEqual(g.frameworks.map((f) => f.id), ['codeigniter4']);
  const store = route(g, 'POST', '/admin/products/store');
  assert.ok(store, 'grouped route');
  assert.deepEqual(store.middleware, ['auth']);
  assert.equal(store.handler, 'App\\Controllers\\Admin\\ProductController::store');
  assert.ok(route(g, 'GET', '/contact') && route(g, 'POST', '/contact'), 'match() expands methods');
  assert.ok(route(g, 'GET', '/api/orders/{id}')?.handler, 'resource() route resolves');
  assert.ok(!g.routes.some((r) => r.path === '/old'), 'commented-out route ignored');
});

test('codeigniter4: handler steps, data access and view variables', () => {
  const g = scan('codeigniter4');
  const index = handler(g, 'App\\Controllers\\Home::index');
  assert.deepEqual(index.tables, ['products']);
  assert.deepEqual(index.views[0].vars.sort(), ['products', 'title']);
  const del = handler(g, 'App\\Controllers\\Admin\\ProductController::delete');
  assert.ok(del.data.some((d) => d.op === 'delete' && d.table === 'products'), 'model alias from constructor');
  assert.ok(del.tables.includes('product_images'), 'raw SQL table');
  const contact = handler(g, 'App\\Controllers\\Home::contact');
  assert.ok(contact.steps.some((s) => s.kind === 'validate'));
  assert.ok(contact.responses.includes('redirect'));
});

test('codeigniter4: forms, AJAX calls and links resolve to routes', () => {
  const g = scan('codeigniter4');
  const view = g.views.find((v) => v.name === 'admin/products');
  assert.equal(view.forms[0].route, 'route:POST /admin/products/store');
  assert.ok(view.calls.every((c) => c.route), 'fetch(CONST) and $.ajax resolve');
  assert.ok(view.links.some((l) => l.route === 'route:GET /admin/products/delete/{num}'), 'concatenated base_url link');
  assert.equal(g.views.find((v) => v.name === 'home').extends[0], 'view:app/Views/layouts/main.php');
  assert.ok(g.scripts.some((s) => s.calls.some((c) => c.route === 'route:GET /api/orders')));
});

test('codeigniter4: findings', () => {
  const g = scan('codeigniter4');
  const rules = g.findings.map((f) => f.rule);
  for (const r of ['ci4-csrf-disabled', 'route-missing-method', 'get-deletes', 'admin-route-unguarded', 'sql-interpolation']) assert.ok(rules.includes(r), r);
  assert.ok(!g.findings.some((f) => f.rule === 'hardcoded-secret'), 'validation rules are not secrets');
  const t = g.tables.find((x) => x.name === 'products');
  assert.ok(t.foreignKeys.some((fk) => fk.column === 'category_id' && fk.inferred), 'inferred relation');
});

test('generic-php: pages, includes, SQL schema', () => {
  const g = scan('generic-php');
  assert.equal(g.frameworks[0].id, 'generic-php');
  assert.ok(route(g, 'POST', '/comment.php'));
  assert.ok(!g.routes.some((r) => r.path.includes('includes/')), 'includes are not pages');
  const comments = g.tables.find((t) => t.name === 'comments');
  assert.deepEqual(comments.foreignKeys, [{ column: 'post_id', references: 'posts.id', inferred: false }]);
  assert.ok(g.findings.some((f) => f.rule === 'sql-interpolation' && f.file === 'post.php'));
});

test('laravel: route groups, resources, closures, Blade and migrations', () => {
  const g = scan('laravel');
  const store = route(g, 'POST', '/admin/posts');
  assert.deepEqual(store.middleware, ['web', 'auth', 'verified']);
  assert.equal(store.name, 'admin.posts.store');
  assert.ok(!route(g, 'GET', '/admin/posts'), 'except([index]) honoured');
  assert.deepEqual(route(g, 'GET', '/api/posts').middleware, ['api', 'auth:sanctum']);
  assert.equal(route(g, 'GET', '/').target, 'Closure');
  const posts = g.tables.find((t) => t.name === 'posts');
  assert.ok(posts.foreignKeys.some((f) => f.references === 'users.id' && !f.inferred));
  assert.ok(g.models.find((m) => m.name === 'Post').relations.some((r) => r.kind === 'belongsTo'));
  assert.equal(g.views.find((v) => v.name === 'posts.create').forms[0].route, 'route:POST /admin/posts');
  assert.ok(!g.findings.some((f) => f.rule === 'unreferenced-views'), 'closure-rendered view counts as used');
});

test('django: include(), namespaces, CBVs, DRF routers, templates', () => {
  const g = scan('django');
  assert.deepEqual(route(g, 'GET', '/shop/{pk}/edit').middleware, ['login_required']);
  assert.ok(route(g, 'POST', '/shop/{pk}/edit'), 'request.method == POST branch');
  assert.ok(route(g, 'DELETE', '/shop/api/products/{pk}')?.handler, 'router.register viewset');
  assert.ok(route(g, 'GET', '/shop/categories')?.handler, 'class-based view');
  assert.ok(g.tables.find((t) => t.name === 'products').foreignKeys.some((f) => f.references === 'shop_category.id'));
  assert.equal(g.views.find((v) => v.name === 'shop/list.html').links[0].route, 'route:GET /shop/{pk}/edit');
  assert.ok(g.findings.some((f) => f.rule === 'django-debug'));
});

test('fastapi: include_router prefixes, dependencies, SQLAlchemy', () => {
  const g = scan('fastapi');
  const create = route(g, 'POST', '/api/items');
  assert.ok(create, 'app prefix + router prefix');
  assert.deepEqual(create.middleware, ['get_current_user']);
  assert.ok(handler(g, create.handler).tables.includes('items'));
  assert.ok(g.tables.find((t) => t.name === 'items').foreignKeys.some((f) => f.references === 'owners.id'));
  assert.ok(g.models.some((m) => m.kind === 'schema' && m.name === 'ItemIn'));
});

test('flask: blueprints and url_for', () => {
  const g = scan('flask');
  assert.ok(route(g, 'POST', '/blog/new'));
  assert.equal(route(g, 'GET', '/blog/api').name, 'blog.list_posts');
  assert.equal(g.views[0].links[0].route, 'route:GET /blog/new');
  assert.ok(g.findings.some((f) => f.rule === 'flask-debug'));
});

test('express: mounted routers, controllers, middleware, mongoose', () => {
  const g = scan('express');
  const del = route(g, 'DELETE', '/api/todos/{id}');
  assert.deepEqual(del.middleware, ['requireAuth']);
  const h = handler(g, del.handler);
  assert.equal(h.name, 'remove');
  assert.ok(h.data.some((d) => d.op === 'delete'));
  assert.ok(g.middleware.some((m) => m.kind === 'global' && m.name === 'cors()'));
  assert.equal(g.models[0].name, 'Todo');
  assert.equal(g.scripts[0].calls[0].route, 'route:GET /api/todos');
});
