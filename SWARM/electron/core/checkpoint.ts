// Enhanced checkpoint system for run persistence and recovery.
// Provides atomic saves, versioning, task fingerprinting, and dependency-aware resumption.
import crypto from 'node:crypto';
import { timeOperation } from './performance';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole, AgentState, Task } from '../../shared/types';
import { db } from './db';
import { emit } from './bus';
import type { ArchitectureSpec } from '../agents/runContext';

const CHECKPOINT_VERSION = 2;
// Completion evidence must never be refreshed by unrelated state saves.
const completedFingerprints = new WeakMap<Task, { signature: string; fingerprint: TaskFingerprint }>();

export interface TaskFingerprint {
  taskId: string;
  taskKey: string;
  kind: string;
  descriptionHash: string;
  dependencyHashes: string[];
  relevantFileHashes: Record<string, string>; // path -> hash
  architectureHash: string | null;
  designHash: string | null;
  computedAt: number;
}

export interface RunCheckpoint {
  version: number;
  runId: string;
  checkpointedAt: number;
  
  // Core execution state
  architecture: ArchitectureSpec | null;
  design: string;
  notes: Array<[AgentRole, string[]]>;
  
  // Agent states
  agents: Record<string, AgentState>;
  
  // Task fingerprints for smart resumption
  taskFingerprints: Record<string, TaskFingerprint>;
  
  // Execution tracking
  lastActivityAt: number;
  lastCompletedTaskId: string | null;
  lastCompletedTaskTitle: string | null;
  
  // Research state
  sourceCounter: number;
}

/**
 * Compute a stable hash of a string value for change detection.
 */
function computeHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Compute a hash of a file's content. Returns empty string if file doesn't exist.
 */
function computeFileHash(root: string, relativePath: string): string {
  try {
    const fullPath = path.join(root, relativePath);
    if (!fs.existsSync(fullPath)) return '';
    const content = fs.readFileSync(fullPath, 'utf8');
    return computeHash(content);
  } catch {
    return '';
  }
}

/**
 * Compute a task fingerprint that can be used to detect if a task needs re-execution.
 */
export function computeTaskFingerprint(
  task: Task,
  dependencies: Task[],
  relevantFiles: string[],
  architecture: ArchitectureSpec | null,
  design: string,
  projectRoot: string,
): TaskFingerprint {
  const descriptionHash = computeHash(task.description);
  const dependencyHashes = dependencies.map(dep => 
    dep.output ? computeHash(dep.output) : ''
  );
  
  const relevantFileHashes: Record<string, string> = {};
  for (const file of relevantFiles) {
    relevantFileHashes[file] = computeFileHash(projectRoot, file);
  }
  
  const architectureHash = architecture && !['research', 'design', 'plan', 'decompose'].includes(task.kind) ? computeHash(JSON.stringify(architecture)) : null;
  const designHash = design && !['research', 'architecture', 'plan', 'decompose'].includes(task.kind) ? computeHash(design) : null;
  
  return {
    taskId: task.id,
    taskKey: task.key,
    kind: task.kind,
    descriptionHash,
    dependencyHashes,
    relevantFileHashes,
    architectureHash,
    designHash,
    computedAt: Date.now(),
  };
}

/**
 * Check if a task's fingerprint indicates it needs re-execution.
 * Returns true if the task can be safely skipped (output is still valid).
 */
export function isTaskFingerprintValid(
  task: Task,
  oldFingerprint: TaskFingerprint | null,
  currentDependencies: Task[],
  projectRoot: string,
  architecture: ArchitectureSpec | null,
  design: string,
): boolean {
  if (!oldFingerprint) return false;
  if (task.status !== 'completed' || !task.output) return false;
  
  // Check if task description changed
  const currentDescHash = computeHash(task.description);
  if (currentDescHash !== oldFingerprint.descriptionHash) return false;
  
  // Check if dependencies changed
  const currentDepHashes = currentDependencies.map(dep => 
    dep.output ? computeHash(dep.output) : ''
  );
  if (JSON.stringify(currentDepHashes) !== JSON.stringify(oldFingerprint.dependencyHashes)) {
    return false;
  }
  
  // Check if relevant files changed
  for (const [file, oldHash] of Object.entries(oldFingerprint.relevantFileHashes)) {
    const currentHash = computeFileHash(projectRoot, file);
    if (currentHash !== oldHash) {
      // File changed - task may need re-execution
      return false;
    }
  }
  
  // Check if architecture changed for tasks that depend on it
  if (oldFingerprint.architectureHash && architecture) {
    const currentArchHash = computeHash(JSON.stringify(architecture));
    if (currentArchHash !== oldFingerprint.architectureHash) return false;
  }
  
  // Check if design changed for tasks that depend on it
  if (oldFingerprint.designHash && design) {
    const currentDesignHash = computeHash(design);
    if (currentDesignHash !== oldFingerprint.designHash) return false;
  }
  
  return true;
}

/**
 * Save a complete checkpoint of the run state atomically.
 */
export function saveCheckpoint(
  runId: string,
  projectId: string,
  architecture: ArchitectureSpec | null,
  design: string,
  notes: Map<AgentRole, string[]>,
  agents: Map<AgentRole, AgentState>,
  tasks: Map<string, Task>,
  projectRoot: string,
  sourceCounter: number,
): void {
  const endTiming = timeOperation('checkpoint', runId);
  const taskFingerprints: Record<string, TaskFingerprint> = {};
  
  // Compute fingerprints for completed tasks
  for (const task of tasks.values()) {
    if (task.status === 'completed' && task.output) {
      const deps = task.deps
        .map(depId => tasks.get(depId))
        .filter((t): t is Task => t !== undefined);
      
      const signature = JSON.stringify([task.endedAt, task.attempt, task.output, task.description, task.deps, task.filesTouched]);
      const cached = completedFingerprints.get(task);
      const fingerprint = cached?.signature === signature ? cached.fingerprint : computeTaskFingerprint(
        task,
        deps,
        task.filesTouched,
        architecture,
        design,
        projectRoot,
      );
      
      completedFingerprints.set(task, { signature, fingerprint });
      taskFingerprints[task.id] = fingerprint;
    }
  }
  
  const lastCompletedTask = [...tasks.values()]
    .filter(t => t.status === 'completed' && t.endedAt)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  
  const checkpoint: RunCheckpoint = {
    version: CHECKPOINT_VERSION,
    runId,
    checkpointedAt: Date.now(),
    architecture,
    design,
    notes: [...notes.entries()],
    agents: Object.fromEntries([...agents.entries()]),
    taskFingerprints,
    lastActivityAt: Date.now(),
    lastCompletedTaskId: lastCompletedTask?.id ?? null,
    lastCompletedTaskTitle: lastCompletedTask?.title ?? null,
    sourceCounter,
  };
  
  // Atomic write: write to temp file, then rename
  const key = `run-checkpoint:${runId}`;
  const tempKey = `${key}:tmp`;
  
  try {
    const serialized = JSON.stringify(checkpoint);
    db().tx(() => { db().kvSet(key, serialized); });
    
    emit('CHECKPOINT_SAVED', `Checkpoint saved (${Object.keys(taskFingerprints).length} task fingerprints)`, 
      { projectId, runId }, 'debug', { 
        taskCount: tasks.size,
        fingerprintCount: Object.keys(taskFingerprints).length,
      });
  } catch (err) {
    console.error('[checkpoint] Failed to save checkpoint:', err);
    emit('CHECKPOINT_FAILED', `Checkpoint save failed: ${String(err)}`, 
      { projectId, runId }, 'error');
  } finally { endTiming(); }
}

/**
 * Load a checkpoint from storage.
 */
export function loadCheckpoint(runId: string): RunCheckpoint | null {
  try {
    const key = `run-checkpoint:${runId}`;
    const data = db().kvGet(key);
    
    if (!data) return null;
    
    const checkpoint = JSON.parse(data) as RunCheckpoint;
    
    // Version compatibility check
    if (checkpoint.version !== CHECKPOINT_VERSION) {
      console.warn(`[checkpoint] Checkpoint version mismatch: expected ${CHECKPOINT_VERSION}, got ${checkpoint.version}`);
      // Still try to load, but some features may not work
    }
    
    return checkpoint;
  } catch (err) {
    console.error('[checkpoint] Failed to load checkpoint:', err);
    return null;
  }
}

/**
 * Delete a checkpoint from storage.
 */
export function deleteCheckpoint(runId: string): void {
  try {
    const key = `run-checkpoint:${runId}`;
    db().prepare('DELETE FROM kv WHERE key = ?').run(key);
  } catch (err) {
    console.error('[checkpoint] Failed to delete checkpoint:', err);
  }
}

/**
 * Check if a run has a valid checkpoint.
 */
export function hasCheckpoint(runId: string): boolean {
  const checkpoint = loadCheckpoint(runId);
  return checkpoint !== null && checkpoint.version === CHECKPOINT_VERSION;
}

/**
 * Get a summary of what would be resumed from a checkpoint.
 */
export function getCheckpointSummary(runId: string): {
  hasCheckpoint: boolean;
  completedTasks: number;
  lastCompletedTask: string | null;
  checkpointAge: number;
} | null {
  const checkpoint = loadCheckpoint(runId);
  
  if (!checkpoint) {
    return null;
  }
  
  const completedTasks = Object.keys(checkpoint.taskFingerprints).length;
  const checkpointAge = Date.now() - checkpoint.checkpointedAt;
  
  return {
    hasCheckpoint: true,
    completedTasks,
    lastCompletedTask: checkpoint.lastCompletedTaskTitle,
    checkpointAge,
  };
}
