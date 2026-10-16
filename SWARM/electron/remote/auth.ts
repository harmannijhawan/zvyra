// Request authentication: Bearer deviceId.secret + timestamp window + nonce replay cache + ECDSA signature.
import type { DeviceStore, StoredDevice } from './devices';
import { MAX_SKEW_MS, NONCE_TTL_MS, canonicalRequest, verifySignature } from './protocol';

export type Headers = Record<string, string | string[] | undefined>;
const h = (headers: Headers, name: string): string => {
  let v = headers[name];
  if (v === undefined) for (const k of Object.keys(headers)) if (k.toLowerCase() === name) { v = headers[k]; break; }
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/** Per-IP failure limiter: `max` failures within `windowMs` blocks the IP for `blockMs`. */
export class RateLimiter {
  private fails = new Map<string, { n: number; first: number; blockedUntil: number }>();
  constructor(private now: () => number = Date.now, private max = 10, private windowMs = 60_000, private blockMs = 60_000) {}
  /** Seconds to wait, or 0 if allowed. */
  blockedFor(ip: string): number {
    const e = this.fails.get(ip);
    if (!e) return 0;
    const t = this.now();
    if (e.blockedUntil > t) return Math.ceil((e.blockedUntil - t) / 1000);
    return 0;
  }
  fail(ip: string) {
    const t = this.now();
    let e = this.fails.get(ip);
    if (!e || t - e.first > this.windowMs) { e = { n: 0, first: t, blockedUntil: 0 }; this.fails.set(ip, e); }
    e.n++;
    if (e.n >= this.max) { e.blockedUntil = t + this.blockMs; e.n = 0; e.first = t; }
    if (this.fails.size > 5000) for (const [k, v] of this.fails) if (v.blockedUntil < t && t - v.first > this.windowMs) this.fails.delete(k);
  }
  success(ip: string) { this.fails.delete(ip); }
}

export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private now: () => number = Date.now, private ttlMs = NONCE_TTL_MS) {}
  /** Returns false if the nonce was already used (replay). */
  use(deviceId: string, nonce: string): boolean {
    const t = this.now();
    if (this.seen.size > 10_000 || (this.seen.size > 0 && Math.random() < 0.01)) for (const [k, exp] of this.seen) if (exp < t) this.seen.delete(k);
    const key = `${deviceId}:${nonce}`;
    const exp = this.seen.get(key);
    if (exp && exp >= t) return false;
    this.seen.set(key, t + this.ttlMs);
    return true;
  }
}

export interface AuthInput { method: string; target: string; headers: Headers; body: Buffer }
export type AuthResult = { ok: true; device: StoredDevice } | { ok: false };

export class Authenticator {
  constructor(private devices: DeviceStore, private nonces = new NonceCache(), private now: () => number = Date.now) {}

  authenticate(req: AuthInput): AuthResult {
    const bad: AuthResult = { ok: false };
    const authz = h(req.headers, 'authorization');
    const m = /^Bearer ([^.\s]{1,64})\.([A-Za-z0-9_-]{16,128})$/.exec(authz);
    const ts = h(req.headers, 'x-swarm-timestamp');
    const nonce = h(req.headers, 'x-swarm-nonce');
    const sig = h(req.headers, 'x-swarm-signature');
    if (!m || !ts || !nonce || !sig || nonce.length < 16 || nonce.length > 64 || !/^\d{10,16}$/.test(ts)) return bad;
    const [, deviceId, secret] = m;
    const device = this.devices.verify(deviceId, secret); // constant-time secret check
    if (!device) return bad;
    if (Math.abs(this.now() - Number(ts)) > MAX_SKEW_MS) return bad;
    const msg = canonicalRequest(req.method, req.target, ts, nonce, deviceId, req.body);
    if (!verifySignature(device.publicKey, msg, sig)) return bad;
    if (!this.nonces.use(deviceId, nonce)) return bad; // only burn the nonce after everything else checked out
    this.devices.touch(deviceId);
    return { ok: true, device };
  }
}