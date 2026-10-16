/**
 * Reachability helpers.
 *
 * LIMITATION: there is no free, reliable third-party service that can be asked to connect back to
 * this PC without an account, and many routers do not support "hairpin" connections (PC -> own
 * public IP). So `selfTestPort` only proves that a TCP connection to host:port succeeds from THIS
 * machine; a failure through the public address is inconclusive. The real test is the phone's
 * GET /v1/ping from mobile data.
 */
import net from 'node:net';

export interface SelfTestOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /** label only, copied into the result ('lan' | 'public' | 'ipv6' ...) */
  via?: string;
}

export interface SelfTestResult {
  ok: boolean;
  host: string;
  port: number;
  via?: string;
  latencyMs?: number;
  error?: string;
  note: string;
}

export function selfTestPort(opts: SelfTestOptions): Promise<SelfTestResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const started = Date.now();
  const note = 'Connect test from this PC only; a failure via a public address may just mean the router has no hairpin NAT.';
  return new Promise<SelfTestResult>((resolve) => {
    const sock = net.connect({ host: opts.host, port: opts.port });
    let done = false;
    const end = (r: Omit<SelfTestResult, 'host' | 'port' | 'via' | 'note'>): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ host: opts.host, port: opts.port, via: opts.via, note, ...r });
    };
    sock.setTimeout(timeoutMs, () => end({ ok: false, error: `timed out after ${timeoutMs} ms` }));
    sock.once('connect', () => end({ ok: true, latencyMs: Date.now() - started }));
    sock.once('error', (e) => end({ ok: false, error: e.message }));
  });
}

export interface TestListener {
  port: number;
  close(): Promise<void>;
}

/** Plain TCP listener that accepts and immediately closes connections. For tests / the probe CLI only. */
export function startTestListener(port = 0, host = '0.0.0.0'): Promise<TestListener> {
  return new Promise<TestListener>((resolve, reject) => {
    const server = net.createServer((s) => s.end());
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: p, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}