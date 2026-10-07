/**
 * Connects handlers, models and tables: who reads/writes which table,
 * SQL schema files, and inferred relationships between tables.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { parseCreateTables } from '../parsers/sql';
import { plural, singular } from '../utils/text';

/** Tables from *.sql files (schema dumps, migrations written in SQL). */
export function analyzeSqlFiles(ctx: ScanContext, g: GraphBuilder): void {
  for (const f of ctx.files) {
    if (f.ext !== 'sql' || f.size > 8_000_000) continue;
    const src = ctx.read(f.path) ?? readLarge(ctx, f.path);
    if (!src) continue;
    for (const t of parseCreateTables(src)) {
      const node = g.ensureTable(t.name);
      if (!node.columns.length) node.columns = t.columns;
      for (const fk of t.foreignKeys) if (!node.foreignKeys.some((x) => x.column === fk.column)) node.foreignKeys.push(fk);
      node.sources.push({ file: f.path, line: t.line, kind: 'sql' });
    }
  }
}

function readLarge(ctx: ScanContext, path: string): string | null {
  try {
    const text = readFileSync(join(ctx.root, path), 'utf8');
    // keep only the DDL; dumps are mostly INSERT data
    return text.split(/;\s*\n/).filter((s) => /CREATE\s+TABLE|ALTER\s+TABLE/i.test(s)).join(';\n') + ';';
  } catch {
    return null;
  }
}

export function linkData(g: GraphBuilder): void {
  // model ↔ table
  for (const m of g.models.values()) if (m.table) g.addEdge(m.id, `table:${m.table}`, 'maps-to-table');

  for (const h of g.handlers.values()) {
    for (const mid of h.models) {
      const model = g.models.get(mid);
      if (!model) continue;
      if (!model.usedBy.includes(h.id)) model.usedBy.push(h.id);
      g.addEdge(h.id, mid, 'uses-model');
    }
    for (const d of h.data) {
      const tableName = d.table || (d.model ? g.models.get(d.model)?.table : undefined);
      if (!tableName) continue;
      const t = g.ensureTable(tableName);
      if (!t.sources.length) t.sources.push({ file: h.file, line: d.line, kind: 'query' });
      if (d.op === 'read' || d.op === 'access') {
        if (!t.readBy.includes(h.id)) t.readBy.push(h.id);
        g.addEdge(h.id, t.id, 'reads');
      } else {
        if (!t.writtenBy.includes(h.id)) t.writtenBy.push(h.id);
        g.addEdge(h.id, t.id, 'writes');
      }
      if (!h.tables.includes(tableName)) h.tables.push(tableName);
    }
  }

  // explicit model relations → edges
  for (const m of g.models.values()) {
    for (const r of m.relations) {
      const target = g.models.get(r.target) ? r.target : Array.from(g.models.values()).find((x) => x.name === r.target)?.id;
      if (target) {
        r.target = target;
        g.addEdge(m.id, target, 'relates-to');
      }
    }
  }

  // explicit + inferred foreign keys between tables
  const names = new Set(Array.from(g.tables.values()).map((t) => t.name));
  const findTable = (base: string): string | undefined => {
    for (const cand of [plural(base), base, singular(base), `${base}s`, `tbl_${base}`, `tbl_${plural(base)}`]) if (names.has(cand)) return cand;
    return undefined;
  };
  for (const t of g.tables.values()) {
    for (const c of t.columns) {
      if (t.foreignKeys.some((fk) => fk.column === c.name)) continue;
      const m = /^(\w+?)_?id$/i.exec(c.name);
      if (!m || c.primary || c.name.toLowerCase() === 'id') continue;
      const target = findTable(m[1].toLowerCase());
      if (target && target !== t.name) t.foreignKeys.push({ column: c.name, references: `${target}.id`, inferred: true });
    }
    for (const fk of t.foreignKeys) {
      const target = fk.references.split('.')[0];
      if (names.has(target)) g.addEdge(t.id, `table:${target}`, 'relates-to');
    }
  }
}
