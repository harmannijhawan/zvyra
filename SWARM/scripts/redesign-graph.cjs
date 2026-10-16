const fs = require('node:fs');
let s = fs.readFileSync('src/components/AgentGraph.tsx', 'utf8');
s = s.replace("import { memo, useMemo }", "import { memo, useMemo, useState }");
s = s.replace("import type { AgentRole", "import { Minus, Plus, Maximize } from 'lucide-react';\nimport type { AgentRole");
const start = s.indexOf('export const AgentGraph =');
const end = s.indexOf('/** Task-level DAG', start);
s = s.slice(0,start) + `export const AgentGraph = memo(function AgentGraph({ run, tasks, agents, height }: { run: Run; tasks: Task[]; agents: Partial<Record<AgentRole, AgentState>>; height: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [zoom, setZoom] = useState(1);
  const selected = useStore(s => s.activeConversation);
  const messages = useStore(s => s.messages[run.id]);
  const roles = ORDER.filter(role => agents[role] || tasks.some(t => t.role === role));
  const nodeW = 210, nodeH = 106;
  const innerW = Math.max(800, width / zoom);
  const rows = Math.max(3, Math.ceil((roles.length - 1) / 3) + 1);
  const innerH = Math.max(height / zoom, rows * 140 + 44);
  const pos = new Map<string, { x: number; y: number }>();
  const managerY = (innerH - nodeH) / 2;
  pos.set('manager', { x: (innerW - nodeW) / 2, y: managerY });
  const others = roles.filter(r => r !== 'manager');
  // A center coordinator with specialist columns; expand vertically as the workforce grows.
  const slots: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const y = 24 + row * (innerH - nodeH - 48) / Math.max(1, rows - 1);
    for (const col of [0, 2, 1]) {
      if (col === 1 && Math.abs(y - managerY) < nodeH + 20) continue;
      slots.push({ x: 24 + col * (innerW - nodeW - 48) / 2, y });
    }
  }
  others.forEach((role, i) => pos.set(role, slots[i] ?? { x: 24, y: 24 + i * 140 }));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const edges = new Map<string, { from: AgentRole; to: AgentRole; live: boolean }>();
  for (const t of tasks) for (const depId of t.deps) {
    const dep = byId.get(depId); if (!dep || dep.role === t.role) continue;
    const key = dep.role + ':' + t.role;
    edges.set(key, { from: dep.role, to: t.role, live: t.status === 'running' || !!edges.get(key)?.live });
  }
  for (const m of messages ?? []) if (m.to !== 'all' && m.to !== m.from) {
    const key = m.from + ':' + m.to;
    if (!edges.has(key)) edges.set(key, { from: m.from, to: m.to, live: Date.now() - m.ts < 5000 && run.status === 'running' });
  }
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ax = a.x + nodeW / 2, ay = a.y + nodeH / 2, bx = b.x + nodeW / 2, by = b.y + nodeH / 2;
    if (Math.abs(ax - bx) < nodeW) { const y1 = ay + (by > ay ? nodeH / 2 : -nodeH / 2), y2 = by + (by > ay ? -nodeH / 2 : nodeH / 2); return 'M ' + ax + ' ' + y1 + ' C ' + ax + ' ' + (y1+y2)/2 + ', ' + bx + ' ' + (y1+y2)/2 + ', ' + bx + ' ' + y2; }
    const x1 = ax + (bx > ax ? nodeW / 2 : -nodeW / 2), x2 = bx + (bx > ax ? -nodeW / 2 : nodeW / 2);
    return 'M ' + x1 + ' ' + ay + ' C ' + (x1+x2)/2 + ' ' + ay + ', ' + (x1+x2)/2 + ' ' + by + ', ' + x2 + ' ' + by;
  };
  return <div className="agent-graph-shell" ref={ref} style={{ height }}>
    <div className="agent-graph-scroll"><div style={{ width: innerW * zoom, height: innerH * zoom }}><div className="agent-graph-canvas" style={{ width: innerW, height: innerH, transform: 'scale(' + zoom + ')', transformOrigin: 'top left' }}>
      <svg className="absolute inset-0 pointer-events-none" width={innerW} height={innerH} aria-hidden><defs><marker id="agent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>{[...edges.entries()].map(([key, edge]) => { const a = pos.get(edge.from), b = pos.get(edge.to); return a && b ? <path key={key} d={path(a,b)} fill="none" stroke={edge.live ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth={edge.live ? 1.6 : 1.3} markerEnd="url(#agent-arrow)" className={edge.live ? 'edge-live' : ''} /> : null; })}</svg>
      {roles.map(role => { const p = pos.get(role)!; const agent = agents[role]; const meta = ROLE_META[role]; const mine = tasks.filter(t => t.role === role && !['skipped','cancelled'].includes(t.status)); const done = mine.filter(t => t.status === 'completed').length; const active = mine.find(t => t.status === 'running'); const live = agent?.status === 'working' || agent?.status === 'planning'; const name = role === 'coder' && run.target ? run.target.charAt(0).toUpperCase() + run.target.slice(1) + ' Engineer' : meta.name;
        return <button key={role} className={cx('workforce-node', selected === role && 'workforce-node-selected', role === 'manager' && 'workforce-manager')} style={{ left: p.x, top: p.y, width: nodeW, height: nodeH }} aria-label={name + ': ' + agentLabel(agent?.status) + ' — click to chat'} onClick={() => { useStore.getState().setActiveConversation(role); useStore.setState({ inspector: null }); window.dispatchEvent(new Event('swarm:agent-selected')); }}>
          <span className={cx('workforce-icon', live && 'workforce-icon-live', agent?.status === 'completed' && 'workforce-icon-complete')}><meta.icon size={23} strokeWidth={1.7} /></span>
          <span className="workforce-node-content"><strong>{name}</strong><span className="workforce-node-status"><Dot tone={agentTone(agent?.status)} pulse={live} />{role === 'manager' && run.status === 'paused' ? 'Paused' : agentLabel(agent?.status)}</span><span className="workforce-node-description" title={active?.title ?? agent?.taskTitle ?? ''}>{role === 'manager' && run.status === 'running' ? 'Coordinating agents' : active?.title ?? agent?.taskTitle ?? 'Waiting for assignment'}</span><span className="workforce-progress"><i style={{ width: (mine.length ? done / mine.length * 100 : 0) + '%', background: agent?.status === 'completed' ? 'var(--ok)' : 'var(--accent)' }} /><small>{done} done · {mine.length} tasks</small></span></span>
        </button>;
      })}
    </div></div></div>
    <div className="graph-zoom"><button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(1.5,z+.1))}><Plus size={16} /></button><button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.5,z-.1))}><Minus size={16} /></button><button aria-label="Fit graph" onClick={() => setZoom(Math.min(1, width/800, height/(rows*140+44)))}><Maximize size={15} /></button></div>
  </div>;
});

` + s.slice(end);
fs.writeFileSync('src/components/AgentGraph.tsx', s);
