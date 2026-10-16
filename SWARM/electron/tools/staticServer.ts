// Built-in static file server for projects without their own dev server.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.avif': 'image/avif', '.map': 'application/json',
};

export function freePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => (preferred ? freePort(0).then(resolve, reject) : reject(new Error('No free port'))));
    srv.listen(preferred, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const servers = new Map<string, http.Server>();

export async function serveStatic(key: string, dir: string, port?: number): Promise<{ url: string; port: number; stop: () => void }> {
  stopStatic(key);
  const p = port ?? (await freePort());
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = path.resolve(root, '.' + urlPath);
      if (!file.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) {
        if (!path.extname(urlPath) && fs.existsSync(file + '.html')) file = file + '.html';
        else if (!path.extname(urlPath) && fs.existsSync(path.join(root, 'index.html'))) file = path.join(root, 'index.html'); // SPA fallback
        else { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(500).end('Server error'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', () => resolve()); });
  servers.set(key, server);
  return { url: `http://127.0.0.1:${p}/`, port: p, stop: () => stopStatic(key) };
}

export function stopStatic(key: string) {
  const s = servers.get(key);
  if (s) { s.close(); s.closeAllConnections?.(); servers.delete(key); }
}

export function stopAllStatic() { for (const k of [...servers.keys()]) stopStatic(k); }

export async function waitForHttp(url: string, timeoutMs: number, signal?: AbortSignal, isAlive?: () => boolean): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (isAlive && !isAlive()) throw new Error('Server process exited before becoming ready');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(t);
      await res.arrayBuffer().catch(() => undefined);
      return res.status;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not respond at ${url} within ${Math.round(timeoutMs / 1000)}s`);
}
