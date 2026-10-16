// Real local integration: SWARM's actual web verification gates (static server + real browser + DOM audit)
// against a small calculator, then evidence-based readiness. Skipped when no Edge/Chrome is installed.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, Run, Task } from '../shared/types';

vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/core/notify', () => ({ notify: vi.fn() }));

import { initDb } from '../electron/core/db';
import { RunContext } from '../electron/agents/runContext';
import { runTestGates, stopDevServer } from '../electron/agents/verify';
import { staticCheck } from '../electron/agents/staticChecks';
import { computeReadiness } from '../electron/core/readiness';
import { closeBrowser } from '../electron/browser/browser';
import { defaultSettings } from '../shared/settings';

const browserInstalled = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Microsoft Edge.app'].some(p => fs.existsSync(p));

describe.skipIf(!browserInstalled)('real web verification of a calculator', () => {
  it('runs the actual gates and reports evidence truthfully', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-integ-'));
    initDb(path.join(root, '.db', 'test.db'));
    fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calculator</title><link rel="stylesheet" href="styles.css"></head>
<body><main><h1>Calculator</h1><output id="display" aria-live="polite">0</output><div class="keys">${['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+'].map(k => `<button type="button" data-k="${k}">${k}</button>`).join('')}</div><p>Use the keys to add, subtract, multiply and divide numbers.</p></main><script src="app.js"></script></body></html>\n`);
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{font-family:system-ui;margin:0}main{max-width:320px;margin:24px auto;padding:0 12px}.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}button{padding:14px;font-size:18px}output{display:block;font-size:32px;text-align:right;margin:12px 0}\n');
    fs.writeFileSync(path.join(root, 'app.js'), `const display = document.getElementById('display');
let expr = '';
function evaluate(s) { if (!/^[\\d.+\\-*/]+$/.test(s)) return 'Error'; try { const v = Function('return (' + s + ')')(); return Number.isFinite(v) ? String(v) : 'Error'; } catch { return 'Error'; } }
document.querySelector('.keys').addEventListener('click', (e) => { const k = e.target.dataset.k; if (!k) return; if (k === '=') { expr = evaluate(expr); } else { expr = expr === 'Error' ? k : expr + k; } display.textContent = expr || '0'; });
`);
    const run = { id: 'run_integ', projectId: 'p', status: 'running', startedAt: Date.now(), objective: 'Build a website that is a simple calculator', target: 'web', brief: { platform: 'web', requirements: [] }, options: { autonomy: 'autonomous', attachments: [], pinnedModel: null, webResearch: false }, stats: { tasks: 0, completed: 0, failed: 0, modelCalls: 0, fallbacks: 0, tokens: 0, files: 0, commands: 0, sources: 0 }, gates: [], repairCycles: 0, previewUrl: null } as unknown as Run;
    const ctx = new RunContext(run, { id: 'p', path: root } as Project, defaultSettings());
    const task = ctx.addTask({ key: 'test', title: 'Build, test & verify', description: '', role: 'tester', kind: 'test', deps: [], scope: [] });
    try {
      const checks = await staticCheck(root, ['index.html', 'app.js']);
      expect(checks.problems).toEqual([]);
      const r = await runTestGates(ctx, task);
      const gates = Object.fromEntries(ctx.run.gates.map(g => [g.id, g.status]));
      console.log(JSON.stringify({ integration: 'calculator web gates', failures: r.failures.map(f => f.summary), gates }));
      expect(gates.server).toBe('passed');
      expect(gates.browser).toBe('passed');
      expect(gates.console).toBe('passed');
      const readiness = computeReadiness({ target: 'web', objective: run.objective, gates: ctx.run.gates, tasks: [{ kind: 'code', status: 'completed', filesTouched: ['index.html', 'app.js', 'styles.css'] } as Task] });
      expect(readiness.runtimeVerified.status).toBe('verified');
      expect(readiness.testsVerified.status).toBe('not_run'); // no automated tests exist: must not be claimed
      expect(readiness.productionReady).toBe(false);
    } finally { stopDevServer(ctx); ctx.stopHeartbeat(); await closeBrowser().catch(() => undefined); }
  }, 120_000);
});
