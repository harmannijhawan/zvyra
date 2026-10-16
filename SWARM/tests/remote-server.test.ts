// End-to-end: real HTTPS + WebSocket server, a fake phone pinning the TLS fingerprint, fake SWARM backend behind the Gateway.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateCert } from '../electron/remote/cert';
import { DeviceStore } from '../electron/remote/devices';
import { Gateway } from '../electron/remote/gateway';
import { PairingManager } from '../electron/remote/pairing';
import { RemoteServer } from '../electron/remote/server';
import { ManualRoute, RouteManager, UpnpRoute, classifyRemoteAddress, fmtHost, type RouteProvider, type UpnpClientLike } from '../electron/remote/routes';
import { collect, FakePhone } from './helpers/remoteClient';

const calls: Array<[string, unknown[]]> = [];
const state = {
  projects: [{ id: 'p1', name: 'Shop', objective: 'Build a shop', status: 'idle', archived: false, updatedAt: Date.now() }, { id: 'p2', name: 'Empty', objective: '', status: 'idle', archived: false, updatedAt: Date.now() }],
  runs: [] as Array<{ id: string; projectId: string; objective: string; status: string; startedAt: number }>,
  approvals: [
    { id: 'ap1', ts: 1, projectId: 'p1', runId: 'r99', agent: 'coder', kind: 'command', title: 'Run npm test', detail: 'npm test', risk: 'low' },
    { id: 'ap2', ts: 2, projectId: 'p1', runId: 'r99', agent: 'coder', kind: 'fs_delete', title: 'Delete dir', detail: 'rm -r x', risk: 'high' },
  ],
};
const invoke = async (channel: string, ...args: unknown[]) => {
  calls.push([channel, args]);
  switch (channel) {
    case 'projects:list': return state.projects;
    case 'runs:active': return state.runs;
    case 'approvals:list': return state.approvals;
    case 'runs:start': { const r = { id: 'r' + (state.runs.length + 1), projectId: args[0] as string, objective: args[1] as string, status: 'running', startedAt: Date.now() }; state.runs.push(r); return r; }
    case 'runs:cancel': state.runs = state.runs.filter((r) => r.id !== args[0]); return true;
    case 'run:chat:send': return { ok: true };
    case 'approvals:resolve': state.approvals = state.approvals.filter((a) => a.id !== args[0]); return true;
    default: return null;
  }
};

const HOSTS = ['192.168.1.20:47821', '[2001:db8::5]:47821', 'rtc:abc'];
let srv: RemoteServer; let phone: FakePhone; let pairing: PairingManager; let devices: DeviceStore; let fp = ''; let accept = true;
beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarm-remote-'));
  const tls = await loadOrCreateCert(path.join(dir, 'tls.json'));
  fp = tls.fingerprint;
  devices = new DeviceStore(path.join(dir, 'devices.json'));
  pairing = new PairingManager();
  srv = new RemoteServer({ tls, port: 0, pcName: 'TestPC', devices, pairing, gateway: new Gateway(invoke, { pcName: 'TestPC', appVersion: '1.0.0' }), confirmPair: async () => accept, getHosts: async () => HOSTS });
  const port = await srv.start();
  phone = new FakePhone(port, fp);
});
afterAll(async () => { await srv.stop(); });

describe('remote bridge (TLS, pairing, REST, WebSocket)', () => {
  it('fingerprint is 64 lowercase hex and ping works unauthenticated', async () => {
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const r = await phone.request('GET', '/v1/ping');
    expect(r.status).toBe(200); expect(r.json).toEqual({ ok: true, v: 1 });
  });
  it('rejects unauthenticated calls with 401', async () => {
    for (const p of ['/v1/status', '/v1/agents', '/v1/approvals']) {
      const r = await phone.request('GET', p);
      expect(r.status).toBe(401); expect(r.json).toEqual({ error: 'unauthorized' });
    }
    expect((await phone.request('POST', '/v1/agents/p1/start', { body: {} })).status).toBe(401);
    expect((await phone.request('POST', '/v1/invoke', { body: { channel: 'chat:new' } })).status).toBe(401);
    expect((await phone.request('GET', '/v1/devices', { signed: true })).status).toBe(401); // not exposed (and phone not paired yet)
  });
  it('rejects pairing without a valid token', async () => {
    expect((await phone.request('POST', '/v1/pair', { body: phone.pairBody('nope') })).json).toEqual({ error: 'invalid_token' });
    expect((await phone.request('POST', '/v1/pair', { body: { token: 1 } })).status).toBe(400);
  });
  it('pairs once; token cannot be reused; bad proof is rejected', async () => {
    const t1 = pairing.generate().token;
    const other = new FakePhone(phone.port, fp);
    const forged = { ...phone.pairBody(t1), proof: other.sign('whatever') };
    expect((await phone.request('POST', '/v1/pair', { body: forged })).status).toBe(401);
    const t2 = pairing.generate().token;
    const r = await phone.request('POST', '/v1/pair', { body: phone.pairBody(t2) });
    expect(r.status).toBe(200);
    expect(r.json.deviceId).toBe(phone.deviceId); expect(r.json.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    phone.secret = r.json.deviceSecret;
    expect((await phone.request('POST', '/v1/pair', { body: phone.pairBody(t2) })).status).toBe(401);
    expect(devices.list().map((d) => d.id)).toContain(phone.deviceId);
  });
  it('declined confirmation on the PC does not pair', async () => {
    accept = false;
    const p2 = new FakePhone(phone.port, fp);
    const r = await p2.request('POST', '/v1/pair', { body: p2.pairBody(pairing.generate().token) });
    accept = true;
    expect(r.status).toBe(403); expect(devices.list().some((d) => d.id === p2.deviceId)).toBe(false);
  });
  it('authenticated REST: status, agents, start, task, stop', async () => {
    expect((await phone.request('GET', '/v1/status', { signed: true })).json).toMatchObject({ v: 1, pcName: 'TestPC', agentCount: 2, hosts: HOSTS });
    let list = (await phone.request('GET', '/v1/agents', { signed: true })).json.agents;
    expect(list[0]).toMatchObject({ id: 'p1', name: 'Shop', status: 'idle', task: null });
    const st = await phone.request('POST', '/v1/agents/p1/start', { signed: true, body: {} });
    expect(st.status).toBe(200); expect(st.json.agent).toMatchObject({ id: 'p1', status: 'running', task: 'Build a shop' });
    expect((await phone.request('POST', '/v1/agents/p1/start', { signed: true, body: {} })).status).toBe(409);
    const tk = await phone.request('POST', '/v1/agents/p1/task', { signed: true, body: { text: 'make it blue' } });
    expect(tk.status).toBe(200);
    expect(calls.some(([c, a]) => c === 'run:chat:send' && (a[0] as { text: string }).text === 'make it blue')).toBe(true);
    expect((await phone.request('POST', '/v1/agents/p1/task', { signed: true, body: { text: '' } })).status).toBe(400);
    expect((await phone.request('POST', '/v1/agents/nope/stop', { signed: true, body: {} })).status).toBe(404);
    expect((await phone.request('POST', '/v1/agents/p2/start', { signed: true, body: {} })).status).toBe(409); // no objective
    expect((await phone.request('POST', '/v1/agents/p1/stop', { signed: true, body: {} })).json.agent.status).toBe('stopped');
    list = (await phone.request('GET', '/v1/agents', { signed: true })).json.agents;
    expect(list[0].status).toBe('idle');
  });
  it('rejects replayed signed requests', async () => {
    const h = phone.authHeaders('GET', '/v1/status');
    const ok = await phone.request('GET', '/v1/status', { headers: h });
    const again = await phone.request('GET', '/v1/status', { headers: h });
    expect([ok.status, again.status]).toEqual([200, 401]);
  });
  it('authenticates mobile application invocations and enforces the same gateway', async () => {
    const ok = await phone.request('POST', '/v1/invoke', { signed: true, body: { channel: 'projects:list', args: [] } });
    expect(ok.status).toBe(200);
    expect(ok.json.data[0].id).toBe('p1');
    const denied = await phone.request('POST', '/v1/invoke', { signed: true, body: { channel: 'terminal:run', args: ['whoami'] } });
    expect(denied.status).toBe(403);
    const invalid = await phone.request('POST', '/v1/invoke', { signed: true, body: { channel: 'chat:send', args: [{ id: 'c1', text: '' }] } });
    expect(invalid.status).toBe(400);
  });
  it('approvals: no "always"; high-risk needs confirm', async () => {
    const list = (await phone.request('GET', '/v1/approvals', { signed: true })).json.approvals;
    expect(list.find((a: { id: string }) => a.id === 'ap2').needsConfirm).toBe(true);
    expect((await phone.request('POST', '/v1/approvals/ap2/resolve', { signed: true, body: { approved: true } })).status).toBe(428);
    expect((await phone.request('POST', '/v1/approvals/ap1/resolve', { signed: true, body: { approved: true } })).status).toBe(200);
    const last = calls.filter(([c]) => c === 'approvals:resolve').at(-1)!;
    expect(last[1]).toEqual(['ap1', true, false]);
    expect((await phone.request('POST', '/v1/approvals/ap2/resolve', { signed: true, body: { approved: true, confirm: true } })).status).toBe(200);
  });
  it('WebSocket requires auth; works with it; enforces counters; blocks forbidden channels', async () => {
    await expect(new Promise((res, rej) => { const w = phone.ws({}); w.on('open', () => res('open')); w.on('error', rej); w.on('unexpected-response', (_q, r) => rej(new Error('HTTP ' + r.statusCode))); })).rejects.toThrow('HTTP 401');
    const ws = phone.ws();
    const c = collect(ws);
    await new Promise((r) => ws.on('open', r));
    const hello = await c.next((m) => m.type === 'hello');
    expect(hello.pcName).toBe('TestPC'); expect(hello.hosts).toEqual(HOSTS);
    const snap = await c.next((m) => m.type === 'snapshot');
    expect(snap.agents).toHaveLength(2); expect(snap.seq).toBe(1);
    ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 'a', ctr: 1, cmd: 'agents.list' }));
    expect((await c.next((m) => m.id === 'a')).data.agents).toHaveLength(2);
    ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 'b', ctr: 1, cmd: 'agents.list' })); // counter reuse
    expect(await c.next((m) => m.id === 'b')).toMatchObject({ ok: false, error: 'replay' });
    ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 'a', ctr: 9, cmd: 'agents.list' })); // id reuse
    expect(await c.next((m) => m.id === 'a' && m.ok === false)).toMatchObject({ error: 'replay' });
    for (const [i, ch] of ['terminal:run', 'projects:writeFile', 'providers:setKey', 'settings:update', 'app:openPath', 'app:exportData'].entries()) {
      ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 'x' + i, ctr: 10 + i, cmd: 'invoke', args: { channel: ch, args: [] } }));
      expect(await c.next((m) => m.id === 'x' + i)).toMatchObject({ ok: false, error: 'forbidden_channel' });
    }
    expect(calls.some(([ch]) => ch === 'terminal:run')).toBe(false);
    ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 'ok1', ctr: 30, cmd: 'invoke', args: { channel: 'runs:active', args: [] } }));
    expect(await c.next((m) => m.id === 'ok1')).toMatchObject({ ok: true });
    // live push on agent change
    ws.send(JSON.stringify({ v: 1, type: 'cmd', id: 's', ctr: 31, cmd: 'agent.start', args: { agentId: 'p1' } }));
    expect(await c.next((m) => m.id === 's')).toMatchObject({ ok: true });
    const pushed = await c.next((m) => m.type === 'snapshot' && m.seq > 1 && m.agents[0].status === 'running');
    expect(pushed.agents[0].task).toBe('Build a shop');
    srv.publishEvent({ id: 'e1', message: 'hello' });
    expect((await c.next((m) => m.type === 'event')).event.message).toBe('hello');
    // revoking closes the socket with 4401
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    devices.revoke(phone.deviceId);
    expect(await closed).toBe(4401);
    expect((await phone.request('GET', '/v1/status', { signed: true })).status).toBe(401);
  });
  it('rate limits repeated failures', async () => {
    const p = new FakePhone(phone.port, fp);
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await p.request('GET', '/v1/status', { headers: { Authorization: 'Bearer bad.' + 'z'.repeat(20) } })).status;
    expect(last).toBe(429);
  });
  it('refuses a mismatching pinned fingerprint', async () => {
    const bad = new FakePhone(phone.port, '0'.repeat(64));
    await expect(bad.request('GET', '/v1/ping')).rejects.toThrow();
  });
});

describe('routes', () => {
  it('formats hosts and classifies peers', () => {
    expect(fmtHost('192.168.1.2', 47821)).toBe('192.168.1.2:47821');
    expect(fmtHost('2001:db8::1', 47821)).toBe('[2001:db8::1]:47821');
    expect(classifyRemoteAddress('::ffff:192.168.1.9')).toBe('lan');
    expect(classifyRemoteAddress('203.0.113.9')).toBe('public');
    expect(classifyRemoteAddress('2401:db8::5')).toBe('ipv6');
    expect(classifyRemoteAddress('127.0.0.1')).toBe('local');
  });
  it('manual route normalises host', async () => {
    for (const [input, want] of [['pc.example.org', 'pc.example.org:47821'], ['pc.example.org:9000', 'pc.example.org:9000'], ['1.2.3.4', '1.2.3.4:47821'], ['', null]] as const) {
      const r = new ManualRoute(() => input);
      expect(await r.endpoints({ port: 47821 })).toEqual(want ? [want] : []);
    }
  });
  it('UPnP maps, reports the mapped endpoint, unmaps on stop; failure is graceful', async () => {
    const log: string[] = [];
    const ok: UpnpClientLike = { createMapping: async (o) => { log.push('map' + o.public); }, removeMapping: async (o) => { log.push('unmap' + o.public); }, getPublicIp: async () => '203.0.113.7', close: () => { log.push('close'); } };
    const r = new UpnpRoute(async () => ok);
    await r.start({ port: 47821 });
    await new Promise((x) => setTimeout(x, 50));
    expect(r.status()).toMatchObject({ state: 'ready', endpoints: ['203.0.113.7:47821'] });
    await r.stop();
    expect(log).toEqual(['map47821', 'unmap47821', 'close']);
    expect(r.status().state).toBe('off');
    const bad = new UpnpRoute(async () => ({ ...ok, getPublicIp: async () => { throw new Error('boom'); } }));
    await bad.start({ port: 1 }); await new Promise((x) => setTimeout(x, 50));
    expect(bad.status().state).toBe('failed'); expect(await bad.endpoints()).toEqual([]);
    const priv = new UpnpRoute(async () => ({ ...ok, getPublicIp: async () => '10.0.0.1' }));
    await priv.start({ port: 1 }); await new Promise((x) => setTimeout(x, 50));
    expect(priv.status().state).toBe('unavailable');
  });
  it('RouteManager orders by priority, de-duplicates, survives broken providers', async () => {
    const mk = (id: string, priority: number, eps: string[], broken = false): RouteProvider => ({ id, label: id, priority, start: async () => {}, stop: async () => {}, endpoints: async () => { if (broken) throw new Error('x'); return eps; }, status: () => ({ id, label: id, state: eps.length ? 'ready' : 'off', endpoints: eps, detail: '' }) });
    const m = new RouteManager().add(mk('c', 30, ['rtc:abc'])).add(mk('a', 10, ['1.1.1.1:1', 'dup:1'])).add(mk('bad', 15, [], true)).add(mk('b', 20, ['dup:1', '[::1]:1']));
    await m.startAll({ port: 1 });
    expect(await m.collectHosts()).toEqual(['1.1.1.1:1', 'dup:1', '[::1]:1', 'rtc:abc']);
    expect(m.likely()).toBe('a');
  });
});
