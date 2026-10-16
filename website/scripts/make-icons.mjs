/**
 * Builds the site's favicons from the ZVYRA ribbon Z (src/components/brand.tsx):
 *   public/favicon.svg, public/favicon.ico (16/32/48/64/256 PNG entries),
 *   public/apple-touch-icon.png (180px, from ../build/icon.png composition).
 * Run: node scripts/make-icons.mjs   (needs playwright-core + a Chromium, both in the repo root)
 */
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const src = readFileSync(here('../src/components/brand.tsx'), 'utf8')
const get = (n) => src.match(new RegExp(`${n} =\\s*'([^']+)'`))[1]
const O = get('Z_OUTLINE'), T = get('Z_TOP_SHEEN'), B = get('Z_BOTTOM_SHEEN'), F = get('Z_FOLD')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -6 108 108">
  <defs>
    <linearGradient id="f" x1="0.05" y1="0" x2="0.95" y2="1"><stop offset="0" stop-color="#8fdcff"/><stop offset="0.32" stop-color="#3f93ff"/><stop offset="0.66" stop-color="#2b62f5"/><stop offset="1" stop-color="#b7a6ff"/></linearGradient>
    <radialGradient id="h" cx="0.22" cy="0.12" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9fbff" stop-opacity="0.95"/><stop offset="1" stop-color="#bfe6ff" stop-opacity="0.15"/></linearGradient>
  </defs>
  <path d="${O}" fill="url(#f)"/><path d="${F}" fill="#1630b8" opacity="0.35"/>
  <path d="${T}" fill="url(#s)"/><path d="${B}" fill="url(#s)" opacity="0.85"/>
  <path d="${O}" fill="url(#h)"/>
</svg>
`
writeFileSync(here('../public/favicon.svg'), svg)

const b = await chromium.launch()
const png = async (size) => {
  const p = await b.newPage({ viewport: { width: size, height: size } })
  await p.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
  const buf = await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  await p.close()
  return buf
}
const sizes = [16, 32, 48, 64, 256]
const pngs = []
for (const s of sizes) pngs.push(await png(s))

// apple-touch-icon: the app icon tile (build/icon.png) resized to 180px
const tile = readFileSync(here('../../build/icon.png')).toString('base64')
const ap = await b.newPage({ viewport: { width: 180, height: 180 } })
await ap.setContent(`<body style="margin:0;background:#02040b"><img src="data:image/png;base64,${tile}" style="width:180px;height:180px;display:block;transform:scale(1.1)"></body>`)
writeFileSync(here('../public/apple-touch-icon.png'), await ap.screenshot({ clip: { x: 0, y: 0, width: 180, height: 180 } }))
await b.close()

// ICO container with PNG-compressed images
const head = Buffer.alloc(6)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(sizes.length, 4)
const dir = Buffer.alloc(16 * sizes.length)
let offset = 6 + dir.length
sizes.forEach((s, i) => {
  const o = i * 16
  dir.writeUInt8(s >= 256 ? 0 : s, o)
  dir.writeUInt8(s >= 256 ? 0 : s, o + 1)
  dir.writeUInt8(0, o + 2)
  dir.writeUInt8(0, o + 3)
  dir.writeUInt16LE(1, o + 4)
  dir.writeUInt16LE(32, o + 6)
  dir.writeUInt32LE(pngs[i].length, o + 8)
  dir.writeUInt32LE(offset, o + 12)
  offset += pngs[i].length
})
writeFileSync(here('../public/favicon.ico'), Buffer.concat([head, dir, ...pngs]))
console.log('icons written: favicon.svg, favicon.ico, apple-touch-icon.png')
