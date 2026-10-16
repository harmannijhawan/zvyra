// Test double of the Android companion: ECDSA P-256 device key, request signing, pinned-fingerprint HTTPS client.
import { generateKeyPairSync, randomUUID, randomBytes, sign } from 'node:crypto';
import https from 'node:https';
import { WebSocket } from 'ws';
import { canonicalPair, canonicalRequest } from '../../electron/remote/protocol';

export class FakePhone {
  deviceId = randomUUID();
  secret = '';
  private kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  publicKey = this.kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  constructor(public port = 0, public fingerprint = '', public host = '127.0.0.1') {}
  sign(msg: string) { return sign('sha256', Buffer.from(msg, 'utf8'), this.kp.privateKey).toString('base64url'); }

  authHeaders(method: string, target: string, body = '', over: Partial<{ ts: string; nonce: string; secret: string }> = {}) {
    const ts = over.ts ?? String(Date.now());
    const nonce = over.nonce ?? randomBytes(16).toString('base64url');
    return {
      Authorization: `Bearer ${this.deviceId}.${over.secret ?? this.secret}`,
      'X-Swarm-Timestamp': ts, 'X-Swarm-Nonce': nonce,
      'X-Swarm-Signature': this.sign(canonicalRequest(method, target, ts, nonce, this.deviceId, body)),
    };
  }

  pairBody(token: string, name = 'Test Phone') {
    return { token, deviceName: name, deviceId: this.deviceId, publicKey: this.publicKey, proof: this.sign(canonicalPair(token, this.deviceId, this.publicKey)) };
  }

  /** HTTPS request that pins the server certificate fingerprint (like the Android app). */
  request(method: string, target: string, opts: { body?: unknown; headers?: Record<string, string>; signed?: boolean } = {}) {
    const raw = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.signed ? this.authHeaders(method, target, raw) : {}), ...opts.headers };
    if (raw) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(raw)); }
    return new Promise<{ status: number; json: any; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = https.request({ host: this.host, port: this.port, method, path: target, headers, rejectUnauthorized: false, agent: false }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json: unknown = null; try { json = JSON.parse(d); } catch { /* */ } resolve({ status: res.statusCode ?? 0, json, headers: res.headers }); });
      });
      req.on('socket', (s) => s.on('secureConnect', () => {
        const fp = (s as import('node:tls').TLSSocket).getPeerCertificate().fingerprint256.replace(/:/g, '').toLowerCase();
        if (this.fingerprint && fp !== this.fingerprint) req.destroy(new Error('certificate pin mismatch'));
      }));
      req.on('error', reject);
      req.end(raw || undefined);
    });
  }

  ws(headersOverride?: Record<string, string>) {
    const headers = headersOverride ?? this.authHeaders('GET', '/v1/ws');
    const host = this.host.includes(':') ? `[${this.host}]` : this.host;
    const ws = new WebSocket(`wss://${host}:${this.port}/v1/ws`, { headers, rejectUnauthorized: false });
    ws.on('upgrade', response => {
      const certificate = (response.socket as import('node:tls').TLSSocket).getPeerCertificate();
      const actual = certificate.fingerprint256?.replace(/:/g, '').toLowerCase();
      if (this.fingerprint && actual !== this.fingerprint) ws.terminate();
    });
    return ws;
  }
}

export function collect(ws: WebSocket) {
  const msgs: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()); msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const next = (pred: (m: any) => boolean, ms = 4000) => new Promise<any>((res, rej) => {
    const hit = msgs.find(pred); if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), ms);
    waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
  });
  return { msgs, next };
}
