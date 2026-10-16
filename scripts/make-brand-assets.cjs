// Renders installer/app artwork from the ZVYRA mark into build/.
// Run: npx electron scripts/make-brand-assets.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const out = path.join(__dirname, '..', 'build')
fs.mkdirSync(out, { recursive: true })

// New ribbon "Z" + rounded lowercase wordmark (same geometry as src/renderer/src/components/brand.tsx).
const ZO = 'M3.6 43.6C1.1 21.3 7.4 3.2 28.7 1.1H84C95 1.1 99 10 93 19L41.5 68.1C62.8 57.4 86.2 54.3 97.2 57C100 68.1 92.6 89.4 75.5 93.6H20.2C4 94.7-1 84 6 76L58.5 19.1C35.1 19.1 11.7 27.7 3.6 43.6Z'
const ZT = 'M3.6 43.6C11.7 27.7 35.1 19.1 58.5 19.1L63.5 13.8C36 13.6 11 23 3.6 43.6Z'
const ZB = 'M41.5 68.1C62.8 57.4 86.2 54.3 97.2 57C84 52.6 60 55.5 47.2 62.6Z'
const ZF = 'M58.5 19.1L93 19C88 27 70 31 52 26Z'
const Z = (size, glow = 5) => `
<svg width="${size}" height="${size * 0.96}" viewBox="-3 -3 106 102" overflow="visible">
  <defs>
    <linearGradient id="f" x1="0.05" y1="0" x2="0.95" y2="1"><stop offset="0" stop-color="#8fdcff"/><stop offset="0.32" stop-color="#3f93ff"/><stop offset="0.66" stop-color="#2b62f5"/><stop offset="1" stop-color="#b7a6ff"/></linearGradient>
    <radialGradient id="h" cx="0.22" cy="0.12" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9fbff" stop-opacity="0.95"/><stop offset="1" stop-color="#bfe6ff" stop-opacity="0.15"/></linearGradient>
    <linearGradient id="r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="0.5" stop-color="#d8e8ff" stop-opacity="0.25"/><stop offset="1" stop-color="#e6dcff" stop-opacity="0.7"/></linearGradient>
    <filter id="g" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceAlpha" stdDeviation="${glow}" result="b"/><feFlood flood-color="#3b7bff" flood-opacity="0.8"/><feComposite in2="b" operator="in" result="gl"/><feMerge><feMergeNode in="gl"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <g filter="url(#g)">
    <path d="${ZO}" fill="url(#f)"/><path d="${ZF}" fill="#1630b8" opacity="0.35"/>
    <path d="${ZT}" fill="url(#s)"/><path d="${ZB}" fill="url(#s)" opacity="0.85"/>
    <path d="${ZO}" fill="url(#h)"/><path d="${ZO}" fill="none" stroke="url(#r)" stroke-width="1.4"/>
  </g>
</svg>`

const WORD = (h, color) => `
<svg height="${h}" viewBox="0 6 170 50"><g fill="none" stroke="${color}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M5 16H29L5 41H30"/><path d="M40 16 53 41 66 16"/><path d="M76 16 89 40M102 16 85 52"/>
<path d="M113 41V16M113 28Q115 16 128 16"/><circle cx="148" cy="28.5" r="12.5"/><path d="M160.5 16V41"/></g></svg>`

const page = (w, h, body, bg = 'transparent') => `<!doctype html><html><head><style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg};font-family:'Segoe UI Variable Display','Segoe UI',sans-serif}
</style></head><body>${body}</body></html>`

const ICON = page(512, 512, `
<div style="position:absolute;inset:24px;border-radius:112px;overflow:hidden;
  background:radial-gradient(110% 90% at 50% 40%,#0d1a44 0%,#060b1e 55%,#02040b 100%);
  box-shadow:inset 0 0 0 3px rgba(130,170,255,.18)">
  <div style="position:absolute;left:50%;top:52%;width:360px;height:360px;margin:-180px;border-radius:50%;
    background:radial-gradient(circle,rgba(47,120,255,.55),transparent 65%)"></div>
  <div style="position:absolute;inset:0;display:grid;place-items:center;filter:drop-shadow(0 10px 40px rgba(40,110,255,.65))">${Z(300, 4)}</div>
</div>`)

const SIDEBAR = page(164, 314, `
<div style="position:absolute;inset:0;background:radial-gradient(140% 70% at 50% 18%,#1f45b8 0%,#0b1636 52%,#04070f 100%)"></div>
<div style="position:absolute;inset:0;background:
  linear-gradient(rgba(130,170,255,.07) 1px,transparent 1px) 0 0/18px 18px,
  linear-gradient(90deg,rgba(130,170,255,.07) 1px,transparent 1px) 0 0/18px 18px;
  -webkit-mask-image:radial-gradient(ellipse at 50% 30%,#000,transparent 70%)"></div>
<div style="position:absolute;left:50%;top:92px;width:150px;height:150px;margin:-75px;border-radius:50%;border:1px solid rgba(140,190,255,.25)"></div>
<div style="position:absolute;left:50%;top:92px;width:118px;height:118px;margin:-59px;border-radius:50%;background:radial-gradient(circle,rgba(47,130,255,.5),transparent 65%)"></div>
<div style="position:absolute;left:0;right:0;top:52px;display:grid;place-items:center;filter:drop-shadow(0 8px 16px rgba(20,100,255,.6))">${Z(88, 3)}</div>
<div style="position:absolute;left:0;right:0;top:178px;display:grid;place-items:center">${WORD(20, '#eef3ff')}</div>
<div style="position:absolute;left:0;right:0;top:204px;text-align:center;font-size:6.6px;letter-spacing:1.5px;color:rgba(190,210,255,.7)">YOUR AI OPERATING SYSTEM</div>
<div style="position:absolute;left:18px;right:18px;bottom:22px;height:1px;background:linear-gradient(90deg,transparent,rgba(60,200,255,.7),transparent)"></div>
<div style="position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:8px;color:rgba(190,210,255,.5)">Voice · Research · Build · Vision</div>`)

const HEADER = page(150, 57, `
<div style="position:absolute;inset:0;background:#ffffff"></div>
<div style="position:absolute;right:10px;top:0;bottom:0;display:flex;align-items:center;gap:8px">
  ${Z(36, 1.5)}
  ${WORD(14, '#0b1230')}
</div>`)

// Full brand lockup (also shipped as resources/logo.png).
const LOGO = page(1024, 1024, `
<div style="position:absolute;inset:0;background:radial-gradient(70% 60% at 50% 42%,#071233 0%,#02040b 70%,#000 100%)"></div>
<div style="position:absolute;left:0;right:0;top:170px;display:grid;place-items:center;filter:drop-shadow(0 0 60px rgba(40,110,255,.55))">${Z(470, 6)}</div>
<div style="position:absolute;left:0;right:0;top:700px;display:grid;place-items:center;filter:drop-shadow(0 0 18px rgba(120,170,255,.6))">${WORD(150, '#f2f5ff')}</div>`)

let win = null
async function render(html, w, h) {
  // One 512×512 transparent window for every piece; each page draws at the top-left and is cropped.
  win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, resizable: false, minWidth: 1, minHeight: 1, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  const tmp = path.join(require('node:os').tmpdir(), `zvyra-art-${w}x${h}.html`)
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  await new Promise((r) => setTimeout(r, 900))
  const img = await win.webContents.capturePage()
  win.destroy()
  win = null
  await new Promise((r) => setTimeout(r, 200))
  const s = img.getSize()
  return s.width === w && s.height === h ? img : img.resize({ width: w, height: h, quality: 'best' })
}

/** 24-bit bottom-up BMP from a NativeImage (BGRA bitmap). */
function toBmp(img) {
  const { width: w, height: h } = img.getSize()
  const src = img.toBitmap()
  const row = Math.ceil((w * 3) / 4) * 4
  const data = Buffer.alloc(row * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = (h - 1 - y) * row + x * 3
      data[d] = src[s]
      data[d + 1] = src[s + 1]
      data[d + 2] = src[s + 2]
    }
  }
  const head = Buffer.alloc(54)
  head.write('BM', 0)
  head.writeUInt32LE(54 + data.length, 2)
  head.writeUInt32LE(54, 10)
  head.writeUInt32LE(40, 14)
  head.writeInt32LE(w, 18)
  head.writeInt32LE(h, 22)
  head.writeUInt16LE(1, 26)
  head.writeUInt16LE(24, 28)
  head.writeUInt32LE(data.length, 34)
  head.writeInt32LE(2835, 38)
  head.writeInt32LE(2835, 42)
  return Buffer.concat([head, data])
}

app.disableHardwareAcceleration()
// Each render closes its window; don't let that end the script.
app.on('window-all-closed', () => undefined)
app.whenReady().then(async () => {
  const icon = await render(ICON, 512, 512, true)
  fs.writeFileSync(path.join(out, 'icon.png'), icon.toPNG())
  const side = await render(SIDEBAR, 164, 314, false)
  fs.writeFileSync(path.join(out, 'installerSidebar.bmp'), toBmp(side))
  fs.writeFileSync(path.join(out, 'uninstallerSidebar.bmp'), toBmp(side))

  const header = await render(HEADER, 150, 57, false)
  fs.writeFileSync(path.join(out, 'installerHeader.bmp'), toBmp(header))

  const logo = await render(LOGO, 1024, 1024, false)
  fs.writeFileSync(path.join(__dirname, '..', 'resources', 'logo.png'), logo.toPNG())

  console.log('brand assets written to', out)
  app.quit()
})
