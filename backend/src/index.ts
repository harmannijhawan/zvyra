import path from 'node:path';
import { Notification, powerMonitor } from 'electron';
import { initDb, db } from '../../SWARM/electron/core/db';
import { bus } from '../../SWARM/electron/core/bus';
import { getSettings, updateSettings } from '../../SWARM/electron/core/settings';
import { loadRegistry } from '../../SWARM/electron/providers/registry';
import { markInterruptedRuns } from '../../SWARM/electron/core/recovery';
import { cancelAll, listActiveRuns, pauseRun } from '../../SWARM/electron/agents/orchestrator';
import { stopAllChats } from '../../SWARM/electron/chat/service';
import { stopAll } from '../../SWARM/electron/tools/process';
import { stopAllStatic } from '../../SWARM/electron/tools/staticServer';
import { closeBrowser } from '../../SWARM/electron/browser/browser';
import { BackendService } from './service';
import type { BackendEvent } from './contract';
export type { Operation, Input, Result, BackendEvent } from './contract';
let started = false;
export async function startBackend(options: { dataDirectory: string; speechScript: string; publish: (event: BackendEvent) => void }) {
  if (started) throw new Error('Backend is already initialized in this process');
  started = true;
  initDb(path.join(options.dataDirectory, 'zvyra.db'));
  markInterruptedRuns(db());
  const s = getSettings();
  // ZVYRA owns desktop delivery so quiet hours apply consistently. Safe tool policy is enforced here.
  // Multi-file builds (e.g. a full store) need more than the 12-step / 8k-token defaults.
  updateSettings({ behavior: { autonomy: 'manual' }, execution: { autoApprove: [] }, notifications: { desktop: false }, agents: { maxSteps: Math.max(s.agents.maxSteps, 36) }, ai: { maxOutputTokens: Math.max(s.ai.maxOutputTokens, 24576) }, workspace: { root: s.workspace.root || path.join(options.dataDirectory, 'projects') } });
  let sequence = 0; let closed = false;
  const publish = (topic: string, payload: unknown) => { if (!closed) options.publish({ version: 1, sequence: ++sequence, at: Date.now(), topic, payload }); };
  const service = new BackendService(options.speechScript, publish);
  bus.attach(events => publish('events', events), (topic, payload) => {
    publish(topic, payload);
    if (topic === 'chat:turn') { try { service.onChat(payload); } catch (e) { publish('voice.error', { message: String(e) }); } }
    if (topic === 'notification' && !service.quiet() && Notification.isSupported()) {
      const n = payload as { title: string; body: string };
      try { new Notification({ title: `ZVYRA · ${n.title}`, body: n.body, silent: true }).show(); } catch { /* Persistent in-app notification remains available. */ }
    }
  });
  loadRegistry();
  await service.voice.probe();
  const suspend = () => { service.voice.stop(); stopAllChats(); for (const run of listActiveRuns()) pauseRun(run.id); publish('system.suspended', { requiresExplicitResume: true }); };
  powerMonitor?.on('suspend', suspend);
  // A saved preference never silently restarts the microphone on process startup.
  const timer = setInterval(() => { try { service.tick(); } catch (e) { publish('system.error', { message: String(e) }); } }, 1000);
  timer.unref();
  return {
    service,
    invoke: service.invoke.bind(service),
    async close() {
      if (closed) return;
      clearInterval(timer); service.close(); cancelAll(); stopAllChats(); stopAll(); stopAllStatic();
      powerMonitor?.removeListener('suspend', suspend);
      await closeBrowser().catch(() => undefined);
      const deadline = Date.now() + 4000;
      while (listActiveRuns().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      bus.flush(); closed = true; bus.attach(() => undefined, () => undefined);
      // Do not close the DB while an aborting upstream worker can still flush its final record.
      // Electron process teardown releases SQLite; WAL recovery is handled next startup.
    },
  };
}
export type Backend = Awaited<ReturnType<typeof startBackend>>;
