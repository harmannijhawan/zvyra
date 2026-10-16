import { randomUUID } from 'node:crypto';
import { db } from '../../SWARM/electron/core/db';
export interface Memory { id: string; text: string; projectId?: string; updatedAt: number }
export interface Automation { id: string; projectId: string; instruction: string; at: number; state: 'scheduled' | 'dispatching' | 'started' | 'cancelled' | 'failed' | 'needs_review'; runId?: string; error?: string }
export class Store {
  constructor() {
    db().db.exec('CREATE TABLE IF NOT EXISTS zvyra_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
    for (const item of this.list<Automation>('automation')) if (item.state === 'dispatching') this.put('automation', { ...item, state: 'needs_review' });
  }
  list<T>(kind: string): T[] { return db().prepare('SELECT data FROM zvyra_records WHERE kind=? ORDER BY rowid DESC LIMIT 1000').all(kind).map(r => JSON.parse(String(r.data))); }
  put<T extends { id: string }>(kind: string, item: T): T { db().prepare('INSERT INTO zvyra_records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, item.id, JSON.stringify(item)); return item; }
  remove(kind: string, id: string) { return Number(db().prepare('DELETE FROM zvyra_records WHERE kind=? AND id=?').run(kind, id).changes) > 0; }
  clear(kind: string) { db().prepare('DELETE FROM zvyra_records WHERE kind=?').run(kind); return true; }
  memory(input: { id?: string; text: string; projectId?: string }): Memory {
    const existing = this.list<Memory>('memory').find(m => m.text === input.text && m.projectId === input.projectId);
    return this.put('memory', { ...input, id: input.id ?? existing?.id ?? randomUUID(), updatedAt: Date.now() });
  }
}
