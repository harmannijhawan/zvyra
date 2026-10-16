import { managedRequest } from './account/sync';
import { accountStatus, signInAccount, signOutAccount, syncAccount } from './account/sync';
// IPC surface between renderer and main. Secrets never cross this boundary:
// the renderer only receives masked key hints.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole, CommandExecution, ResearchFinding, ResearchSource, Screenshot, UsageRecord, UsageSummary } from '../shared/types';
import { db } from './core/db';
import { queryEvents } from './core/bus';
import { getSettings, resetSettings, updateSettings } from './core/settings';
import { setSecret, getSecret, mask } from './core/secrets';
import { clearNotifications, listNotifications, markNotificationsRead } from './core/notify';
import { errMsg } from './core/util';
import { adapter, discoverAll, discoverProvider, healthCheckSample, listModels, listProviders, probeModel, providerConfig, refreshProviderInfo, setModelEnabled } from './providers/registry';
import { PROVIDER_CATALOG, STATUS_LABEL, catalogEntry, keyPageUrl, sanitize, testConnection, type ConnectionResult, type ConnectionStatus } from './providers/connection';
import { bus } from './core/bus';
import { registerSecret } from './core/util';
import { ollamaStatus } from './providers/ollama';
import { rankModels, type Purpose } from './router/router';
import { createProject, deleteProject, duplicateProject, ensureDemoProject, getProject, listProjects, listRuns, updateProject, workspaceRoot, saveProject } from './projects/projects';
import { cancelRun, pauseRun, resumeRun, listActiveRuns, runSnapshot, startRun, activeRunForProject } from './agents/orchestrator';
import { acceptChange, listChanges, listTree, readFile, revertChange, writeFile, resolveInProject, deleteFile, renameFile, makeDir } from './tools/fs';
import { commandHistory, listLive, runCommand, stopCommand } from './tools/process';
import { listApprovals, resolveApproval } from './tools/approvals';
import { hasFullWebSearch } from './research/search';
import { stopStatic } from './tools/staticServer';
import { classifyIntent } from './core/intent';
import { generateConversationalResponse } from './core/conversation';
import { listChats, searchChats, getChat, newChat, renameChat, deleteChat, sendChat, stopChat } from './chat/service';
import { resolveTarget, projectTarget } from './core/target';
import { registerRemoteIpc } from './remote';
import { initializeWorkspace, workspaceSnapshot, workspaceFile } from './workspace/service';

type Handler = (...args: never[]) => unknown;
/** Every registered channel, so the remote gateway can call existing handlers by name (behind its own allow-list). */
const handlers = new Map<string, Handler>();
/** Channels that only work with a SWARM account. Everything else runs locally with your own provider keys. */
const ACCOUNT_ONLY = new Set(['account:entitlements', 'account:modelPreferences', 'account:billing']);
export async function callHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  if (ACCOUNT_ONLY.has(channel) && !accountStatus().connected) throw new Error('Sign in to a SWARM account to use this feature.');
  const fn = handlers.get(channel);
  if (!fn) throw new Error('Unknown channel: ' + channel);
  return (fn as (...a: unknown[]) => unknown)(...args);
}
function handle(channel: string, fn: Handler) {
  handlers.set(channel, fn);
  ipcMain.handle(channel, async (_e, ...args) => {
    if (!_e.senderFrame?.url.startsWith('file://')) return {ok:false,error:'Native controls are available only in the local workspace.'};
    try { return { ok: true, data: await callHandler(channel, ...args) }; }
    catch (err) { return { ok: false, error: errMsg(err) }; }
  });
}

function projectOrThrow(id: string) {
  const p = getProject(id);
  if (!p) throw new Error('Project not found');
  return p;
}

function usageSummary(projectId?: string): UsageSummary {
  const rows = projectId ? db().list<UsageRecord>('usage', 'project_id = ?', [projectId], 'ts DESC', 20000) : db().list<UsageRecord>('usage', '', [], 'ts DESC', 20000);
  const byP = new Map<string, { calls: number; tokens: number; failures: number; lat: number }>();
  const byM = new Map<string, { providerId: string; calls: number; tokens: number; failures: number; lat: number }>();
  let pt = 0, ct = 0;
  for (const r of rows) {
    pt += r.promptTokens; ct += r.completionTokens;
    const p = byP.get(r.providerId) ?? { calls: 0, tokens: 0, failures: 0, lat: 0 };
    p.calls++; p.tokens += r.promptTokens + r.completionTokens; if (!r.ok) p.failures++; p.lat += r.latencyMs; byP.set(r.providerId, p);
    const k = `${r.providerId}::${r.modelId}`;
    const m = byM.get(k) ?? { providerId: r.providerId, calls: 0, tokens: 0, failures: 0, lat: 0 };
    m.calls++; m.tokens += r.promptTokens + r.completionTokens; if (!r.ok) m.failures++; m.lat += r.latencyMs; byM.set(k, m);
  }
  const cloud = rows.filter((r) => !r.local).reduce((n, r) => n + r.costUsd, 0);
  const local = rows.filter((r) => r.local).reduce((n, r) => n + r.costUsd, 0);
  return {
    cloudUsd: cloud, localUsd: local, totalUsd: cloud + local, calls: rows.length, promptTokens: pt, completionTokens: ct,
    byProvider: [...byP].map(([providerId, v]) => ({ providerId, calls: v.calls, tokens: v.tokens, failures: v.failures, avgLatencyMs: Math.round(v.lat / Math.max(1, v.calls)) })).sort((a, b) => b.calls - a.calls),
    byModel: [...byM].map(([modelId, v]) => ({ modelId, providerId: v.providerId, calls: v.calls, tokens: v.tokens, failures: v.failures, avgLatencyMs: Math.round(v.lat / Math.max(1, v.calls)) })).sort((a, b) => b.calls - a.calls).slice(0, 50),
  };
}

export function registerIpc(getWindow: () => BrowserWindow | null) {
  handle('account:status',accountStatus);
  handle('account:openWebsite',()=>shell.openExternal(accountStatus().origin + '/app/settings'));
  handle('account:signIn',signInAccount);
  handle('account:signOut',signOutAccount);
  handle('account:sync',syncAccount);
  initializeWorkspace();
  handle('workspace:snapshot', workspaceSnapshot);
  handle('workspace:file', workspaceFile);
  handle('runs:resume', resumeRun);
  handle('runs:pause', pauseRun);
  handle('runs:performance', async (runId: string) => (await import('./core/performance')).performanceSnapshot(runId));
  handle('runtime:tap', async (runtimeId: string, x: number, y: number) => { await (await import('./runtime/manager')).runtimeManager.tap(runtimeId, x, y); return true; });
  handle('runtime:input', (runtimeId: string, input: string) => {
    const { runtimeManager } = require('./runtime/manager');
    return runtimeManager.sendInput(runtimeId, input);
  });
  handle('runtime:clear', (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    runtimeManager.clearLogs(runtimeId);
    return true;
  });
  handle('runtime:launch', async (runId: string) => (await import('./runtime/preview')).launchPreview(runId));
  handle('runtime:getInfo', (runId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    const runtime = runtimeManager.findByRunId(runId);
    return runtime ? runtime.getInfo() : null;
  });
  handle('runtime:getCapabilities', (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    return runtimeManager.getRuntimeCapabilities(runtimeId);
  });
  handle('runtime:restart', async (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    await runtimeManager.restartRuntime(runtimeId);
    return true;
  });
  handle('runtime:stop', async (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    await runtimeManager.stopRuntime(runtimeId);
    return true;
  });
  handle('runtime:screenshot', async (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    return runtimeManager.screenshot(runtimeId);
  });
  handle('runtime:getLogs', (runtimeId: string) => {
    const { runtimeManager } = require('./runtime/manager');
    return runtimeManager.getLogs(runtimeId);
  });
  handle('experiments:run', async () => (await import('./core/experiments')).runRoutingExperiment());
  handle('experiments:cancel', async () => { (await import('./core/experiments')).cancelExperiment(); return true; });
  handle('runs:artifacts', (runId: string) => db().list('artifacts', 'run_id = ?', [runId], 'ts DESC', 100));
  handle('chat:list', listChats);
  handle('chat:search', searchChats);
  handle('chat:get', getChat);
  handle('chat:new', newChat);
  handle('chat:rename', renameChat);
  handle('chat:delete', deleteChat);
  handle('chat:send', sendChat);
  handle('chat:stop', stopChat);
  // ── Live Run Chat ──────────────────────────────────────────────────────────
  handle('run:chat:send', async (input: { runId: string; text: string }) => {
    const { sendManagerChat } = await import('./chat/liveRunChat');
    return sendManagerChat(input);
  });
  handle('run:chat:agent:send', async (input: { runId: string; agentRole: string; text: string }) => {
    const { sendAgentChat } = await import('./chat/liveRunChat');
    return sendAgentChat(input as import('../shared/types').AgentChatInput);
  });
  handle('run:chat:history', async (conversationId: string, limit?: number) => {
    const { getRunChatHistory } = await import('./chat/liveRunChat');
    return getRunChatHistory(conversationId, limit);
  });
  handle('run:chat:stop', async (conversationId: string) => {
    const { stopRunChat } = await import('./chat/liveRunChat');
    return stopRunChat(conversationId);
  });
  handle('run:chat:snapshot', async (runId: string) => {
    const { getRunSnapshot } = await import('./chat/liveRunChat');
    return getRunSnapshot(runId);
  });
  handle('run:chat:graphVersions', async (runId: string) => {
    const { getGraphVersions } = await import('./chat/liveRunChat');
    return getGraphVersions(runId);
  });
  handle('runs:resolveTarget', (objective: string, projectId?: string) => {
    const p = projectId ? getProject(projectId) : null;
    const previous = p?.lastRunId ? db().get<import('../shared/types').Run>('runs', p.lastRunId)?.brief?.platform : null;
    return resolveTarget(objective, previous ?? (p ? projectTarget(p.path) : null));
  });
  // ---------------- app
  handle('app:bootstrap', async () => {
    const s = getSettings();
    const ol = await ollamaStatus(s.advanced.ollamaUrl);
    const installed = ol.running || fs.existsSync(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe')) || fs.existsSync('/usr/local/bin/ollama') || fs.existsSync('/Applications/Ollama.app');
    
    // Detect interrupted runs
    const { detectInterruptedRuns } = await import('./core/recovery');
    const interruptedRuns = detectInterruptedRuns();
    
    return {
      firstRun: db().kvGet('onboarded') !== '1', version: app.getVersion(), platform: process.platform,
      paths: { data: app.getPath('userData'), workspace: workspaceRoot() },
      ollama: { installed, running: ol.running, url: s.advanced.ollamaUrl, version: ol.version },
      lastProjectId: db().kvGet('lastProjectId'),
      fullWebSearch: hasFullWebSearch(s),
      interruptedRuns: interruptedRuns.length > 0 ? interruptedRuns : undefined,
    };
  });
  handle('app:finishOnboarding', () => { db().kvSet('onboarded', '1'); ensureDemoProject(); return true; });
  handle('app:resetOnboarding', () => { db().kvSet('onboarded', '0'); return true; });
  handle('app:setLastProject', (id: string | null) => { db().kvSet('lastProjectId', id ?? ''); return true; });
  handle('settings:get', () => getSettings());
  handle('settings:update', (patch: unknown) => updateSettings(patch));
  handle('settings:reset', (section?: string) => resetSettings(section as never));
  handle('app:openExternal', (url: string) => {
    let parsed: URL;
    try { parsed = new URL(String(url)); } catch { throw new Error('Invalid link'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only http(s) links can be opened');
    if (!getSettings().computer.openExternal) throw new Error('Opening external links is disabled in Settings');
    return shell.openExternal(parsed.toString());
  });
  // Only paths inside the workspace or a known project may be revealed or opened (never arbitrary executables).
  const allowedPath = (p: unknown) => {
    if (typeof p !== 'string' || !p) throw new Error('Invalid path');
    const target = path.resolve(p);
    const roots = [workspaceRoot(), ...listProjects({ archived: true }).map((x) => x.path), ...listProjects().map((x) => x.path)].filter(Boolean).map((r) => path.resolve(r));
    const inside = roots.some((r) => { const rel = path.relative(r, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
    if (!inside) throw new Error('Only files inside your SWARM workspace can be opened.');
    return target;
  };
  handle('app:showInFolder', (p: string) => { shell.showItemInFolder(allowedPath(p)); return true; });
  handle('app:openPath', (p: string) => {
    const target = allowedPath(p);
    if (fs.existsSync(target) && fs.statSync(target).isFile() && /\.(exe|bat|cmd|com|msi|ps1|vbs|js|jse|wsf|scr|lnk|reg)$/i.test(target)) { shell.showItemInFolder(target); return ''; }
    return shell.openPath(target);
  });
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog(getWindow()!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:pickFiles', async () => {
    const r = await dialog.showOpenDialog(getWindow()!, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  handle('app:setTitleBar', (colors: { color: string; symbolColor: string }) => {
    const w = getWindow();
    if (w && process.platform === 'win32') w.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: 40 });
    return true;
  });
  handle('app:exportData', async () => {
    const r = await dialog.showSaveDialog(getWindow()!, { defaultPath: `swarm-export-${new Date().toISOString().slice(0, 10)}.json` });
    if (r.canceled || !r.filePath) return null;
    const data = { exportedAt: new Date().toISOString(), settings: getSettings(), projects: listProjects(), runs: listRuns(undefined, 1000), findings: db().list('findings'), sources: db().list('sources') };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return r.filePath;
  });
  handle('app:clearData', (what: 'logs' | 'cache' | 'history' | 'all') => {
    const d = db();
    if (what === 'logs' || what === 'all') d.prepare('DELETE FROM events').run();
    if (what === 'cache' || what === 'all') d.prepare('DELETE FROM cache').run();
    if (what === 'history' || what === 'all') for (const t of ['runs', 'tasks', 'messages', 'usage', 'commands', 'screenshots', 'visual_issues', 'notifications'] as const) d.delete(t, '1 = 1', []);
    if (what === 'all') { d.prepare('DELETE FROM kv WHERE key != ?').run('settings'); }
    return true;
  });
  handle('app:dataStats', () => {
    const count = (t: string) => (db().prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    const file = path.join(app.getPath('userData'), 'swarm.db');
    return { events: count('events'), runs: count('runs'), cache: count('cache'), usage: count('usage'), sources: count('sources'), dbBytes: fs.existsSync(file) ? fs.statSync(file).size : 0, dbPath: file };
  });

  // ---------------- projects
  handle('projects:list', (opts?: { archived?: boolean; query?: string }) => listProjects(opts));
  handle('projects:get', (id: string) => projectOrThrow(id));
  handle('projects:create', (input: { name?: string; objective?: string; path?: string }) => createProject(input));
  handle('projects:update', (id: string, patch: never) => updateProject(id, patch));
  handle('projects:delete', async (id: string, keepFiles: boolean) => {
    const run = activeRunForProject(id); if (run) cancelRun(run.run.id);
    stopStatic(id);
    for (const e of listLive(id)) stopCommand(e.id);
    await deleteProject(id, keepFiles); return true;
  });
  handle('projects:duplicate', (id: string) => duplicateProject(id));
  handle('projects:open', (id: string) => { const p = projectOrThrow(id); p.lastOpenedAt = Date.now(); db().kvSet('lastProjectId', id); return saveProject(p); });
  handle('projects:tree', (id: string) => listTree(projectOrThrow(id).path, '', 8));
  handle('projects:readFile', async (id: string, rel: string) => {
    const p = projectOrThrow(id);
    return readFile({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, rel, 2_000_000);
  });
  handle('projects:writeFile', async (id: string, rel: string, content: string) => {
    const p = projectOrThrow(id);
    return writeFile({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, rel, content);
  });
  handle('projects:deleteFile', async (id: string, rel: string) => { const p = projectOrThrow(id); return deleteFile({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, rel); });
  handle('projects:renameFile', async (id: string, from: string, to: string) => { const p = projectOrThrow(id); return renameFile({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, from, to); });
  handle('projects:mkdir', async (id: string, rel: string) => { const p = projectOrThrow(id); await makeDir({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, rel); return true; });
  handle('projects:changes', (id: string, opts?: { runId?: string; path?: string }) => listChanges(id, opts));
  handle('projects:revertChange', async (id: string, changeId: string) => { const p = projectOrThrow(id); return revertChange({ projectId: id, root: p.path, agent: 'user', autonomy: 'autonomous' }, changeId); });
  handle('projects:acceptChange', (changeId: string) => { acceptChange(changeId); return true; });
  handle('projects:export', async (id: string) => {
    const p = projectOrThrow(id);
    const r = await dialog.showSaveDialog(getWindow()!, { defaultPath: `${p.name.replace(/[^\w-]+/g, '-')}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return null;
    await new Promise<void>((resolve, reject) => execFile('tar', ['-a', '-c', '-f', r.filePath!, '--exclude=node_modules', '--exclude=.git', '-C', p.path, '.'], { windowsHide: true }, (err) => (err ? reject(err) : resolve())));
    return r.filePath;
  });
  handle('projects:revealPath', (id: string, rel?: string) => { const p = projectOrThrow(id); shell.showItemInFolder(rel ? resolveInProject(p.path, rel) : p.path); return true; });

  // ---------------- runs
  handle('runs:classifyIntent', (input: string, projectId?: string) => {
    const hasProject = !!projectId && !!getProject(projectId);
    return classifyIntent(input, hasProject);
  });
  handle('runs:conversationalResponse', (intent: string, input: string) => {
    return generateConversationalResponse(intent as never, input);
  });
  handle('runs:start', (projectId: string, objective: string, options?: never) => startRun(projectId, objective, options));
  handle('runs:cancel', (runId: string) => cancelRun(runId));
  handle('runs:snapshot', (runId: string) => runSnapshot(runId));
  handle('runs:isResumable', (runId: string) => {
    const run = db().get<import('../shared/types').Run>('runs', runId);
    if (!run) return { resumable: false, reason: 'Run not found' };
    return (async () => {
      const { isRunResumable } = await import('./core/invalidation');
      return isRunResumable(runId, run.status);
    })();
  });
  handle('runs:list', (projectId?: string) => listRuns(projectId));
  handle('runs:active', () => listActiveRuns());
  handle('runs:events', (opts: { runId?: string; projectId?: string; limit?: number; before?: number; types?: string[]; compact?: boolean }) => queryEvents(opts));
  handle('runs:screenshots', (opts: { runId?: string; projectId?: string }) => opts.runId ? db().list<Screenshot>('screenshots', 'run_id = ?', [opts.runId], 'ts ASC') : db().list<Screenshot>('screenshots', 'project_id = ?', [opts.projectId ?? ''], 'ts DESC', 60));
  handle('runs:visualIssues', (runId: string) => db().list('visual_issues', 'run_id = ?', [runId], 'ts ASC'));
  handle('runs:readImage', (p: string) => {
    const abs = path.resolve(p);
    const ok = listProjects().some((pr) => abs.startsWith(path.resolve(pr.path) + path.sep));
    if (!ok || !/\.(png|jpe?g)$/i.test(abs)) throw new Error('Not an accessible screenshot');
    return `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`;
  });
  handle('runs:saveScreenshot', (projectId: string, dataUrl: string, url: string) => {
    const p = projectOrThrow(projectId);
    const dir = path.join(p.path, '.swarm', 'screenshots', 'manual');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `preview-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    const shot: Screenshot = { id: `ss_${Date.now()}`, projectId, runId: null, url, viewport: 'preview', width: 0, height: 0, path: file, ts: Date.now() };
    db().put('screenshots', shot.id, shot, { project_id: projectId, run_id: null, ts: shot.ts });
    return shot;
  });

  // ---------------- models & providers
  handle('account:entitlements',()=>managedRequest('account/entitlements'));
  handle('account:modelPreferences',(profile:string,speed:string)=>managedRequest('account/model-preferences',{profile,speed}));
  handle('account:billing',()=>managedRequest('billing/history'));
  handle('models:list', () => ({ models: listModels(), providers: listProviders() }));
  handle('models:discover', async (providerId?: string) => { if (providerId) await discoverProvider(providerId); else await discoverAll(); return { models: listModels(), providers: listProviders() }; });
  handle('models:healthCheck', async (providerId?: string) => { await healthCheckSample(providerId ? 8 : 4, providerId); return listModels(); });
  handle('models:probe', (modelId: string) => probeModel(modelId));
  handle('models:setEnabled', (modelId: string, enabled: boolean) => { setModelEnabled(modelId, enabled); return true; });
  handle('models:rank', (purpose: Purpose, role?: AgentRole) => rankModels({ purpose, role, promptTokens: 2000, maxTokens: 2000 }).slice(0, 12).map((r) => ({ id: r.model.id, score: Math.round(r.score) })));
  handle('models:usage', (projectId?: string) => usageSummary(projectId));
  // ---------------- providers (keys never leave the main process; the renderer sees only ••••last4)
  const providerId = (id: unknown) => { if (typeof id !== 'string' || !catalogEntry(id)) throw new Error('Choose a supported provider.'); return id; };
  const keyInput = (key: unknown) => {
    if (typeof key !== 'string') throw new Error('Enter an API key.');
    const k = key.trim();
    if (k.length < 8 || k.length > 4096 || /[\s\x00-\x1f\x7f]/.test(k)) throw new Error('Enter a valid API key without spaces.');
    return k;
  };
  const testing = new Set<string>();
  /** Result of a test-before-save, kept in memory (keyed by a hash of the candidate key) so saving needs no second request. */
  const pendingTests = new Map<string, { result: ConnectionResult; at: number }>();
  const candidateTag = (id: string, key: string) => id + ':' + createHash('sha256').update(key).digest('base64url');
  const lastTest = (id: string): ConnectionResult | null => { try { return JSON.parse(db().kvGet('providerTest:' + id) || 'null'); } catch { return null; } };
  const providerCard = (id: string) => {
    const entry = catalogEntry(id)!;
    const secret = getSecret(id, getSettings().providers.useEnvKeys);
    const test = secret ? lastTest(id) : null;
    const status: ConnectionStatus = testing.has(id) ? 'checking' : !secret ? 'not_connected' : test ? test.status : 'needs_configuration';
    const info = listProviders().find((p) => p.id === id);
    return { ...entry, configured: !!secret, hint: mask(secret?.value), keySource: secret?.source ?? null, status, label: STATUS_LABEL[status], lastTest: test, models: info?.modelCount ?? 0, freeModels: info?.freeModelCount ?? 0 };
  };
  // Same order on every platform: the quickest free-tier providers first.
  const ORDER = ['groq', 'google', 'openrouter', 'mistral', 'nvidia', 'huggingface'];
  handle('providers:catalog', () => [...PROVIDER_CATALOG].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)).map((p) => providerCard(p.id)));
  handle('providers:setKey', async (id: string, key: string | null) => {
    if (['brave', 'tavily'].includes(id)) {
      setSecret(id, typeof key === 'string' ? key.trim() || null : null);
      return { hint: mask(getSecret(id, getSettings().providers.useEnvKeys)?.value) };
    }
    const pid = providerId(id);
    const value = key === null ? null : keyInput(key);
    setSecret(pid, value);
    const pending = value ? pendingTests.get(candidateTag(pid, value)) : undefined;
    db().kvSet('providerTest:' + pid, pending && Date.now() - pending.at < 10 * 60_000 ? JSON.stringify(pending.result) : 'null');
    if (value) pendingTests.delete(candidateTag(pid, value));
    refreshProviderInfo(pid);
    if (key !== null) void discoverProvider(pid).catch(() => 0);
    return providerCard(pid);
  });
  handle('providers:removeKey', async (id: string) => {
    const pid = providerId(id);
    setSecret(pid, null);
    // Also stop using a key that came from the environment for this provider.
    const disabled = new Set<string>(JSON.parse(db().kvGet('account.disabledProviders') || '[]'));
    if (getSecret(pid, getSettings().providers.useEnvKeys)) { disabled.add(pid); db().kvSet('account.disabledProviders', JSON.stringify([...disabled])); }
    db().kvSet('providerTest:' + pid, 'null');
    refreshProviderInfo(pid);
    return providerCard(pid);
  });
  /** Real connection test (docs/SWARM_PLATFORM_SPEC.md §3). Pass a key to test before saving. */
  handle('providers:test', async (id: string, candidate?: string) => {
    const pid = providerId(id);
    if (testing.has(pid)) throw new Error('A test for this provider is already running.');
    const a = adapter(pid)!;
    const cfg = providerConfig(pid);
    const key = candidate === undefined || candidate === null || candidate === '' ? cfg.apiKey : keyInput(candidate);
    if (candidate) registerSecret(key!);
    testing.add(pid); bus.send('models:changed', { models: listModels(), providers: listProviders() });
    try {
      const result = await testConnection(a, { ...cfg, apiKey: key }, AbortSignal.timeout(90_000));
      result.message = sanitize(result.message, key);
      // Persist results for the saved key; hold an unsaved candidate's result in memory until it is saved.
      if (!candidate || key === cfg.apiKey) db().kvSet('providerTest:' + pid, JSON.stringify(result));
      else { pendingTests.set(candidateTag(pid, key!), { result, at: Date.now() }); if (pendingTests.size > 50) pendingTests.clear(); }
      if (result.status === 'connected' && (!candidate || key === cfg.apiKey)) void discoverProvider(pid).catch(() => 0);
      return { ...result, provider: providerCard(pid) };
    } finally { testing.delete(pid); bus.send('models:changed', { models: listModels(), providers: listProviders() }); }
  });
  handle('providers:openKeyPage', (id: string) => {
    const url = keyPageUrl(providerId(id));
    if (!url) throw new Error('No key page for this provider.');
    return shell.openExternal(url);
  });
  handle('providers:searchKeys', () => {
    const s = getSettings();
    return ['brave', 'tavily'].map((id) => { const k = getSecret(id, s.providers.useEnvKeys); return { id, hint: mask(k?.value), source: k?.source ?? null }; });
  });
  handle('providers:configure', async (id: string, cfg: { enabled?: boolean }) => {
    const pid = providerId(id);
    if (typeof cfg?.enabled === 'boolean') updateSettings({ providers: { enabled: { ...getSettings().providers.enabled, [pid]: cfg.enabled } } });
    refreshProviderInfo(pid);
    return listProviders();
  });
  handle('ollama:status', () => ollamaStatus(getSettings().advanced.ollamaUrl));

  // ---------------- research
  handle('research:sources', (projectId: string, runId?: string) => runId ? db().list<ResearchSource>('sources', 'run_id = ?', [runId], 'ts ASC') : db().list<ResearchSource>('sources', 'project_id = ?', [projectId], 'ts DESC', 500));
  handle('research:findings', (projectId: string, runId?: string) => runId ? db().list<ResearchFinding>('findings', 'run_id = ?', [runId], 'ts ASC') : db().list<ResearchFinding>('findings', 'project_id = ?', [projectId], 'ts DESC', 500));

  // ---------------- terminal
  handle('terminal:run', async (projectId: string, command: string) => {
    const p = projectOrThrow(projectId);
    const r = await runCommand({ projectId, cwd: p.path, command, agent: 'user', autonomy: getSettings().behavior.autonomy, userInitiated: true, timeoutMs: getSettings().execution.timeoutSec * 1000 });
    return r.exec;
  });
  handle('terminal:stop', (id: string) => stopCommand(id));
  handle('terminal:history', (projectId: string) => commandHistory(projectId));
  handle('terminal:live', (projectId?: string) => listLive(projectId) as CommandExecution[]);

  // ---------------- approvals & notifications
  handle('approvals:list', () => listApprovals());
  handle('approvals:resolve', (id: string, approved: boolean, always?: boolean) => resolveApproval(id, approved, always));
  handle('notifications:list', () => listNotifications());
  handle('notifications:markRead', () => { markNotificationsRead(); return true; });
  handle('notifications:clear', () => { clearNotifications(); return true; });
  registerRemoteIpc(handle);
}
