// Dev tool: evaluates the "Hey Zvyra" spotter against WAV files.
// Usage: node scripts/kws-eval.cjs <dir-with-16k-mono-wavs> [sensitivity]
const fs = require('node:fs')
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')

const dir = process.argv[2]
const sensitivity = Number(process.argv[3] ?? 0.6)
const modelDir = path.join(__dirname, '..', 'resources', 'kws')
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'voice', 'keywords.ts'), 'utf8')
const variants = [...src.matchAll(/^\s*'(▁[^']+)',?/gm)].map((m) => m[1])
const s = Math.min(0.95, Math.max(0.05, sensitivity))
const kw = variants.map((t) => `${t} @HEY_ZVYRA :${(1 + s * 2.5).toFixed(2)} #${(0.42 - s * 0.3).toFixed(3)}`).join('\n') + '\n'
const kwFile = path.join(require('node:os').tmpdir(), 'zvyra-kws-eval.txt')
fs.writeFileSync(kwFile, kw)

const spotter = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(modelDir, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: path.join(modelDir, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      joiner: path.join(modelDir, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx')
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  },
  maxActivePaths: 4,
  numTrailingBlanks: 1,
  keywordsScore: 1.0,
  keywordsThreshold: 0.25,
  keywordsFile: kwFile
})

// JS WAV reader (Electron's V8 sandbox rejects the addon's external buffers).
function readWav(file) {
  const b = fs.readFileSync(file)
  let off = 12
  let rate = 16000
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') {
      const n = Math.floor(size / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768
      return { samples: out, sampleRate: rate }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.wav')).sort()) {
  const w = readWav(path.join(dir, f))
  const stream = spotter.createStream()
  // Stream in 100 ms chunks like the live mic, then 1 s of silence.
  const step = Math.round(w.sampleRate / 10)
  let hits = 0
  const feed = (samples) => {
    stream.acceptWaveform({ samples, sampleRate: w.sampleRate })
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const r = spotter.getResult(stream)
      if (r.keyword) {
        hits++
        spotter.reset(stream)
      }
    }
  }
  for (let i = 0; i < w.samples.length; i += step) feed(w.samples.subarray(i, i + step))
  feed(new Float32Array(w.sampleRate))
  console.log(`${f.padEnd(42)} ${hits ? 'WAKE x' + hits : '-'}`)
}
