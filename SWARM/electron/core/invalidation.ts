// Task invalidation engine for dependency-aware resumption.
// Determines which tasks need re-execution and which can be safely skipped.
import type { Task } from '../../shared/types';
import type { ArchitectureSpec } from '../agents/runContext';
import { 
  loadCheckpoint, 
  isTaskFingerprintValid, 
  type TaskFingerprint 
} from './checkpoint';
import { emit } from './bus';

export interface InvalidationResult {
  taskId: string;
  shouldSkip: boolean;
  reason: string;
  invalidatedBy?: string[]; // IDs of tasks that invalidated this one
}

/**
 * Analyze a task graph and determine which tasks can be skipped on resume.
 */
export function analyzeTaskInvalidation(
  runId: string,
  tasks: Map<string, Task>,
  projectRoot: string,
  architecture: ArchitectureSpec | null,
  design: string,
): Map<string, InvalidationResult> {
  const checkpoint = loadCheckpoint(runId);
  const results = new Map<string, InvalidationResult>();
  
  if (!checkpoint) {
    // No checkpoint - all tasks must run
    for (const task of tasks.values()) {
      results.set(task.id, {
        taskId: task.id,
        shouldSkip: false,
        reason: 'No checkpoint available',
      });
    }
    return results;
  }
  
  // Build dependency map
  const dependencyGraph = new Map<string, string[]>();
  for (const task of tasks.values()) {
    dependencyGraph.set(task.id, task.deps);
  }
  
  // Analyze each task
  for (const task of tasks.values()) {
    const result = analyzeTask(
      task,
      tasks,
      checkpoint.taskFingerprints,
      projectRoot,
      architecture,
      design,
      results,
    );
    results.set(task.id, result);
  }
  
  return results;
}

/**
 * Analyze a single task to determine if it needs re-execution.
 */
function analyzeTask(
  task: Task,
  allTasks: Map<string, Task>,
  fingerprints: Record<string, TaskFingerprint>,
  projectRoot: string,
  architecture: ArchitectureSpec | null,
  design: string,
  previousResults: Map<string, InvalidationResult>,
): InvalidationResult {
  if (task.status === 'skipped' && task.error?.startsWith('Superseded by')) {
    return { taskId: task.id, shouldSkip: true, reason: 'Superseded work remains retired' };
  }
  // Tasks that never completed cannot be skipped
  if (task.status !== 'completed') {
    return {
      taskId: task.id,
      shouldSkip: false,
      reason: task.status === 'cancelled' ? 'Task was cancelled' : 
              task.status === 'failed' ? 'Task failed' :
              task.status === 'running' ? 'Task was interrupted' :
              'Task not completed',
    };
  }
  
  // Special handling for verification tasks - always re-run on resume
  if (['test', 'visual_qa', 'review', 'finalize'].includes(task.kind)) {
    return {
      taskId: task.id,
      shouldSkip: false,
      reason: 'Verification task always re-runs',
    };
  }
  
  // Check if any dependencies were invalidated
  const invalidatedDeps: string[] = [];
  for (const depId of task.deps) {
    const depResult = previousResults.get(depId);
    if (depResult && !depResult.shouldSkip) {
      invalidatedDeps.push(depId);
    }
  }
  
  if (invalidatedDeps.length > 0) {
    const depTasks = invalidatedDeps
      .map(id => allTasks.get(id))
      .filter((t): t is Task => t !== undefined);
    
    return {
      taskId: task.id,
      shouldSkip: false,
      reason: `Dependencies changed: ${depTasks.map(t => t.title).join(', ')}`,
      invalidatedBy: invalidatedDeps,
    };
  }
  
  // Check task fingerprint
  const oldFingerprint = fingerprints[task.id];
  if (!oldFingerprint) {
    return {
      taskId: task.id,
      shouldSkip: false,
      reason: 'No fingerprint available (older checkpoint format)',
    };
  }
  
  const deps = task.deps
    .map(depId => allTasks.get(depId))
    .filter((t): t is Task => t !== undefined);
  
  const isValid = isTaskFingerprintValid(
    task,
    oldFingerprint,
    deps,
    projectRoot,
    architecture,
    design,
  );
  
  if (isValid) {
    return {
      taskId: task.id,
      shouldSkip: true,
      reason: 'Task output still valid (no changes detected)',
    };
  }
  
  return {
    taskId: task.id,
    shouldSkip: false,
    reason: 'Task inputs or outputs changed',
  };
}

/**
 * Apply invalidation results to a task graph, marking tasks as skipped where appropriate.
 */
export function applyInvalidation(
  tasks: Map<string, Task>,
  invalidation: Map<string, InvalidationResult>,
  projectId: string,
  runId: string,
): { skipped: number; rerun: number } {
  let skipped = 0;
  let rerun = 0;
  
  for (const [taskId, result] of invalidation) {
    const task = tasks.get(taskId);
    if (!task) continue;
    
    if (result.shouldSkip) {
      // Task will be marked as 'skipped' with output preserved
      if (task.status === 'completed') {
        // Update task to show it was skipped but keep output
        // Preserve successful work as completed so dependency and completion evidence stay valid.
        skipped++;
        
        emit('TASK_SKIPPED', `${task.title} — ${result.reason}`, 
          { projectId, runId, taskId: task.id }, 'info', { task });
      }
    } else {
      // Task needs re-execution
      // Recovery has no surviving in-flight worker. A persisted running task
      // must be scheduled again, otherwise its dependents can never start.
      if (task.status !== 'waiting') {
        // Reset task to waiting state
        task.status = 'waiting';
        task.startedAt = null;
        task.endedAt = null;
        task.error = null;
        task.attempt = 1;
        // Keep output for potential comparison, but it will be regenerated
        rerun++;
        
        emit('TASK_RESET', `${task.title} — ${result.reason}`, 
          { projectId, runId, taskId: task.id }, 'info', { 
            task,
            reason: result.reason,
            invalidatedBy: result.invalidatedBy,
          });
      }
    }
  }
  
  return { skipped, rerun };
}

/**
 * Determine if a run is resumable based on its state and checkpoint.
 */
export function isRunResumable(runId: string, runStatus: string): {
  resumable: boolean;
  reason: string;
} {
  if (runStatus === 'completed') {
    return {
      resumable: false,
      reason: 'Run already completed',
    };
  }
  
  if (runStatus === 'running') {
    return {
      resumable: false,
      reason: 'Run is currently active',
    };
  }
  
  const checkpoint = loadCheckpoint(runId);
  if (!checkpoint) {
    return {
      resumable: false,
      reason: 'No checkpoint found for this run',
    };
  }
  
  // Check checkpoint age (older than 30 days might be too stale)
  const checkpointAge = Date.now() - checkpoint.checkpointedAt;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  
  if (checkpointAge > thirtyDays) {
    return {
      resumable: false,
      reason: 'Checkpoint is too old (>30 days)',
    };
  }
  
  if (runStatus === 'paused' || runStatus === 'cancelled' || runStatus === 'failed' || runStatus === 'attention') {
    return {
      resumable: true,
      reason: `Run ${runStatus} with ${Object.keys(checkpoint.taskFingerprints).length} completed tasks`,
    };
  }
  
  return {
    resumable: false,
    reason: 'Unknown run status',
  };
}
