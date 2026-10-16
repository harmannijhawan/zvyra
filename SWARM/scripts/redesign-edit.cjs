const fs = require('node:fs');
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
edit('electron/chat/liveRunChat.ts', s => {
  const start = s.indexOf('function applyDecisionToGraph(');
  const end = s.indexOf('// ─── escalate from agent', start);
  s = s.slice(0, start) + `export function applyDecisionToGraph(
  runId: string,
  decision: { classification: string; affectedAreas: string[]; summary: string },
  userInstruction: string,
): RunChatEvent[] {
  const ctx = activeRun(runId);
  if (!ctx) throw new Error('This run is no longer executing. Resume it before changing requirements.');
  const cls = decision.classification;
  if (!['DESIGN_CHANGE', 'ARCHITECTURE_CHANGE', 'TASK_UPDATE', 'PLAN_CHANGE', 'PRIORITY_CHANGE', 'TARGET_CHANGE'].includes(cls)) return [];
  if (cls === 'TARGET_CHANGE') throw new Error('Changing the target platform requires a new project. The current run was preserved.');
  const version = nextGraphVersion(runId);
  const gv: GraphVersion = { version, runId, ts: Date.now(), reason: decision.summary,
    userInstruction, tasksAdded: [], tasksRemoved: [], tasksInvalidated: [], agentsNotified: [] };
  const existing = [...ctx.tasks.values()];
  // Running operations finish safely before the change chain starts. Preserve their results.
  const barrier = existing.filter(t => t.status === 'running' || ['plan', 'decompose'].includes(t.kind) && t.status === 'waiting').map(t => t.id);
  const areas = decision.affectedAreas.filter(a => typeof a === 'string' && a.trim()).map(a => a.toLowerCase());
  for (const task of existing) {
    const affected = areas.some(a => (task.title + ' ' + task.description + ' ' + task.scope.join(' ')).toLowerCase().includes(a));
    if (affected && !['plan', 'decompose', 'research'].includes(task.kind)) {
      gv.tasksInvalidated.push(task.id);
      if (task.status === 'waiting') ctx.updateTask(task, { status: 'skipped', error: 'Superseded by requirement change', endedAt: Date.now() });
    }
  }
  // Queued verification must follow the changed implementation, not the old plan.
  for (const task of existing) if (task.status === 'waiting' && ['test', 'visual_qa', 'review', 'finalize'].includes(task.kind)) {
    ctx.updateTask(task, { status: 'skipped', error: 'Superseded by requirement change', endedAt: Date.now() });
    if (!gv.tasksInvalidated.includes(task.id)) gv.tasksInvalidated.push(task.id);
  }
  ctx.run.objective += '\\nRequirement update: ' + userInstruction;
  if (ctx.run.brief) ctx.run.brief.requirements.push(userInstruction);
  ctx.project.memory.decisions.push({ ts: Date.now(), text: decision.summary, agent: 'manager' });
  const description = 'Apply the latest user requirement, replacing conflicting earlier requirements. Preserve unrelated work.\\n' + userInstruction;
  let deps = barrier;
  const add = (role: AgentRole, kind: import('../../shared/types').TaskKind, title: string) => {
    const task = ctx.addTask({ key: ctx.newTaskKey(kind), role, kind, title, description, deps: [...deps], scope: [] });
    gv.tasksAdded.push(task.id); deps = [task.id];
    if (!gv.agentsNotified.includes(role)) {
      ctx.message('manager', role, 'Requirement update v' + version + ': ' + userInstruction, task.id);
      gv.agentsNotified.push(role);
    }
  };
  if (cls === 'ARCHITECTURE_CHANGE') add('architect', 'architecture', 'Update architecture: ' + decision.summary.slice(0, 60));
  if (cls === 'DESIGN_CHANGE' || cls === 'TASK_UPDATE' || cls === 'PLAN_CHANGE') add('designer', 'design', 'Update design: ' + decision.summary.slice(0, 60));
  add('coder', 'code', 'Implement change: ' + decision.summary.slice(0, 60));
  // Include unaffected queued implementations so this verification covers the complete objective.
  deps = [...new Set([...deps, ...existing.filter(t => t.status === 'waiting' && ['code', 'optimize', 'repair'].includes(t.kind)).map(t => t.id)])];
  add('tester', 'test', 'Verify updated requirements');
  if (ctx.run.target === 'web' && ctx.settings.experimental.visionQA) add('vision', 'visual_qa', 'Inspect updated application');
  if (ctx.settings.agents.enabled.reviewer !== false) add('reviewer', 'review', 'Review updated requirements');
  add('finalizer', 'finalize', 'Deliver updated application');
  ctx.saveRun();
  db().put('projects', ctx.project.id, ctx.project, { updated_at: Date.now() });
  saveGraphVersion(gv);
  emit('GRAPH_VERSION_CREATED', 'Graph v' + version + ': ' + decision.summary, ctx.scope(), 'info', { graphVersion: gv });
  return [
    { kind: 'task_created', label: gv.tasksAdded.length + ' executable tasks added', taskIds: gv.tasksAdded },
    ...(gv.tasksInvalidated.length ? [{ kind: 'task_invalidated' as const, label: gv.tasksInvalidated.length + ' affected tasks superseded or followed by new work', taskIds: gv.tasksInvalidated }] : []),
    ...gv.agentsNotified.map(role => ({ kind: 'agent_notified' as const, label: (ROLES[role]?.name ?? role) + ' notified', agentRoles: [role] })),
    { kind: 'graph_updated', label: 'Graph updated · v' + version },
  ];
}

` + s.slice(end);
  s = s.replace("active.set(\x60manager:\${runId}\x60, ctrl);", "active.set(\x60manager:\${runId}\x60, ctrl);\n  const changeContext = activeRun(runId);\n  if (changeContext) changeContext.pendingChanges++;");
  s = s.replace("active.delete(\x60manager:\${runId}\x60);\n    }", "if (changeContext) changeContext.pendingChanges--;\n      active.delete(\x60manager:\${runId}\x60);\n    }");
  s = s.replace('const decision = extractDecisionBlock(responseTurn.text);', "const decision = extractDecisionBlock(responseTurn.text) ?? (['DESIGN_CHANGE', 'ARCHITECTURE_CHANGE', 'TASK_UPDATE', 'PLAN_CHANGE', 'PRIORITY_CHANGE', 'TARGET_CHANGE'].includes(classification) ? { classification, affectedAreas: [], unaffectedAreas: [], summary: text.slice(0, 100) } : null);");
  s = s.replace('responseTurn.events = chatEvents;', "responseTurn.events = chatEvents;\n        if (chatEvents.length) responseTurn.text = 'Updated the requirements in this run and queued implementation and verification. Unaffected work is preserved. ' + decision.summary;");
  s = s.replace('escalateToManager(runId, agentRole, escalate.instruction, escalate.reason);', "escalateToManager(runId, agentRole, escalate.instruction, escalate.reason);\n        await sendManagerChat({ runId, text: escalate.instruction });");
  return s;
});
edit('src/views/Settings.tsx', s => s.split('\n').filter(l => !l.includes("numIn('agents.maxSteps'") && !l.includes("numIn('behavior.maxRepairCycles'")).join('\n'));
edit('src/App.tsx', s => s.replace("(view === 'build' || view === 'agents' || view === 'models')", "(view === 'agents' || view === 'models')").replace("!settings.interface.sidebarCollapsed && <ProjectPanel />", "view !== 'build' && !settings.interface.sidebarCollapsed && <ProjectPanel />"));
edit('src/lib/store.ts', s => s.replace('DEFAULT_CHAT_PANEL_WIDTH = 320', 'DEFAULT_CHAT_PANEL_WIDTH = 400'));
