// Dev probe: verifies a Gemini Live audio session with the key from GEMINI_API_KEY.
// Usage: node scripts/gemini-live-probe.mjs [model] [voice]
import { GoogleGenAI, Modality } from '@google/genai'

const key = process.env.GEMINI_API_KEY
if (!key) throw new Error('Set GEMINI_API_KEY')
const model = process.argv[2] ?? 'gemini-3.1-flash-live-preview'
const voice = process.argv[3] ?? 'Charon'

// 1) Which models support the Live (bidi) API?
const list = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } }).then((r) => r.json())
const live = (list.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('bidiGenerateContent')).map((m) => m.name)
console.log('LIVE MODELS:', live.join(', ') || '(none)', list.error ? JSON.stringify(list.error).slice(0, 200) : '')

// 2) Open a session, send one text turn, count audio bytes and transcript.
const ai = new GoogleGenAI({ apiKey: key })
let bytes = 0
let text = ''
const t0 = Date.now()
let firstAudio = 0
const done = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('timeout')), 30000)
  ai.live
    .connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: 'You are ZVYRA, a concise desktop assistant.'
      },
      callbacks: {
        onopen: () => console.log('open'),
        onmessage: (m) => {
          const sc = m.serverContent
          for (const p of sc?.modelTurn?.parts ?? []) {
            if (p.inlineData?.data) {
              if (!firstAudio) firstAudio = Date.now() - t0
              bytes += Buffer.from(p.inlineData.data, 'base64').length
              if (!globalThis.mime) console.log('mime', (globalThis.mime = p.inlineData.mimeType))
            }
          }
          if (sc?.outputTranscription?.text) text += sc.outputTranscription.text
          if (sc?.turnComplete) resolve()
        },
        onerror: (e) => reject(new Error(e.message ?? String(e))),
        onclose: (e) => console.log('close', e.code, e.reason)
      }
    })
    .then((s) => {
      globalThis.session = s
      s.sendRealtimeInput({ text: 'Say hello and tell me your name in one short sentence.' })
    }, reject)
})
try {
  await done
  console.log(`OK model=${model} voice=${voice} firstAudioMs=${firstAudio} audioBytes=${bytes} (~${(bytes / 48000).toFixed(1)}s @24k) transcript="${text.trim()}"`)
} catch (e) {
  console.log('FAILED', e.message)
} finally {
  globalThis.session?.close()
}
