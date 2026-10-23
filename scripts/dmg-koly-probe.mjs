// Determine the real byte layout of the koly trailer by trying small shifts.
import fs from 'node:fs'

const b = fs.readFileSync(process.argv[2])
const size = b.length
const off = size - 512

const xmlAt = b.indexOf(Buffer.from('<?xml'))
console.log('size', size, 'koly@', off, 'xml@', xmlAt)

for (let s = 0; s <= 24; s++) {
  const p = off + s
  if (p + 240 > size) break
  const u32 = (o) => b.readUInt32BE(p + o)
  const u64 = (o) => Number(b.readBigUInt64BE(p + o))
  const version = u32(4)
  const headerSize = u32(8)
  const flags = u32(12)
  const segmentCount = u32(0x3c)
  const xmlOffset = u64(0x5c)
  const xmlLength = u64(0x64)
  const sane =
    version === 4 &&
    headerSize === 512 &&
    segmentCount === 1 &&
    xmlOffset > 0 &&
    xmlLength > 0 &&
    off + xmlOffset === xmlAt &&
    xmlOffset + xmlLength <= size - off
  console.log(
    `shift ${String(s).padStart(2)}: version=${version} headerSize=${headerSize} flags=${flags} segCount=${segmentCount} xmlOffset=${xmlOffset} xmlLength=${xmlLength} dataForkLen=${u64(0x20)} ${sane ? '  <== MATCH' : ''}`
  )
}
