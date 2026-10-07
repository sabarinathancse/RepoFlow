/**
 * Resolves URLs found in templates and scripts (form actions, links, AJAX
 * calls, redirects) to the routes that serve them.
 */
import { GraphBuilder } from '../schema/builder';
import { RouteNode } from '../schema/graph';

interface Matcher {
  route: RouteNode;
  re: RegExp;
  literalSegments: number;
}

function routeRegex(path: string): RegExp {
  const parts = path.split('/').filter(Boolean).map((seg) => {
    if (/^\{(any|path)[^}]*\}$|^\*$|^:\w+\*$|^<path:\w+>$/.test(seg)) return '.+';
    if (/^\{[^}]*\}$|^:\w+\??$|^<[^>]+>$/.test(seg) || seg.includes('{') || seg.includes('<')) {
      return seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{[^}]*\}|<[^>]+>/g, '[^/]+');
    }
    return seg.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  });
  return new RegExp('^/' + parts.join('/') + '/?$', 'i');
}

export class RouteResolver {
  private matchers: Matcher[];
  private byName = new Map<string, RouteNode>();
  private byTarget = new Map<string, RouteNode>();

  constructor(routes: Iterable<RouteNode>) {
    this.matchers = [];
    for (const r of routes) {
      if (r.path.includes('{dynamic') || r.path.startsWith('/{$')) continue;
      this.matchers.push({ route: r, re: routeRegex(r.path), literalSegments: r.path.split('/').filter((s) => s && !/[{<:*]/.test(s)).length });
      if (r.name && !this.byName.has(r.name)) this.byName.set(r.name, r);
      if (!this.byTarget.has(r.target.toLowerCase())) this.byTarget.set(r.target.toLowerCase(), r);
    }
    // most specific first
    this.matchers.sort((a, b) => b.literalSegments - a.literalSegments);
  }

  resolve(url: string, method = 'GET'): RouteNode | undefined {
    if (!url) return undefined;
    if (url.startsWith('name:')) {
      const n = url.slice(5);
      return this.byName.get(n) || this.byTarget.get(n.replace(/^\\?App\\Controllers\\/, '').toLowerCase());
    }
    if (!url.startsWith('/')) return undefined;
    const path = url.split(/[?#]/)[0].replace(/\{x\}/g, 'x');
    const m = method.toUpperCase();
    const candidates = this.matchers.filter((x) => x.re.test(path));
    return (
      candidates.find((c) => c.route.method === m)?.route ||
      candidates.find((c) => c.route.method === 'ANY')?.route ||
      (m === 'GET' ? undefined : candidates.find((c) => c.route.method === 'POST')?.route) ||
      candidates[0]?.route
    );
  }
}

export function resolveLinks(g: GraphBuilder): void {
  const resolver = new RouteResolver(g.routes.values());
  for (const v of g.views.values()) {
    for (const f of v.forms) {
      const r = resolver.resolve(f.action, f.method);
      if (r) {
        f.route = r.id;
        g.addEdge(v.id, r.id, 'submits-to');
      }
    }
    for (const l of v.links) {
      const r = resolver.resolve(l.url, 'GET');
      if (r) {
        l.route = r.id;
        g.addEdge(v.id, r.id, 'links-to');
      }
    }
    for (const c of v.calls) {
      const r = resolver.resolve(c.url, c.method);
      if (r) {
        c.route = r.id;
        g.addEdge(v.id, r.id, 'calls');
      }
    }
  }
  for (const s of g.scripts.values()) {
    for (const c of s.calls) {
      const r = resolver.resolve(c.url, c.method);
      if (r) {
        c.route = r.id;
        g.addEdge(s.id, r.id, 'calls');
      }
    }
  }
}
