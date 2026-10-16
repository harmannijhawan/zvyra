import type { Task } from '../../shared/types';

const TERMINAL = new Set<Task['status']>(['completed', 'failed', 'skipped', 'cancelled']);
export function readyTasks(tasks: Map<string, Task>, softKinds: Task['kind'][] = []): Task[] {
  return [...tasks.values()].filter(t => t.status === 'waiting' && t.deps.every(id => {
    const dep = tasks.get(id);
    return !!dep && (dep.status === 'completed' || (softKinds.includes(t.kind) && TERMINAL.has(dep.status)));
  })).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
}

/** Accept forward references, reject missing edges and cycles rather than dropping them. */
export function validateGraph(tasks: { key: string; deps: string[] }[]) {
  const byKey = new Map(tasks.map(t => [t.key, t]));
  if (byKey.size !== tasks.length) throw new Error('Duplicate task keys');
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string) => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error(`Task dependency cycle at ${key}`);
    const task = byKey.get(key);
    if (!task) throw new Error(`Missing dependency: ${key}`);
    visiting.add(key);
    task.deps.forEach(visit);
    visiting.delete(key); done.add(key);
  };
  tasks.forEach(t => visit(t.key));
}

export function scopesOverlap(a: string[], b: string[]) {
  if (!a.length || !b.length) return true;
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
  return a.some(x => b.some(y => {
    const left = normalize(x), right = normalize(y);
    return /[*?]/.test(left + right) || left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
  }));
}
