import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Authenticator, NonceCache, RateLimiter } from '../electron/remote/auth';
import { DeviceStore } from '../electron/remote/devices';
import { PairingManager } from '../electron/remote/pairing';
import { canonicalPair, pairCode, parsePublicKey, safeEqual, verifySignature } from '../electron/remote/protocol';
import { FakePhone } from './helpers/remoteClient';

describe('pairing tokens', () => {
  it('is single use', () => {
    const p = new PairingManager();
    const { token } = p.generate();
    expect(p.consume(token)).toBe(true);
    expect(p.consume(token)).toBe(false);
    expect(p.status().active).toBe(false);
  });
  it('expires after 120 s', () => {
    let t = 1_000_000;
    const p = new PairingManager(() => t);
    const { token, expiresAt } = p.generate();
    expect(expiresAt - t).toBe(120_000);
    t += 119_000; expect(p.status().active).toBe(true);
    t += 2_000;
    expect(p.consume(token)).toBe(false);
    expect(p.status().active).toBe(false);
  });
  it('locks out after 5 failed attempts, even for the right token', () => {
    const p = new PairingManager();
    const { token } = p.generate();
    for (let i = 0; i < 4; i++) expect(p.consume('wrong' + i)).toBe(false);
    expect(p.status().active).toBe(true);
    expect(p.consume('wrong5')).toBe(false);
    expect(p.status().active).toBe(false);
    expect(p.consume(token)).toBe(false);
  });
  it('a new token invalidates the previous one; tokens are 32 random bytes base64url', () => {
    const p = new PairingManager();
    const a = p.generate().token, b = p.generate().token;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.consume(a)).toBe(false);
  });
  it('safeEqual compares correctly', () => { expect(safeEqual('abc', 'abc')).toBe(true); expect(safeEqual('abc', 'abd')).toBe(false); expect(safeEqual('abc', 'abcd')).toBe(false); });
});

describe('device store', () => {
  it('stores only a salted hash and verifies the secret', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarm-dev-'));
    const file = path.join(dir, 'devices.json');
    const s = new DeviceStore(file);
    const phone = new FakePhone();
    const { secret, device } = s.add({ id: phone.deviceId, name: 'Pixel', publicKey: phone.publicKey });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain('"salt"');
    expect(s.verify(device.id, secret)?.id).toBe(device.id);
    expect(s.verify(device.id, secret + 'x')).toBeNull();
    expect(s.verify('nope', secret)).toBeNull();
    expect(() => s.add({ id: phone.deviceId, name: 'dup', publicKey: phone.publicKey })).toThrow();
    // persisted across restarts
    expect(new DeviceStore(file).verify(device.id, secret)).not.toBeNull();
    expect(s.revoke(device.id)).toBe(true);
    expect(s.verify(device.id, secret)).toBeNull();
    expect(new DeviceStore(file).list()).toHaveLength(0);
  });
  it('the same secret hashes differently per device (salt)', () => {
    const s = new DeviceStore(null);
    const a = new FakePhone(), b = new FakePhone();
    s.add({ id: a.deviceId, name: 'a', publicKey: a.publicKey }); s.add({ id: b.deviceId, name: 'b', publicKey: b.publicKey });
    const l = (s as unknown as { devices: Array<{ salt: string; hash: string }> }).devices;
    expect(l[0].salt).not.toBe(l[1].salt);
  });
});

describe('device keys', () => {
  it('accepts P-256 SPKI keys, rejects garbage; verifies signatures', () => {
    const p = new FakePhone();
    expect(parsePublicKey(p.publicKey)).not.toBeNull();
    expect(parsePublicKey('AAAA')).toBeNull();
    const msg = canonicalPair('t', p.deviceId, p.publicKey);
    expect(verifySignature(p.publicKey, msg, p.sign(msg))).toBe(true);
    expect(verifySignature(p.publicKey, msg + 'x', p.sign(msg))).toBe(false);
    expect(pairCode('t', p.deviceId, p.publicKey)).toMatch(/^\d{6}$/);
  });
});

describe('auth middleware', () => {
  function setup() {
    let now = 1_700_000_000_000;
    const store = new DeviceStore(null);
    const phone = new FakePhone();
    phone.secret = store.add({ id: phone.deviceId, name: 'P', publicKey: phone.publicKey }).secret;
    const auth = new Authenticator(store, new NonceCache(() => now), () => now);
    const call = (method: string, target: string, headers: Record<string, string>, body = '') => auth.authenticate({ method, target, headers, body: Buffer.from(body) }).ok;
    return { store, phone, auth, call, setNow: (n: number) => (now = n), now: () => now };
  }
  it('accepts a fully valid request', () => {
    const { phone, call, now } = setup();
    expect(call('GET', '/v1/agents', phone.authHeaders('GET', '/v1/agents', '', { ts: String(now()) }))).toBe(true);
  });
  it('rejects missing headers / no auth', () => {
    const { call, phone, now } = setup();
    expect(call('GET', '/v1/agents', {})).toBe(false);
    const h = phone.authHeaders('GET', '/v1/agents', '', { ts: String(now()) });
    for (const k of Object.keys(h)) { const c: Record<string, string> = { ...h }; delete c[k]; expect(call('GET', '/v1/agents', c)).toBe(false); }
  });
  it('rejects a wrong secret and an unknown device', () => {
    const { call, phone, now } = setup();
    expect(call('GET', '/v1/agents', phone.authHeaders('GET', '/v1/agents', '', { ts: String(now()), secret: 'x'.repeat(43) }))).toBe(false);
    const other = new FakePhone(); other.secret = 'y'.repeat(43);
    expect(call('GET', '/v1/agents', other.authHeaders('GET', '/v1/agents', '', { ts: String(now()) }))).toBe(false);
  });
  it('rejects a valid secret signed by the wrong key (secret alone is not enough)', () => {
    const { call, phone, now } = setup();
    const attacker = new FakePhone(); attacker.deviceId = phone.deviceId; attacker.secret = phone.secret;
    expect(call('GET', '/v1/agents', attacker.authHeaders('GET', '/v1/agents', '', { ts: String(now()) }))).toBe(false);
  });
  it('binds the signature to method, target and body', () => {
    const { call, phone, now } = setup();
    const h = phone.authHeaders('POST', '/v1/agents/a/task', '{"text":"hi"}', { ts: String(now()) });
    expect(call('POST', '/v1/agents/a/task', h, '{"text":"evil"}')).toBe(false);
    expect(call('POST', '/v1/agents/b/task', h, '{"text":"hi"}')).toBe(false);
    expect(call('GET', '/v1/agents/a/task', h, '{"text":"hi"}')).toBe(false);
  });
  it('rejects replays and stale/future timestamps', () => {
    const { call, phone, now } = setup();
    const h = phone.authHeaders('GET', '/v1/status', '', { ts: String(now()) });
    expect(call('GET', '/v1/status', h)).toBe(true);
    expect(call('GET', '/v1/status', h)).toBe(false); // same nonce
    expect(call('GET', '/v1/status', phone.authHeaders('GET', '/v1/status', '', { ts: String(now() - 61_000) }))).toBe(false);
    expect(call('GET', '/v1/status', phone.authHeaders('GET', '/v1/status', '', { ts: String(now() + 61_000) }))).toBe(false);
  });
  it('rejects revoked devices immediately', () => {
    const { call, phone, store, now } = setup();
    expect(call('GET', '/v1/status', phone.authHeaders('GET', '/v1/status', '', { ts: String(now()) }))).toBe(true);
    store.revoke(phone.deviceId);
    expect(call('GET', '/v1/status', phone.authHeaders('GET', '/v1/status', '', { ts: String(now()) }))).toBe(false);
  });
});

describe('rate limiter', () => {
  it('blocks an IP after repeated failures and recovers', () => {
    let t = 0;
    const r = new RateLimiter(() => t, 3, 60_000, 30_000);
    expect(r.blockedFor('1.1.1.1')).toBe(0);
    r.fail('1.1.1.1'); r.fail('1.1.1.1'); expect(r.blockedFor('1.1.1.1')).toBe(0);
    r.fail('1.1.1.1'); expect(r.blockedFor('1.1.1.1')).toBeGreaterThan(0);
    expect(r.blockedFor('2.2.2.2')).toBe(0);
    t += 31_000; expect(r.blockedFor('1.1.1.1')).toBe(0);
  });
});