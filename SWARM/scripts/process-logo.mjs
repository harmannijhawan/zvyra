// Derives transparent, cropped brand assets from the original SWARM logo files.
// The artwork itself is not redrawn: pixels are copied 1:1, only the white
// background is converted to transparency and the canvas is cropped.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const root = path.resolve(import.meta.dirname, '..');
const outDirs = [path.join(root, 'resources'), path.join(root, 'src', 'assets', 'brand')];
const publicDir = path.join(root, 'public');
for (const d of outDirs) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

const read = (f) => PNG.sync.read(fs.readFileSync(path.join(root, f)));
const write = (png, name) => {
  const buf = PNG.sync.write(png);
  for (const d of outDirs) fs.writeFileSync(path.join(d, name), buf);
  if (name === 'icon.png') fs.writeFileSync(path.join(publicDir, name), buf);
  console.log('wrote', name, png.width + 'x' + png.height);
};

/** Build a Windows-native ICO from PNG frames (supported by Windows Vista+). */
function writeIco(png, name) {
  const sizes = [256, 128, 64, 48, 32, 16];
  const frames = sizes.map((size) => PNG.sync.write(downscale(png, size)));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index];
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  const out = Buffer.concat([header, ...frames]);
  for (const d of outDirs) fs.writeFileSync(path.join(d, name), out);
  console.log('wrote', name, `${sizes.join('/')}`);
}

/** Convert luminance to alpha (ink on white paper -> ink on transparency). */
function toTransparent(src) {
  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const lum = 0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2];
    let a = Math.round(((255 - lum) / 255) * 255 * 1.25);
    if (a < 12) a = 0;
    out.data[i] = 17; out.data[i + 1] = 17; out.data[i + 2] = 19;
    out.data[i + 3] = Math.min(255, a);
  }
  return out;
}

function inkRows(png) {
  const rows = new Array(png.height).fill(0);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4 + 3] > 40) rows[y]++;
  return rows;
}

function bbox(png, y0 = 0, y1 = png.height) {
  let minX = png.width, minY = png.height, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < png.width; x++)
      if (png.data[(y * png.width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crop(png, { x, y, w, h }, pad = 0) {
  const out = new PNG({ width: w + pad * 2, height: h + pad * 2 });
  out.data.fill(0);
  PNG.bitblt(png, out, x, y, w, h, pad, pad);
  return out;
}

function squarePad(png) {
  const s = Math.max(png.width, png.height);
  const out = new PNG({ width: s, height: s });
  out.data.fill(0);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, Math.floor((s - png.width) / 2), Math.floor((s - png.height) / 2));
  return out;
}

function downscale(png, size) {
  const out = new PNG({ width: size, height: size });
  const sx = png.width / size, sy = png.height / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0]; let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++)
        for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
          const i = (yy * png.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += png.data[i + c];
          n++;
        }
      const o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(acc[c] / Math.max(1, n));
    }
  return out;
}

// ---- Full logo: split into mark + wordmark using the empty band between them.
const full = toTransparent(read('swarm logo.png'));
const rows = inkRows(full);
const all = bbox(full);
let gapStart = -1, best = { start: 0, len: 0 };
for (let y = all.y; y <= all.y + all.h; y++) {
  if (rows[y] === 0) { if (gapStart < 0) gapStart = y; }
  else if (gapStart >= 0) {
    if (y - gapStart > best.len) best = { start: gapStart, len: y - gapStart };
    gapStart = -1;
  }
}
const splitY = best.start + Math.floor(best.len / 2);
write(crop(full, all, 8), 'logo-full.png');
const markBox = bbox(full, 0, splitY);
const wordBox = bbox(full, splitY, full.height);
const mark = crop(full, markBox, 6);
write(mark, 'logo-mark.png');
write(crop(full, wordBox, 4), 'logo-wordmark.png');

// ---- Desktop app icon: keep the original artwork (tile + shadow), crop and square it.
const desk = read('swarm dekstop logo.png');
const deskAlpha = new PNG({ width: desk.width, height: desk.height });
for (let i = 0; i < desk.data.length; i += 4) {
  for (let c = 0; c < 4; c++) deskAlpha.data[i + c] = desk.data[i + c];
}
// Find the tile bounds: pixels noticeably different from pure white background.
let dMinX = desk.width, dMinY = desk.height, dMaxX = 0, dMaxY = 0;
for (let y = 0; y < desk.height; y++)
  for (let x = 0; x < desk.width; x++) {
    const i = (y * desk.width + x) * 4;
    if (desk.data[i] < 246 || desk.data[i + 1] < 246 || desk.data[i + 2] < 246) {
      if (x < dMinX) dMinX = x; if (x > dMaxX) dMaxX = x;
      if (y < dMinY) dMinY = y; if (y > dMaxY) dMaxY = y;
    }
  }
const deskCrop = squarePad(crop(deskAlpha, { x: dMinX, y: dMinY, w: dMaxX - dMinX + 1, h: dMaxY - dMinY + 1 }));
write(downscale(deskCrop, 512), 'icon.png');
writeIco(deskCrop, 'icon.ico');
write(downscale(squarePad(mark), 256), 'logo-mark-256.png');
