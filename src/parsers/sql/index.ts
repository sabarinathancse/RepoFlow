/** Extracts table definitions and table references from SQL text. */
import { matchBracket, splitTopLevel } from '../common';
import { FieldInfo, ForeignKey } from '../../schema/graph';
import { LineIndex } from '../../utils/text';

export interface SqlTable {
  name: string;
  columns: FieldInfo[];
  foreignKeys: ForeignKey[];
  line: number;
}

const ID = '[`"\\[]?(\\w+)[`"\\]]?';
const CONSTRAINT_RE = /^(PRIMARY\s+KEY|KEY|INDEX|UNIQUE|CONSTRAINT|FOREIGN\s+KEY|CHECK|FULLTEXT|SPATIAL)\b/i;

export function parseCreateTables(sql: string): SqlTable[] {
  const out: SqlTable[] = [];
  const lines = new LineIndex(sql);
  const re = new RegExp(`CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${ID}\\.)?${ID}\\s*\\(`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(sql, open, `'"`);
    if (close < 0) break;
    const table: SqlTable = { name: m[2], columns: [], foreignKeys: [], line: lines.lineAt(m.index) };
    const primary = new Set<string>();
    for (const def of splitTopLevel(sql.slice(open + 1, close), ',', `'"`)) {
      const d = def.trim();
      const fk = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"\[]?(?:\w+[`"\]]?\.[`"\[]?)?(\w+)[`"\]]?\s*\(([^)]+)\)/i.exec(d);
      if (fk) {
        table.foreignKeys.push({ column: clean(fk[1]), references: `${fk[2]}.${clean(fk[3])}`, inferred: false });
        continue;
      }
      const pk = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(d);
      if (pk) {
        pk[1].split(',').forEach((c) => primary.add(clean(c)));
        continue;
      }
      if (CONSTRAINT_RE.test(d)) continue;
      const col = new RegExp(`^${ID}\\s+(\\w+(?:\\s*\\([^)]*\\))?)([\\s\\S]*)$`).exec(d);
      if (!col) continue;
      const rest = col[3] || '';
      const field: FieldInfo = { name: col[1], type: col[2].replace(/\s+/g, '').toLowerCase() };
      if (/NOT\s+NULL/i.test(rest)) field.nullable = false;
      else if (/\bNULL\b/i.test(rest)) field.nullable = true;
      if (/PRIMARY\s+KEY/i.test(rest)) field.primary = true;
      const ref = /REFERENCES\s+[`"]?(\w+)[`"]?\s*\(\s*[`"]?(\w+)/i.exec(rest);
      if (ref) {
        field.references = `${ref[1]}.${ref[2]}`;
        table.foreignKeys.push({ column: field.name, references: field.references, inferred: false });
      }
      table.columns.push(field);
    }
    for (const c of table.columns) if (primary.has(c.name)) c.primary = true;
    out.push(table);
    re.lastIndex = close;
  }
  // ALTER TABLE x ADD [CONSTRAINT y] FOREIGN KEY (a) REFERENCES t (b)
  const alter = /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?([\s\S]*?);/gi;
  while ((m = alter.exec(sql))) {
    const t = out.find((x) => x.name === m![1]);
    if (!t) continue;
    const fkRe = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)/gi;
    let f: RegExpExecArray | null;
    while ((f = fkRe.exec(m[2]))) t.foreignKeys.push({ column: clean(f[1]), references: `${f[2]}.${clean(f[3])}`, inferred: false });
  }
  return out;
}

function clean(s: string): string {
  return s.replace(/[`"\[\]\s]/g, '').split(',')[0];
}

export interface SqlRef {
  table: string;
  op: 'read' | 'write' | 'delete';
}

const SQL_KEYWORDS = new Set(['select', 'where', 'set', 'values', 'on', 'as', 'the', 'a', 'an', 'and', 'or', 'from', 'into', 'join', 'dual', 'lateral', 'information_schema']);

/** Tables referenced by a SQL statement (or a string that looks like one). */
export function sqlTableRefs(sql: string): SqlRef[] {
  const out: SqlRef[] = [];
  const add = (table: string, op: SqlRef['op']) => {
    const t = table.replace(/[`"\[\]]/g, '').split('.').pop()!;
    if (!t || SQL_KEYWORDS.has(t.toLowerCase()) || /^\d/.test(t) || t.length < 2) return;
    if (!out.some((r) => r.table === t && r.op === op)) out.push({ table: t, op });
  };
  if (!/\b(select|insert|update|delete|replace)\b/i.test(sql)) return out;
  let m: RegExpExecArray | null;
  const del = /\bDELETE\s+FROM\s+([`"\[]?[\w.]+)/gi;
  while ((m = del.exec(sql))) add(m[1], 'delete');
  const ins = /\b(?:INSERT|REPLACE)\s+(?:IGNORE\s+)?INTO\s+([`"\[]?[\w.]+)/gi;
  while ((m = ins.exec(sql))) add(m[1], 'write');
  const upd = /\bUPDATE\s+([`"\[]?[\w.]+)\s+SET\b/gi;
  while ((m = upd.exec(sql))) add(m[1], 'write');
  const rd = /\b(?:FROM|JOIN)\s+([`"\[]?[\w.]+)/gi;
  while ((m = rd.exec(sql))) {
    if (/DELETE\s+$/i.test(sql.slice(Math.max(0, m.index - 8), m.index))) continue;
    add(m[1], 'read');
  }
  return out;
}
