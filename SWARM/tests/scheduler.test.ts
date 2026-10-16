import { describe, expect, it } from 'vitest';
import { readyTasks, scopesOverlap, validateGraph } from '../electron/agents/scheduler';
import type { Task } from '../shared/types';
const task = (id: string, deps: string[] = [], status: Task['status'] = 'waiting', priority = 0) => ({ id, key: id, deps, status, priority, createdAt: 0, kind: 'code' } as Task);
describe('dependency scheduler', () => {
  it('admits independent roots immediately and only releases actual dependents', () => {
    const research = task('research'), design = task('design'), arch = task('arch');
    const tasks = new Map([research, design, arch, task('coder', ['arch']), task('test', ['coder'])].map(t => [t.id, t]));
    expect(readyTasks(tasks).map(t => t.id)).toEqual(['research', 'design', 'arch']);
    arch.status = 'completed';
    expect(readyTasks(tasks).map(t => t.id)).toContain('coder');
    expect(readyTasks(tasks).map(t => t.id)).not.toContain('test');
  });
  it('accepts forward dependencies and rejects cycles, missing edges and duplicate keys', () => {
    expect(() => validateGraph([{ key: 'code', deps: ['arch'] }, { key: 'arch', deps: [] }])).not.toThrow();
    expect(() => validateGraph([{ key: 'a', deps: ['b'] }, { key: 'b', deps: ['a'] }])).toThrow(/cycle/);
    expect(() => validateGraph([{ key: 'a', deps: ['missing'] }])).toThrow(/Missing/);
    expect(() => validateGraph([{ key: 'a', deps: [] }, { key: 'a', deps: [] }])).toThrow(/Duplicate/);
  });
  it('does not run a consumer of missing, failed or skipped work', () => {
    for (const status of ['failed', 'skipped', 'cancelled'] as const) {
      const tasks = new Map([['a', task('a', [], status)], ['b', task('b', ['a'])]]);
      expect(readyTasks(tasks)).toHaveLength(0);
    }
    expect(readyTasks(new Map([['b', task('b', ['missing'])]]))).toHaveLength(0);
  });
  it('honors priority and treats directory, case and glob overlaps conservatively', () => {
    expect(readyTasks(new Map([task('low'), task('high', [], 'waiting', 10)].map(t => [t.id, t])))[0].id).toBe('high');
    expect(scopesOverlap(['src'], ['src/app.ts'])).toBe(true);
    expect(scopesOverlap(['SRC/app.ts'], ['src/app.ts'])).toBe(true);
    expect(scopesOverlap(['src/*'], ['src/app.ts'])).toBe(true);
    expect(scopesOverlap(['src/ui.ts'], ['src/api.ts'])).toBe(false);
    expect(scopesOverlap([], ['src/api.ts'])).toBe(true);
  });
});
