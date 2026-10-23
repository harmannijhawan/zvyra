// Structural validation of a UDZO (.dmg) image without macOS tooling.
// Checks: koly trailer fields, the embedded XML plist, and that every blkx
// chunk table entry points at real bytes inside the file.
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/dmg-check.mjs <file.dmg>')
  process.exit(2)
}
const b = fs.readFileSync(file)
const size = b.length
const out = (k, v) => console.log(k.padEnd(28), v)

out('file size', size)
out('leading magic', b.slice(0, 2).toString('hex'))

const off = b.lastIndexOf(Buffer.from('koly'))
if (off < 0 || size - off !== 512) {
  console.error('FAIL: no 512-byte koly trailer')
  process.exit(1)
}
out('koly offset', off)

const u32 = (o) => b.readUInt32LE(off + o)
const u64 = (o) => Number(b.readBigUInt64LE(off + o))

out('version', u32(4))
out('headerSize', u32(8))
out('flags', u32(12))
out('runningDataForkOffset', u64(16))
out('dataForkOffset', u64(24))
out('dataForkLength', u64(32))
out('rsrcForkOffset', u64(40))
out('rsrcForkLength', u64(48))
out('segmentNumber', u32(56))
out('segmentCount', u32(60))
out('dataChecksum', u32(80).toString(16))
out('xmlOffset', u32(84))
out('xmlLength', u32(88))
out('checksum', u32(212).toString(16))
out('imageVariant', u32(216))
out('sectorCount', u64(220))

const xmlStart = off + u32(84)
const xmlLen = u32(88)
if (xmlStart < 0 || xmlStart + xmlLen > size) {
  console.error('FAIL: XML plist range outside the file')
  process.exit(1)
}
const xml = b.slice(xmlStart, xmlStart + xmlLen).toString('utf8')
out('xml range', `${xmlStart}..${xmlStart + xmlLen}`)
out('xml starts with', JSON.stringify(xml.slice(0, 40)))

// --- minimal plist walk: pull the blkx chunk tables out of the XML ---
const blkxRe = /<key>blkx<\/key>\s*<array>([\s\S]*?)<\/array>/g
const dictRe = /<key>(DataFork|Comp\.size|Count|Mish|BLKX|CKSum)<\/key>\s*<(string|integer|data)>([\s\S]*?)<\/\3>/g
let tables = 0
let chunks = 0
let badChunk = 0
let m
while ((m = blkxRe.exec(xml))) {
  tables++
  const body = m[1]
  const fields = {}
  let d
  while ((d = dictRe.exec(body))) fields[d[1]] = d[3].trim()
  const dataFork = parseInt(fields['DataFork'] ?? '0', 10)
  const count = parseInt(fields.Count ?? '0', 10)
  const blkx = fields.BLX ?? ''
  const mish = parseInt(fields.Mish ?? '1', 10)
  // BLKX is base64; the chunk table is 40 bytes per entry:
  // uint32 type, uint32 comment, uint64 sectorNumber, uint64 sectorCount,
  // uint64 compressedOffset, uint64 compressedLength
  const raw = Buffer.from(blkx.replace(/\s+/g, ''), 'base64')
  out(`blkx[${tables - 1}]`, `mish=${mish} count=${count} dataFork=${dataFork} blkxBytes=${raw.length}`)
  for (let i = 0; i < count; i++) {
    const e = 20 + i * 40
    if (e + 40 > raw.length) {
      badChunk++
      continue
    }
    const type = raw.readUInt32LE(e)
    const sectorNumber = Number(raw.readBigUInt64LE(e + 8))
    const sectorCount = Number(raw.readBigUInt64LE(e + 16))
    const compOffset = Number(raw.readBigUInt64LE(e + 24))
    const compLength = Number(raw.readBigUInt64LE(e + 32))
    chunks++
    const abs = dataFork + compOffset
    if (type === 0x80000005 || type === 0x80000006 || type === 0xffffffff) {
      // terminator / ignore
      continue
    }
    if (abs < 0 || abs + compLength > size) {
      badChunk++
      console.error(
        `  chunk ${i}: ABS ${abs}..${abs + compLength} OUT OF FILE (size ${size})`
      )
    }
  }
}
out('blkx tables', tables)
out('chunks seen', chunks)
out('chunks out of range', badChunk)

// --- the data fork itself must be a zlib stream ---
const dataForkOff = u64(24)
const dfLen = u64(32)
out('data fork end', dataForkOff + dfLen)
if (dataForkOff + dfLen > size) {
  console.error('FAIL: data fork runs past end of file')
  process.exit(1)
}
const head = b.slice(dataForkOff, dataForkOff + 8)
out('data fork head', head.toString('hex'))
if (head[0] === 0x78) {
  const zlib = await import('node:zlib')
  try {
    const inflated = zlib.inflateSync(b.slice(dataForkOff, dataForkOff + dfLen))
    out('zlib inflate', `OK ${inflated.length} bytes`)
  } catch (err) {
    console.error('FAIL: data fork does not inflate:', err.message)
    process.exit(1)
  }
}

console.log(badChunk === 0 ? '\nPASS: structure looks sound' : '\nFAIL: bad chunk offsets')
process.exit(badChunk === 0 ? 0 : 1)
