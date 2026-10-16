// Main-process micro-benchmarks. Runs real registry / router / chat-service code against fake providers.
// Usage (after bundling by scripts/perf-bench.mjs): node main-bench.cjs <scenario> <outDir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { initDb, db } from '../../electron/core/db';
import { bus } from '../../electron/core/bus';
import { getSettings } from '../../electron/core/settings';
import { ADAPTERS, discoverAll, getRegistryRevision, listModels, loadRegistry, recordSuccess } from '../../electron/providers/registry';
import { complete, rankModels } from '../../electron/router/router';
import { ProviderError } from '../../electron/providers/types';
import { chatPurpose } from '../../electron/chat/router';
import { getChat, newChat, sendChat } from '../../electron/chat/service';
import type { Capability } from '../../shared/types';
import type { Conversation } from '../../shared/chat';

const scenario = process.argv[2];
const outDir = process.argv[3] ?? '.';
const MODELS_PER_PROVIDER = Number(process.env.PERF_MODELS_PER_PROVIDER ?? 60);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ms = (n: number) => Math.round(n * 100) / 100;

// ---------- fake providers ----------
type Behavior = 'ok' | 'hang' | 'fail' | 'failOnce' | 'slow';
const behavior = new Map<string, Behavior>();
const failedOnce = new Set<string>();
const stats = { calls: 0, aborted: 0 };
const OK_TTFT = 40;
let streamPlan: { tokens: string[]; gapMs: number; marker: string } | null = null;

function caps(i: number): Capability[] {
  const base: Capability[] = ['chat'];
  if (i % 2 === 0) base.push('coding');
  if (i % 3 === 0) base.push('reasoning');
  if (i % 4 === 0) base.push('fast');
  if (i % 5 === 0) base.push('long_context');
  return base;
}
for (const a of ADAPTERS) {
  (a as { requiresKey: boolean }).requiresKey = false;
  (a as { needsAccountId: boolean }).needsAccountId = false;
  a.discover = async () => Array.from({ length: MODELS_PER_PROVIDER }, (_, i) => ({
    modelId: `m${i}-${[7, 8, 14, 32, 70, 120, 405][i % 7]}b`, displayName: `${a.id} model ${i}`, capabilities: caps(i),
    contextLength: [32768, 65536, 131072][i % 3], maxOutput: 8192, freeStatus: a.kind === 'local' ? 'local' as const : 'free_tier' as const,
  }));
  a.chat = async (_cfg, modelId, req) => {
    stats.calls++;
    const key = `${a.id}::${modelId}`;
    let b = behavior.get(key) ?? 'ok';
    if (b === 'failOnce') { if (failedOnce.has(key)) b = 'ok'; else { failedOnce.add(key); b = 'fail'; } }
    const started = Date.now();
    const abortErr = () => { stats.aborted++; return new ProviderError('cancelled', 'Cancelled'); };
    if (req.signal.aborted) throw abortErr();
    const wait = (t: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, t);
      req.signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortErr()); }, { once: true });
    });
    if (b === 'fail') { await sleep(5); throw new ProviderError('server', 'HTTP 503'); }
    if (b === 'hang') { await wait(req.firstTokenTimeoutMs); throw new ProviderError('timeout', `No response within ${Math.round(req.firstTokenTimeoutMs / 1000)}s`); }
    await wait(b === 'slow' ? 2500 : OK_TTFT);
    const ttft = Date.now() - started;
    const plan = streamPlan;
    if (plan) {
      let text = '';
      for (let i = 0; i < plan.tokens.length; i++) { const t = (i === 0 ? plan.marker : '') + plan.tokens[i]; text += t; req.onToken?.(t); if (i % 2 === 1) await sleep(plan.gapMs); }
      return { text, promptTokens: 1000, completionTokens: plan.tokens.length, finishReason: 'stop', latencyMs: Date.now() - started, ttftMs: ttft, usageEstimated: true };
    }
    for (let i = 0; i < 5; i++) { req.onToken?.(i === 0 ? 'ZZFIRSTZZ ' : 'tok '); await sleep(2); }
    return { text: 'ZZFIRSTZZ tok tok tok tok', promptTokens: 100, completionTokens: 20, finishReason: 'stop', latencyMs: Date.now() - started, ttftMs: ttft, usageEstimated: true };
  };
}

function setup() {
  initDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-perf-')), 'perf.db'));
  loadRegistry();
}
async function seedModels(measured = true) {
  await discoverAll();
  if (measured) for (const m of rankModels({ purpose: 'code', promptTokens: 2000, maxTokens: 2000 }).slice(0, 40)) for (let i = 0; i < 6; i++) recordSuccess(m.model.id, 900, 300, 100);
}
const top = (n: number, purpose: 'code' | 'classify' = 'code') => rankModels({ purpose, promptTokens: 2000, maxTokens: 2000 }).slice(0, n).map((r) => r.model.id);
const pctl = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

// ---------- scenarios ----------
async function discovery() {
  setup();
  let puts = 0, txs = 0;
  const d = db() as unknown as { put: (...a: unknown[]) => void; tx: <T>(fn: () => T) => T };
  const put = d.put.bind(d), tx = d.tx.bind(d);
  d.put = (...a) => { puts++; return put(...a); };
  d.tx = (fn) => { txs++; return tx(fn); };
  let broadcasts = 0, broadcastBytes = 0;
  bus.attach(() => undefined, (ch, payload) => { if (ch === 'models:changed') { broadcasts++; broadcastBytes += JSON.stringify(payload).length; } });
  const rev0 = getRegistryRevision();
  let t = performance.now(); await discoverAll(); const first = performance.now() - t;
  const firstPuts = puts, firstRev = getRegistryRevision() - rev0;
  puts = 0; txs = 0; const rev1 = getRegistryRevision();
  t = performance.now(); await discoverAll(); const second = performance.now() - t;
  await sleep(400);
  return { models: listModels().length, firstDiscoveryMs: ms(first), secondDiscoveryMs: ms(second), firstDbPuts: firstPuts, secondDbPuts: puts, secondDbTx: txs, firstRevisionBumps: firstRev, secondRevisionBumps: getRegistryRevision() - rev1, broadcasts, broadcastBytes };
}

async function rank() {
  setup(); await seedModels(true);
  const n = listModels().length;
  let t = performance.now();
  for (let i = 0; i < 300; i++) rankModels({ purpose: 'code', promptTokens: 1000 + i, maxTokens: 2000 });
  const cold = (performance.now() - t) / 300;
  t = performance.now();
  for (let i = 0; i < 3000; i++) rankModels({ purpose: 'code', promptTokens: 1500, maxTokens: 2000 });
  const warm = (performance.now() - t) / 3000;
  const ids = top(20);
  const rev0 = getRegistryRevision();
  let recSum = 0, rankSum = 0;
  const rankTimes: number[] = [];
  for (let i = 0; i < 300; i++) {
    let a = performance.now(); recordSuccess(ids[i % ids.length], 900 + (i % 7) * 10, 300 + (i % 5) * 10, 100); recSum += performance.now() - a;
    a = performance.now(); rankModels({ purpose: 'code', promptTokens: 1500, maxTokens: 2000 }); const r = performance.now() - a; rankSum += r; rankTimes.push(r);
  }
  return { models: n, coldRankMs: ms(cold), warmRankMs: ms(warm), recordSuccessMs: ms(recSum / 300), rankAfterRecordMs: ms(rankSum / 300), rankAfterRecordP95Ms: ms(pctl(rankTimes, 0.95)), revisionBumpsPer300Records: getRegistryRevision() - rev0 };
}

async function fallback(kind: 'hang1' | 'hang3' | 'slow1' | 'fail3' | 'flaky1' | 'unmeasuredHang1') {
  setup();
  const measured = kind !== 'unmeasuredHang1';
  await seedModels(measured);
  const s = getSettings();
  s.routing.firstTokenTimeoutSec = kind === 'unmeasuredHang1' ? 20 : 4;
  const ids = top(4);
  const plan: Record<string, Behavior[]> = { hang1: ['hang'], hang3: ['hang', 'hang', 'hang'], slow1: ['slow'], fail3: ['fail', 'fail', 'fail'], flaky1: ['failOnce'], unmeasuredHang1: ['hang'] };
  plan[kind].forEach((b, i) => behavior.set(ids[i], b));
  const t0 = performance.now(); let ttft = -1;
  const events: string[] = [];
  const r = await complete({ route: { purpose: 'code' }, messages: [{ role: 'user', content: 'hello' }], scope: {}, signal: new AbortController().signal, quiet: true, stream: true, onToken: () => { if (ttft < 0) ttft = performance.now() - t0; }, onReset: () => events.push('reset') });
  const total = performance.now() - t0;
  await sleep(50);
  const usage = db().list<{ ok: boolean }>('usage');
  return { timeToFirstTokenMs: ms(ttft), totalMs: ms(total), winner: r.model.id, firstPick: ids[0], fakeCalls: stats.calls, abortedCalls: stats.aborted, usageRows: usage.length, usageFailedRows: usage.filter((u) => !u.ok).length, recovered: r.recovered };
}

function markdownTokens(n: number) {
  const chunks = ['## Plan\n\n', 'Here is **an approach** with `inline code` and a [link](https://example.com).\n\n', '- first point about caching\n', '- second point about batching\n\n', '```ts\n', 'export function add(a: number, b: number) {\n', '  return a + b; // sum\n', '}\n', '```\n\n', 'Finally, measure again and compare the numbers.\n\n'];
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) for (const c of chunks) for (let k = 0; k < c.length; k += 4) out.push(c.slice(k, k + 4));
  return out.slice(0, n);
}
function bigConversation(turnCount: number, attachmentBytes: number): Conversation {
  const turns: Conversation['turns'] = [];
  const para = 'This is a previous answer with some **markdown**, `code` and details about the design. '.repeat(9);
  for (let i = 0; i < turnCount; i++) {
    const user = i % 2 === 0;
    turns.push({ id: `old_${i}`, role: user ? 'user' : 'assistant', text: user ? `Question ${i}: how should I structure module ${i}?` : para + `\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\``, status: 'complete', ...(user && i === 0 ? { attachments: [{ name: 'big.txt', text: 'x'.repeat(attachmentBytes) }] } : {}) });
  }
  return { id: 'chat_big', title: 'Big chat', updatedAt: Date.now(), turns };
}

async function chatStream(turnCount: number, attachmentBytes: number, label: string) {
  setup(); await seedModels(true);
  const conv = bigConversation(turnCount, attachmentBytes);
  db().put('conversations', conv.id, conv, { updated_at: conv.updatedAt });
  const tokens = markdownTokens(Number(process.env.PERF_TOKENS ?? 900));
  streamPlan = { tokens, gapMs: 10, marker: 'ZZFIRSTZZ' };
  let count = 0, bytes = 0, serMs = 0, firstTokenAt = -1, maxPayload = 0;
  const lines: string[] = [];
  const hist = monitorEventLoopDelay({ resolution: 1 }); hist.enable();
  let t0 = 0;
  bus.attach(() => undefined, (ch, payload) => {
    if (ch !== 'chat:updated') return;
    const a = performance.now(); const s = JSON.stringify(payload); serMs += performance.now() - a;
    count++; bytes += s.length; maxPayload = Math.max(maxPayload, s.length);
    if (firstTokenAt < 0 && s.includes('ZZFIRSTZZ')) firstTokenAt = performance.now() - t0;
    if (outDir && lines.length < 300) lines.push(s);
  });
  const cpu0 = process.cpuUsage();
  t0 = performance.now();
  sendChat({ id: conv.id, text: 'Summarize everything so far in detail please' });
  const sendReturnMs = performance.now() - t0;
  while (getChat(conv.id).turns.at(-1)?.status === 'streaming') await sleep(10);
  const total = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  hist.disable();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `replay-${label}.ndjson`), lines.join('\n'));
  fs.writeFileSync(path.join(outDir, `conv-${label}.json`), JSON.stringify(conv));
  fs.writeFileSync(path.join(outDir, 'settings.json'), JSON.stringify(getSettings()));
  return { turns: turnCount, attachmentBytes, updates: count, totalPayloadKB: Math.round(bytes / 1024), avgPayloadKB: ms(bytes / count / 1024), maxPayloadKB: ms(maxPayload / 1024), jsonStringifyMsTotal: ms(serMs), jsonStringifyMsPerUpdate: ms(serMs / count), sendReturnMs: ms(sendReturnMs), firstTokenOnBusMs: ms(firstTokenAt), streamTotalMs: ms(total), mainCpuMs: ms((cpu.user + cpu.system) / 1000), eventLoopP99Ms: ms(hist.percentile(99) / 1e6), eventLoopMaxMs: ms(hist.max / 1e6) };
}

async function researchSlow() {
  setup(); await seedModels(true);
  (globalThis as { __searchDelayMs?: number }).__searchDelayMs = Number(process.env.PERF_SEARCH_MS ?? 12000);
  const c = newChat();
  let first = -1; let t0 = 0;
  bus.attach(() => undefined, (ch, payload) => { if (ch === 'chat:updated' && first < 0 && JSON.stringify(payload).includes('ZZFIRSTZZ')) first = performance.now() - t0; });
  t0 = performance.now();
  sendChat({ id: c.id, text: 'Research the latest news about Electron releases' });
  while (getChat(c.id).turns.at(-1)?.status === 'streaming') await sleep(20);
  return { searchDelayMs: (globalThis as { __searchDelayMs?: number }).__searchDelayMs, firstTokenOnBusMs: ms(first), totalMs: ms(performance.now() - t0) };
}

// Labeled prompts: expected purpose for the best model class (judged by hand).
const LABELED: [string, string][] = [
  ['hi', 'classify'], ['thanks!', 'classify'], ['what is the capital of France?', 'classify'], ['translate "good morning" to Spanish', 'classify'], ['ok and the second one?', 'classify'], ['why?', 'classify'], ['can you shorten that?', 'classify'], ['give me a synonym for fast', 'classify'], ['yes please continue', 'classify'], ['who wrote Hamlet', 'classify'], ['summarize this in one line', 'classify'], ['what does API stand for', 'classify'],
  ['debug this Python code: def f(x): return x +', 'code'], ['write a JavaScript function that debounces calls', 'code'], ['why am I getting TypeError: undefined is not a function in my async handler', 'code'], ['refactor this React component to use hooks\n```tsx\nfunction A(){return <div/>}\n```', 'code'], ['write a SQL query joining orders and customers', 'code'], ['regex to match email addresses in typescript', 'code'], ['fix this bug in my Rust borrow checker error', 'code'], ['implement quicksort in C++', 'code'], ['how do I fix a segfault in this program', 'code'], ['write a bash script to rename files', 'code'], ['convert this CSS to Tailwind classes', 'code'], ['unit test for a stack class in Java', 'code'],
  ['design a distributed architecture for a chat system with trade-offs between consistency and availability', 'architecture'], ['prove that the sum of two even numbers is even', 'architecture'], ['reason step by step: if a train leaves at 3pm at 60mph and another at 4pm at 80mph when do they meet', 'architecture'], ['compare microservices vs monolith trade-offs for a 5 person team', 'architecture'], ['explain CAP theorem and how it influences database selection', 'architecture'], ['how would you scale a websocket service to 1M connections', 'architecture'], ['analyze the complexity of this algorithm and prove its correctness', 'architecture'],
  ['research the latest Android development tools', 'research'], ['what are the current sources on LLM benchmarks', 'research'], ['find the latest news about Electron 40', 'research'], ['what is the current price of bitcoin', 'research'], ['latest research on transformers efficiency', 'research'],
  ['I need a detailed plan for migrating our app. ' + 'Context about the system and requirements. '.repeat(60), 'plan'], ['please review the following long document and plan the next steps ' + 'paragraph '.repeat(300), 'plan'],
];
function purposeAccuracy() {
  let ok = 0; const wrong: string[] = [];
  for (const [text, want] of LABELED) { const got = chatPurpose(text); if (got === want) ok++; else wrong.push(`${want}!=${got}: ${text.slice(0, 40)}`); }
  const shortFollowups = LABELED.filter(([t, w]) => w === 'classify').map(([t]) => chatPurpose(t));
  return { prompts: LABELED.length, correct: ok, accuracyPct: ms((ok / LABELED.length) * 100), shortFollowupFastPct: ms(shortFollowups.filter((p) => p === 'classify').length / shortFollowups.length * 100), mismatches: wrong };
}

async function main() {
  const results: Record<string, () => Promise<unknown>> = {
    discovery, rank,
    hang1: () => fallback('hang1'), hang3: () => fallback('hang3'), slow1: () => fallback('slow1'), fail3: () => fallback('fail3'), flaky1: () => fallback('flaky1'), unmeasuredHang1: () => fallback('unmeasuredHang1'),
    chatBig: () => chatStream(200, 100_000, 'big'), chatSmall: () => chatStream(4, 0, 'small'),
    researchSlow, purpose: async () => purposeAccuracy(),
  };
  if (!results[scenario]) throw new Error('unknown scenario ' + scenario);
  const r = await results[scenario]();
  console.log('RESULT ' + JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
