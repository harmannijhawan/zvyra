// App restart recovery system to detect and resume interrupted runs.
import { db, type Database } from './db';
import { emit } from './bus';
import type { Run, Task } from '../../shared/types';

/**
 * Crash/exit recovery: a run left "running" or "paused" has no live worker any more. Mark it interrupted and move
 * every non-terminal task to CANCELLED with the reason, so nothing shows as running forever. Completed work and
 * checkpoints are untouched; an explicit resume re-queues interrupted tasks (core/invalidation.ts).
 */
export function markInterruptedRuns(d: Database = db()): number {
  const runs = d.list<Run>('runs', "json_extract(data, '$.status') IN ('running', 'paused')");
  for (const r of runs) {
    r.status = 'cancelled'; r.endedAt = r.endedAt ?? Date.now(); r.summary = 'Interrupted: SWARM was closed while this run was active';
    for (const g of r.gates) if (g.status === 'running' || g.status === 'pending') { g.status = 'skipped'; g.detail = 'Interrupted'; }
    if (r.progress) { r.progress.phase = 'blocked'; r.progress.currentTask = null; r.progress.blocker = { text: 'Interrupted: SWARM was closed while this run was active. Resume to continue from the checkpoint.', category: 'internal', ts: Date.now() }; }
    d.put('runs', r.id, r, { project_id: r.projectId, started_at: r.startedAt });
    for (const t of d.list<Task>('tasks', 'run_id = ?', [r.id])) {
      if (!['completed', 'failed', 'skipped', 'cancelled'].includes(t.status)) d.put('tasks', t.id, { ...t, status: 'cancelled', error: t.status === 'running' || t.status === 'verifying' ? 'Interrupted while running (application exit)' : t.error, endedAt: t.endedAt ?? Date.now() }, { run_id: t.runId, created_at: t.createdAt });
    }
  }
  return runs.length;
}

export interface InterruptedRun {
  runId: string;
  projectId: string;
  projectName: string;
  objective: string;
  startedAt: number;
  interruptedAt: number;
  completedTasks: number;
  totalTasks: number;
}

/**
 * Detect runs that were interrupted (status = 'running' but process not active).
 * Called at application startup.
 */
export function detectInterruptedRuns(): InterruptedRun[] {
  try {
    // Find all runs with status 'running' — status is stored inside JSON data column
    const runningRuns = db().list<Run>('runs', "json_extract(data, '$.status') = 'running'", [], 'started_at DESC');
    
    if (runningRuns.length === 0) {
      return [];
    }
    
    const interrupted: InterruptedRun[] = [];
    
    for (const run of runningRuns) {
      // Get project info
      const project = db().get<{ id: string; name: string }>('projects', run.projectId);
      if (!project) continue;
      
      // Get task stats
      const tasks = db().list('tasks', 'run_id = ?', [run.id], 'created_at ASC');
      const completedTasks = (tasks as { status: string }[]).filter((t) => t.status === 'completed').length;
      
      interrupted.push({
        runId: run.id,
        projectId: run.projectId,
        projectName: project.name,
        objective: run.objective,
        startedAt: run.startedAt,
        interruptedAt: Date.now(),
        completedTasks,
        totalTasks: tasks.length,
      });
      
      // Mark run as cancelled (interrupted)
      run.status = 'cancelled';
      run.summary = 'Interrupted by application restart';
      run.endedAt = Date.now();
      db().put('runs', run.id, run, { project_id: run.projectId, started_at: run.startedAt });
      
      emit('RUN_CANCELLED', 'Run interrupted by application restart', 
        { projectId: run.projectId, runId: run.id }, 'warning', { run });
    }
    
    return interrupted;
  } catch (err) {
    console.error('[recovery] Failed to detect interrupted runs:', err);
    return [];
  }
}

/**
 * Clean up stale runs that have been in 'running' state for too long (>24 hours).
 */
export function cleanupStaleRuns(): number {
  try {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const staleRuns = db().list<Run>('runs', "json_extract(data, '$.status') = 'running' AND started_at < ?", [oneDayAgo], 'started_at DESC');
    
    for (const run of staleRuns) {
      run.status = 'failed';
      run.summary = 'Run timed out (stale for >24 hours)';
      run.endedAt = Date.now();
      db().put('runs', run.id, run, { project_id: run.projectId, started_at: run.startedAt });
      
      emit('RUN_FAILED', 'Run marked as failed (stale)', 
        { projectId: run.projectId, runId: run.id }, 'error', { run });
    }
    
    return staleRuns.length;
  } catch (err) {
    console.error('[recovery] Failed to cleanup stale runs:', err);
    return 0;
  }
}

/**
 * Get a summary of interrupted runs for display to the user.
 */
export function getInterruptedRunsSummary(interrupted: InterruptedRun[]): string {
  if (interrupted.length === 0) {
    return '';
  }
  
  if (interrupted.length === 1) {
    const run = interrupted[0];
    return `${run.projectName}: ${run.completedTasks}/${run.totalTasks} tasks completed before interruption`;
  }
  
  return `${interrupted.length} runs were interrupted: ${interrupted.map(r => r.projectName).join(', ')}`;
}
