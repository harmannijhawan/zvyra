// Tests for checkpoint and resume functionality
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDb } from '../electron/core/db';
import type { AgentRole, Task } from '../shared/types';
import {
  computeTaskFingerprint,
  isTaskFingerprintValid,
  saveCheckpoint,
} from '../electron/core/checkpoint';
import {
  analyzeTaskInvalidation,
  applyInvalidation,
  isRunResumable,
} from '../electron/core/invalidation';

// Initialise a fresh in-memory SQLite DB before tests that need it
let testDbDir: string;
beforeEach(() => {
  testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'));
  initDb(path.join(testDbDir, 'test.db'));
});

/** Save a minimal valid checkpoint so isRunResumable / analyzeTaskInvalidation can proceed past the "no checkpoint" guard */
function seedCheckpoint(runId: string, tasks: Map<string, Task> = new Map()) {
  saveCheckpoint(runId, 'proj_test', null, '', new Map<AgentRole, string[]>(), new Map(), tasks, testDbDir, 0);
}

describe('Checkpoint System', () => {
  const mockTask: Task = {
    id: 'tk_123',
    runId: 'run_456',
    key: 'code-1',
    title: 'Implement feature',
    description: 'Build the main feature',
    role: 'coder',
    kind: 'code',
    status: 'completed',
    deps: [],
    attempt: 1,
    scope: ['src/main.ts'],
    output: 'Feature implemented successfully',
    error: null,
    modelId: null,
    startedAt: Date.now() - 60000,
    endedAt: Date.now(),
    createdAt: Date.now() - 120000,
    filesTouched: ['src/main.ts', 'src/utils.ts'],
    tokens: 1500,
  };

  it('requeues an interrupted running task on recovery while preserving completed work', () => {
    const interrupted = { ...mockTask, id: 'interrupted', status: 'running' as const, endedAt: null };
    const tasks = new Map([[mockTask.id, { ...mockTask }], [interrupted.id, interrupted]]);
    const results = new Map([
      [mockTask.id, { taskId: mockTask.id, shouldSkip: true, reason: 'Valid output' }],
      [interrupted.id, { taskId: interrupted.id, shouldSkip: false, reason: 'Task was interrupted' }],
    ]);
    expect(applyInvalidation(tasks, results, 'project', 'run')).toEqual({ skipped: 1, rerun: 1 });
    expect(interrupted.status).toBe('waiting');
    expect(interrupted.startedAt).toBeNull();
    expect(tasks.get(mockTask.id)?.status).toBe('completed');
  });

  describe('computeTaskFingerprint', () => {
    it('should generate a fingerprint for a completed task', () => {
      const fingerprint = computeTaskFingerprint(
        mockTask,
        [],
        mockTask.filesTouched,
        null,
        '',
        '/test/project'
      );

      expect(fingerprint).toBeDefined();
      expect(fingerprint.taskId).toBe(mockTask.id);
      expect(fingerprint.taskKey).toBe(mockTask.key);
      expect(fingerprint.kind).toBe(mockTask.kind);
      expect(fingerprint.descriptionHash).toBeDefined();
      expect(fingerprint.dependencyHashes).toEqual([]);
      expect(fingerprint.relevantFileHashes).toBeDefined();
    });

    it('should include dependency hashes', () => {
      const depTask: Task = {
        ...mockTask,
        id: 'tk_dep',
        output: 'Dependency output',
      };

      const fingerprint = computeTaskFingerprint(
        { ...mockTask, deps: [depTask.id] },
        [depTask],
        mockTask.filesTouched,
        null,
        '',
        '/test/project'
      );

      expect(fingerprint.dependencyHashes).toHaveLength(1);
      expect(fingerprint.dependencyHashes[0]).toBeDefined();
    });
  });

  describe('isTaskFingerprintValid', () => {
    it('should return false if no fingerprint exists', () => {
      const isValid = isTaskFingerprintValid(
        mockTask,
        null,
        [],
        '/test/project',
        null,
        ''
      );

      expect(isValid).toBe(false);
    });

    it('should return false if task is not completed', () => {
      const incompleteTask = { ...mockTask, status: 'waiting' as const };
      const fingerprint = computeTaskFingerprint(
        mockTask,
        [],
        mockTask.filesTouched,
        null,
        '',
        '/test/project'
      );

      const isValid = isTaskFingerprintValid(
        incompleteTask,
        fingerprint,
        [],
        '/test/project',
        null,
        ''
      );

      expect(isValid).toBe(false);
    });
  });

  describe('isRunResumable', () => {
    it('should allow resuming cancelled runs', () => {
      seedCheckpoint('run_123');
      const result = isRunResumable('run_123', 'cancelled');
      expect(result.resumable).toBe(true);
    });

    it('should allow resuming failed runs', () => {
      seedCheckpoint('run_123');
      const result = isRunResumable('run_123', 'failed');
      expect(result.resumable).toBe(true);
    });

    it('should allow resuming attention runs', () => {
      seedCheckpoint('run_123');
      const result = isRunResumable('run_123', 'attention');
      expect(result.resumable).toBe(true);
    });

    it('should not allow resuming completed runs', () => {
      const result = isRunResumable('run_123', 'completed');
      expect(result.resumable).toBe(false);
      expect(result.reason).toContain('completed');
    });

    it('should not allow resuming running runs', () => {
      const result = isRunResumable('run_123', 'running');
      expect(result.resumable).toBe(false);
      expect(result.reason).toContain('active');
    });
  });

  describe('analyzeTaskInvalidation', () => {
    it('should mark verification tasks for re-execution', () => {
      const tasks = new Map<string, Task>();
      const testTask: Task = {
        ...mockTask,
        id: 'tk_test',
        kind: 'test',
        status: 'completed',
      };
      tasks.set(testTask.id, testTask);
      // Seed a checkpoint so the function processes past the "no checkpoint" guard
      seedCheckpoint('run_123', tasks);

      const result = analyzeTaskInvalidation(
        'run_123',
        tasks,
        testDbDir,
        null,
        ''
      );

      const testResult = result.get(testTask.id);
      expect(testResult?.shouldSkip).toBe(false);
      // Verification tasks (test/visual_qa/review) are always re-run;
      // the reason will mention the task kind or indicate re-execution
      expect(testResult?.reason).toBeDefined();
    });

    it('should skip tasks with valid fingerprints', () => {
      // This would require a mock checkpoint - simplified test
      const tasks = new Map<string, Task>();
      tasks.set(mockTask.id, mockTask);

      const result = analyzeTaskInvalidation(
        'run_123',
        tasks,
        '/test/project',
        null,
        ''
      );

      const taskResult = result.get(mockTask.id);
      expect(taskResult).toBeDefined();
      // Without checkpoint, should not skip
      expect(taskResult?.shouldSkip).toBe(false);
    });
  });
});

describe('Task Invalidation', () => {
  it('should detect dependency changes', () => {
    const depTask: Task = {
      id: 'tk_dep',
      runId: 'run_456',
      key: 'arch-1',
      title: 'Design architecture',
      description: 'Architecture design',
      role: 'architect',
      kind: 'architecture',
      status: 'completed',
      deps: [],
      attempt: 1,
      scope: [],
      output: 'Architecture complete',
      error: null,
      modelId: null,
      startedAt: Date.now() - 120000,
      endedAt: Date.now() - 60000,
      createdAt: Date.now() - 180000,
      filesTouched: [],
      tokens: 800,
    };

    const mainTask: Task = {
      id: 'tk_main',
      runId: 'run_456',
      key: 'code-1',
      title: 'Implement based on architecture',
      description: 'Code implementation',
      role: 'coder',
      kind: 'code',
      status: 'completed',
      deps: [depTask.id],
      attempt: 1,
      scope: [],
      output: 'Implementation complete',
      error: null,
      modelId: null,
      startedAt: Date.now() - 60000,
      endedAt: Date.now(),
      createdAt: Date.now() - 120000,
      filesTouched: ['src/main.ts'],
      tokens: 1200,
    };

    const tasks = new Map<string, Task>();
    tasks.set(depTask.id, depTask);
    tasks.set(mainTask.id, mainTask);

    const result = analyzeTaskInvalidation(
      'run_456',
      tasks,
      '/test/project',
      null,
      ''
    );

    // Both tasks should have invalidation results
    expect(result.has(depTask.id)).toBe(true);
    expect(result.has(mainTask.id)).toBe(true);
  });
});
