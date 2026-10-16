// SQLite persistence using Node's built-in `node:sqlite` (no native build step).
// Tables store indexed columns plus a JSON `data` column for the full document.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

type Row = Record<string, unknown>;

const TABLES: Record<string, string[]> = {
  conversations: ['updated_at INTEGER'],
  workspace_events: ['sequence INTEGER', 'conversation_id TEXT', 'run_id TEXT', 'project_id TEXT', 'ts INTEGER'],
  projects: ['updated_at INTEGER'],
  runs: ['project_id TEXT', 'started_at INTEGER'],
  tasks: ['run_id TEXT', 'created_at INTEGER'],
  messages: ['run_id TEXT', 'ts INTEGER'],
  sources: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER'],
  findings: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER'],
  file_changes: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER', 'path TEXT'],
  commands: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER'],
  screenshots: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER'],
  usage: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER', 'provider_id TEXT', 'model_id TEXT'],
  models: ['provider_id TEXT'],
  providers: [],
  notifications: ['ts INTEGER'],
  artifacts: ['project_id TEXT', 'run_id TEXT', 'ts INTEGER'],
  visual_issues: ['run_id TEXT', 'ts INTEGER'],
  // Live Run Chat
  run_chat_turns: ['run_id TEXT', 'conversation_id TEXT', 'ts INTEGER'],
  graph_versions: ['run_id TEXT', 'ts INTEGER'],
};

export type Table = keyof typeof TABLES;

export class Database {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, value BLOB NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, value TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, project_id TEXT, run_id TEXT, task_id TEXT,
      type TEXT NOT NULL, level TEXT NOT NULL, agent TEXT, message TEXT NOT NULL, data TEXT)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, ts)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, ts)`);
    for (const [name, cols] of Object.entries(TABLES)) {
      const extra = cols.length ? ', ' + cols.join(', ') : '';
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY${extra}, data TEXT NOT NULL)`);
      for (const c of cols) {
        const col = c.split(' ')[0];
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_${col} ON ${name}(${col})`);
      }
    }
    const version = Number(this.kvGet('schema_version') ?? 0);
    if (version < 1) this.kvSet('schema_version', '1');
  }

  prepare(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  kvGet(key: string): string | null {
    const r = this.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return (r?.value as string) ?? null;
  }
  kvSet(key: string, value: string) {
    this.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Upsert a document. `cols` maps indexed column names to values. */
  put(table: Table, id: string, doc: unknown, cols: Record<string, string | number | null> = {}) {
    const names = Object.keys(cols);
    const sql = `INSERT INTO ${table} (id${names.map((n) => ', ' + n).join('')}, data) VALUES (?${names.map(() => ', ?').join('')}, ?)
      ON CONFLICT(id) DO UPDATE SET ${[...names.map((n) => `${n} = excluded.${n}`), 'data = excluded.data'].join(', ')}`;
    this.prepare(sql).run(id, ...names.map((n) => cols[n]), JSON.stringify(doc));
  }

  get<T>(table: Table, id: string): T | null {
    const r = this.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? (JSON.parse(r.data as string) as T) : null;
  }

  list<T>(table: Table, where = '', params: (string | number | null)[] = [], order = '', limit?: number): T[] {
    const sql = `SELECT data FROM ${table}${where ? ' WHERE ' + where : ''}${order ? ' ORDER BY ' + order : ''}${limit ? ' LIMIT ' + Math.floor(limit) : ''}`;
    return (this.prepare(sql).all(...params) as Row[]).map((r) => JSON.parse(r.data as string) as T);
  }

  delete(table: Table, where: string, params: (string | number | null)[]) {
    this.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
  }

  cacheGet(key: string, maxAgeMs: number): string | null {
    const r = this.prepare('SELECT ts, value FROM cache WHERE key = ?').get(key) as Row | undefined;
    if (!r) return null;
    if (Date.now() - Number(r.ts) > maxAgeMs) return null;
    return r.value as string;
  }
  cacheSet(key: string, value: string) {
    this.prepare('INSERT INTO cache(key, ts, value) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, value = excluded.value').run(key, Date.now(), value);
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

let instance: Database | null = null;
export function initDb(file: string): Database { instance = new Database(file); return instance; }
export function db(): Database {
  if (!instance) throw new Error('Database not initialised');
  return instance;
}
