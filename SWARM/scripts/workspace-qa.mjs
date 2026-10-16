// Exercise the production IPC, persistence, coordinator, and renderer in isolated user data.
// --live additionally uses the installed provider and the actual PC screenshot tool.
import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const live = process.argv.includes('--live');
const quick = process.argv.includes('--quick');
const stress = process.argv.includes('--stress');
const dir = path.join(root, '.swarm-test', `workspace-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'swarm.db'));
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings = {
  providers: { useEnvKeys: live, enabled: Object.fromEntries(['nvidia', 'openrouter', 'groq', 'google', 'cloudflare', 'huggingface', 'cerebras', 'mistral', 'ollama'].map(id => [id, live && id === 'nvidia'])) },
  routing: { healthCheckOnStartup: false, discoveryIntervalMin: 0, firstTokenTimeoutSec: 15, requestTimeoutSec: 60, maxFallbacks: 2 },
  workspace: { root: path.join(dir, 'projects') }, computer: { native: live || quick }, appearance: { theme: 'light' }, research: { defaultOn: false },
};
// Reuse configured credentials through Electron's existing safe-storage decoder,
// without exporting or printing them. Never modify the installed application's DB.
const installedDb = path.join(process.env.APPDATA ?? '', 'swarm', 'swarm.db');
if (live && fs.existsSync(installedDb)) {
  const source = new DatabaseSync(installedDb, { readOnly: true });
  try {
    const row = source.prepare('SELECT value FROM kv WHERE key = ?').get('settings');
    if (row) {
      const installed = JSON.parse(row.value);
      settings.providers = installed.providers ?? settings.providers;
    }
    for (const table of ['secrets', 'models']) {
      const schema = source.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)?.sql;
      if (!schema) continue;
      db.exec(schema);
      if (table === 'secrets') for (const item of source.prepare('SELECT id,value FROM secrets').all()) db.prepare('INSERT INTO secrets(id,value) VALUES(?,?)').run(item.id, item.value);
      else for (const item of source.prepare('SELECT id,provider_id,data FROM models').all()) db.prepare('INSERT INTO models(id,provider_id,data) VALUES(?,?,?)').run(item.id, item.provider_id, item.data);
    }
  } finally { source.close(); }
}
for (const [key, value] of Object.entries({ onboarded: '1', settings: JSON.stringify(settings) })) db.prepare('INSERT INTO kv VALUES (?,?)').run(key, value);
db.close();
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--smoke'], env: { ...process.env, SWARM_USER_DATA: dir } });
const win = await app.firstWindow();
const report = { dir, live, errors: [], checks: [], messages: [], screenshots: [] };
win.on('pageerror', error => report.errors.push(error.message));
const invoke = (channel, ...args) => win.evaluate(({ channel, args }) => window.swarm.invoke(channel, ...args), { channel, args });
const assert = (condition, message) => { if (!condition) throw new Error(message); report.checks.push(message); };
async function ask(text, directId) {
  const started = Date.now();
  if (directId) await invoke('chat:send', { id: directId, text });
  else { await win.locator('#chat-input').fill(text); await win.getByRole('button', { name: 'Send message', exact: true }).click(); }
  const deadline = Date.now() + 150000;
  let conversation;
  while (Date.now() < deadline) {
    const list = await invoke('chat:list');
    const chat = list.find(item => item.title === text.slice(0, 60)) ?? list[0];
    if (chat) conversation = await invoke('chat:get', chat.id);
    if (conversation?.turns.some(turn => turn.role === 'user' && turn.text === text) && !conversation.turns.some(turn => turn.status === 'streaming')) break;
    for (const approval of await invoke('approvals:list')) {
      if (approval.runId === conversation?.id && approval.kind === 'computer' && /screenshot|observe|state/i.test(approval.detail)) await invoke('approvals:resolve', approval.id, true);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const answer = conversation?.turns.findLast(turn => turn.role === 'assistant');
  report.messages.push({ prompt: text, durationMs: Date.now() - started, status: answer?.status, model: answer?.model, answer: answer?.text, error: answer?.error, activities: answer?.activities?.map(({ preview, ...activity }) => ({ ...activity, hasActualPreview: Boolean(preview) })) });
  assert(answer?.status === 'complete', `${text} receives a complete reply`);
  return conversation;
}
try {
  await win.locator('#chat-input').waitFor({ timeout: 30000 });
  if (quick) {
    const pc = await ask('Open Chrome');
    const response = pc.turns.at(-1);
    assert(!response.model, 'Simple application launch makes no model requests');
    assert(response.activities?.length === 1 && response.activities[0].tool === 'computer.open_application' && response.activities[0].status === 'complete', 'Chrome launch uses one real successful PC operation');
    assert(response.activities[0].preview, 'Launch returns a real desktop observation');
    assert((await invoke('workspace:snapshot', { conversationId: pc.id })).events.some(event => event.type === 'computer_observation'), 'Actual launch observation is in the authoritative journal');
    await win.screenshot({ path: path.join(dir, 'chrome-launch.png') });
  } else {
  if (live) {
    const models = await invoke('models:discover');
    report.availableModels = models.models.filter(model => model.enabled && !['offline', 'unsupported', 'auth_required'].includes(model.health)).length;
    assert(report.availableModels > 0, 'A real configured model is available');
  }
  const conversation = await ask('Hey SWARM.');
  assert((await invoke('projects:list')).filter(project => !project.isDemo).length === 0, 'Greeting starts no project');
  await ask("what's happening?");
  assert((await invoke('workspace:snapshot', { conversationId: conversation.id })).events.some(event => event.type === 'assistant_message'), 'Authoritative replay contains coordinator messages');
  for (const [width, height] of [[1440, 900], [900, 800], [680, 740]]) {
    await win.setViewportSize({ width, height });
    assert(!(await win.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `No horizontal overflow at ${width}px`);
    const screenshot = path.join(dir, `chat-${width}.png`);
    await win.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  }
  await win.getByRole('button', { name: 'Live work', exact: true }).first().click();
  await win.getByRole('dialog', { name: 'Live work drawer' }).waitFor();
  await win.waitForTimeout(200); // Wait for the drawer's entrance animation before visual verification.
  await win.screenshot({ path: path.join(dir, 'work-drawer.png') });
  await win.getByRole('button', { name: 'Close live work', exact: true }).click();
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.getByRole('button', { name: 'Agents', exact: true }).first().click();
  await win.getByRole('button', { name: 'Chat with Coder', exact: true }).click();
  assert((await invoke('chat:list')).some(chat => chat.agentRole === 'coder'), 'Opening specialist creates a persistent real role conversation');
  await ask('What are you working on?');
  await win.reload(); await win.locator('#chat-input').waitFor();
  assert((await win.locator('.chat-message').count()) >= 2, 'Conversation is restored after renderer reload');
  if (live) {
    await win.getByRole('button', { name: 'New chat', exact: true }).click();
    const pc = await ask('Check my PC and tell me which applications are open. Use a real screenshot and computer state; do not click or type.');
    const activities = pc.turns.flatMap(turn => turn.activities ?? []);
    assert(!/tool step limit/i.test(pc.turns.at(-1)?.text ?? ''), 'PC inspection ends with a useful observed result');
    assert(activities.some(activity => activity.tool.startsWith('computer.') && activity.status === 'complete'), 'Real computer tool completed in conversation');
    const snapshot = await invoke('workspace:snapshot', { conversationId: pc.id });
    assert(snapshot.events.some(event => event.type === 'computer_observation'), 'Real PC observation is replayable in live work');
    await win.screenshot({ path: path.join(dir, 'real-pc-chat.png') });
    if (stress) {
      const code = `IRIS ${Math.floor(100 + Math.random() * 900)}`;
      const fixture = '<html><body style="background:white;font:32px Arial;padding:40px"><h1>Screen verification</h1><p>The verification code is:</p><strong style="font-size:64px">' + code + '</strong><p><button style="font-size:32px;background:#1859df;color:white;padding:20px">Continue</button></p></body></html>';
      const inspection = await invoke('chat:new');
      await app.evaluate(async ({ BrowserWindow }, html) => { globalThis.testScreen = new BrowserWindow({width:800,height:600,title:'SWARM Screen Verification'}); await globalThis.testScreen.loadURL('data:text/html,' + encodeURIComponent(html)); globalThis.testScreen.setAlwaysOnTop(true); globalThis.testScreen.show(); globalThis.testScreen.focus(); }, fixture);
      console.log('SCREEN_VERIFICATION_READY');
      if (process.argv.includes('--inspect-hold')) await new Promise(resolve => setTimeout(resolve, 30000));
      const checked = await ask('Look at the SWARM Screen Verification window. Read its verification code and describe the color of the Continue button from a real screenshot. Do not click or type.', inspection.id);
      const reply = checked.turns.at(-1);
      assert(reply.text.includes(code), 'Vision response correctly reads the randomized code actually on screen');
      assert(/blue/i.test(reply.text), 'Vision response correctly identifies the visible blue button');
      assert(reply.activities.some(a => a.tool === 'computer.screenshot' && a.status === 'complete'), 'Screen verification used a real screenshot');
      assert(reply.activities.length === 1 && !reply.activities.some(a => a.status === 'error'), 'Screen inspection avoids malformed model tool attempts');
      const preview = reply.activities.find(a => a.preview)?.preview;
      if (preview) fs.writeFileSync(path.join(dir, 'observed-screen.jpg'), Buffer.from(preview.split(',')[1], 'base64'));
      await app.evaluate(() => globalThis.testScreen.close());
    }
  }
  }
  assert(report.errors.length === 0, 'No renderer exceptions');
} catch (error) { report.failure = String(error); process.exitCode = 1; await win.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {}); }
finally {
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  await app.close();
  console.log(JSON.stringify(report, null, 2));
}
