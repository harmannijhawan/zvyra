/**
 * OWNER: Kiro. Local preview server for generated static sites.
 * Bound to 127.0.0.1 on a random port, read-only, no directory listing,
 * no path traversal outside the site folder. One server per folder, reused.
 */
import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

const servers = new Map<string, { server: Server; url: string }>()

export async function serveStatic(rootDir: string): Promise<string> {
  const root = await realpath(rootDir)
  const existing = servers.get(root.toLowerCase())
  if (existing?.server.listening) return existing.url
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      let file = normalize(join(root, path))
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end()
        return
      }
      let st = await stat(file).catch(() => null)
      if (st?.isDirectory()) {
        file = join(file, 'index.html')
        st = await stat(file).catch(() => null)
      }
      if (!st?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      // Symlinks must not escape the site folder either.
      const real = await realpath(file)
      if (real !== root && !real.startsWith(root + sep)) {
        res.writeHead(403).end()
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      if (req.method === 'HEAD') res.end()
      else createReadStream(real).pipe(res)
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  server.unref()
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
  servers.set(root.toLowerCase(), { server, url })
  return url
}

/** Maps a file inside a served folder to its preview URL. */
export async function previewUrl(rootDir: string, file?: string): Promise<string> {
  const base = await serveStatic(rootDir)
  if (!file) return base
  const rel = resolve(file).slice(resolve(rootDir).length).replace(/\\/g, '/').replace(/^\//, '')
  return base + rel.split('/').map(encodeURIComponent).join('/')
}

export function stopAllServers() {
  for (const { server } of servers.values()) server.close()
  servers.clear()
}
