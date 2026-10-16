// Central event bus. Every meaningful operation emits a structured event which is
// (1) persisted to SQLite in batches, (2) streamed to the renderer over IPC in
// batches, and (3) delivered to in-process subscribers.
import { recordTiming } from './performance';
import { EventEmitter } from 'node:events';
import type { AgentRole, EventType, LogLevel, SwarmEvent } from '../../shared/types';
import { db } from './db';
import { redact, uid } from './util';
import { optimizeEventList } from './eventCompaction';

type Sink = (events: SwarmEvent[]) => void;
type Channel = (channel: string, payload: unknown) => void;

class Bus extends EventEmitter {
  private pendingDb: SwarmEvent[] = [];
  private pendingUi: SwarmEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sink: Sink | null = null;
  private channel: Channel | null = null;
  persist = true;
  debug = false;

  attach(sink: Sink, channel: Channel) { this.sink = sink; this.channel = channel; }

  emitEvent(e: Omit<SwarmEvent, 'id' | 'ts' | 'level' | 'projectId' | 'runId' | 'taskId' | 'agent'> & Partial<SwarmEvent>): SwarmEvent {
    const ev: SwarmEvent = {
      id: e.id ?? uid('ev_'),
      ts: e.ts ?? Date.now(),
      type: e.type,
      level: e.level ?? 'info',
      projectId: e.projectId ?? null,
      runId: e.runId ?? null,
      taskId: e.taskId ?? null,
      agent: e.agent ?? null,
      message: redact(e.message),
      data: e.data,
    };
    const transient = ev.type === 'AGENT_STREAM' || ev.type === 'COMMAND_OUTPUT';
    // State synchronization must not depend on the user's diagnostic log level.
    const stateChange = ev.type === 'AGENT_STATUS' || ev.type === 'TASK_CREATED' || ev.type === 'TASK_UPDATED';
    if (!transient && this.persist && (ev.level !== 'debug' || this.debug || stateChange)) this.pendingDb.push(ev);
    if (ev.level !== 'debug' || this.debug || transient || stateChange) this.pendingUi.push(ev);
    super.emit('event', ev);
    this.schedule();
    return ev;
  }

  /** Send a non-event message to the renderer immediately (state snapshots). */
  send(channel: string, payload: unknown) { this.channel?.(channel, payload); super.emit(channel, payload); }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    this.timer = null;
    const toDb = this.pendingDb; this.pendingDb = [];
    const toUi = this.pendingUi; this.pendingUi = [];
    if (toDb.length) {
      try {
        const d = db();
        const stmt = d.prepare(`INSERT OR IGNORE INTO events (id, ts, project_id, run_id, task_id, type, level, agent, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        d.tx(() => {
          for (const e of toDb) stmt.run(e.id, e.ts, e.projectId, e.runId, e.taskId, e.type, e.level, e.agent, e.message, e.data ? redact(JSON.stringify(e.data)) : null);
        });
      } catch (err) {
        console.error('[bus] failed to persist events', err);
      }
    }
    if (toUi.length) { this.sink?.(toUi); for (const ev of toUi) recordTiming('ui', Date.now() - ev.ts, ev.runId ?? undefined); }
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

export interface EventScope { projectId?: string | null; runId?: string | null; taskId?: string | null; agent?: AgentRole | null }

export function emit(type: EventType, message: string, scope: EventScope = {}, level: LogLevel = 'info', data?: Record<string, unknown>) {
  return bus.emitEvent({ type, message, level, data, ...scope });
}

export function queryEvents(opts: { runId?: string; projectId?: string; limit?: number; before?: number; types?: string[]; compact?: boolean }): SwarmEvent[] {
  const where: string[] = []; const params: (string | number)[] = [];
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.before) { where.push('ts < ?'); params.push(opts.before); }
  if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(',')})`); params.push(...opts.types); }
  const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${Math.min(opts.limit ?? 2000, 20000)}`;
  const rows = db().prepare(sql).all(...params) as Record<string, unknown>[];
  const events = rows.reverse().map((r) => ({
    id: r.id as string, ts: r.ts as number, type: r.type as EventType, level: r.level as LogLevel,
    projectId: (r.project_id as string) ?? null, runId: (r.run_id as string) ?? null, taskId: (r.task_id as string) ?? null,
    agent: (r.agent as AgentRole) ?? null, message: r.message as string, data: r.data ? JSON.parse(r.data as string) : undefined,
  }));
  
  // Apply compaction if requested and event count is high
  if (opts.compact && events.length > 300) {
    return optimizeEventList(events, opts.limit ?? 300);
  }
  
  return events;
}
