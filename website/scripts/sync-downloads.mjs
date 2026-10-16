/**
 * Copies self-hosted installers listed in src/config/downloads.ts from ../release
 * into public/downloads/ and verifies their SHA-256, so a download button never
 * points at a missing or mismatched file.
 *
 * Only reads ../release and only writes public/downloads/.
 * Deployers: dist/downloads/ then contains the installer (~124 MB) and must be
 * deployed with the site, or switch the entry's url to an https:// host.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOWNLOADS, isDownloadable } from '../src/config/downloads.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(root, '..', 'release')

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex').toUpperCase())).on('error', fail)
  })

let failed = false
for (const p of Object.values(DOWNLOADS)) {
  if (!isDownloadable(p)) {
    console.log(`[sync-downloads] skip ${p.id}: not available (url missing)`)
    continue
  }
  if (!p.url.startsWith('/')) {
    console.log(`[sync-downloads] skip ${p.id}: external url ${p.url}`)
    continue
  }
  const dest = join(root, 'public', p.url)
  const src = join(releaseDir, p.fileName)
  if (existsSync(dest) && statSync(dest).size === p.sizeBytes) {
    console.log(`[sync-downloads] ok ${p.fileName}`)
    continue
  }
  if (!existsSync(src)) {
    console.error(`[sync-downloads] ERROR ${p.fileName} not found in ${releaseDir}. Build it or set an https:// url in src/config/downloads.ts.`)
    failed = true
    continue
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  const got = await sha256(dest)
  if (p.sha256 && got !== p.sha256.toUpperCase()) {
    rmSync(dest)
    console.error(`[sync-downloads] ERROR checksum mismatch for ${p.fileName}: expected ${p.sha256}, got ${got}. Update sha256/sizeBytes in src/config/downloads.ts if the installer was rebuilt.`)
    failed = true
    continue
  }
  console.log(`[sync-downloads] copied + verified ${p.fileName}`)
}
if (failed) process.exit(1)
