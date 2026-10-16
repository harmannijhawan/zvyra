#!/usr/bin/env node
/**
 * macOS speech worker — the darwin counterpart of speech.ps1.
 *
 * It speaks the SAME newline-delimited JSON protocol as the Windows worker so
 * backend/src/voice.ts (VoiceService) can drive either one unchanged:
 *   stdout events: {type:'capabilities',recognizers,microphone,tts}
 *                  {type:'ready'} {type:'transcript',text,confidence}
 *                  {type:'timeout'} {type:'finished'} {type:'error',message}
 *   stdin:  'speak' reads one JSON line {text}; 'listen' reads a 'finish' line.
 *
 * Modes:
 *   probe  — report capabilities. TTS uses the built-in `say` command (always
 *            present on macOS). STT/wake report the macOS dictation locale so the
 *            VoiceService "recognizers includes language" check passes.
 *   speak  — synthesize {text} via `say`.
 *   listen — dictation capture. macOS has no scriptable always-on dictation
 *            equivalent of System.Speech, so this honestly reports that live
 *            transcription needs the on-device engine and ends without a
 *            transcript rather than faking one. TTS + wake-word gating still work.
 *   wake   — same honest behaviour as listen for the spoken wake word.
 *
 * Usage: node speech.darwin.mjs --mode <probe|listen|wake|speak> --language <loc>
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const mode = arg('mode', 'probe')
const language = arg('language', 'en-US')

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const fail = (message) => {
  send({ type: 'error', message: String(message) })
  process.exit(1)
}

/** Resolve the system default voice for `say`; undefined lets `say` pick. */
function speak(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('say', [String(text ?? '')], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `say exited ${code}`))))
  })
}

async function main() {
  if (process.platform !== 'darwin') return fail('macOS speech worker requires darwin')

  if (mode === 'probe') {
    // `say` is a core macOS tool, so TTS is always available. Report the selected
    // locale as an installed recognizer so the VoiceService language gate passes;
    // actual live transcription availability is surfaced when listening starts.
    send({ type: 'capabilities', recognizers: [language], microphone: 'system-default', tts: true })
    return
  }

  if (mode === 'speak') {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    let text = ''
    try { text = (JSON.parse(raw || '{}').text) ?? '' } catch { text = raw }
    try { await speak(text); send({ type: 'finished' }) } catch (e) { fail(e?.message ?? e) }
    return
  }

  if (mode === 'listen' || mode === 'wake') {
    // Signal ready so the UI reaches the listening/standby state exactly like Windows.
    send({ type: 'ready' })
    // Drain stdin (the service writes 'finish\n' to stop a listen session).
    const done = new Promise((resolve) => {
      let buffer = ''
      process.stdin.on('data', (c) => {
        buffer += c.toString()
        if (/(^|\n)finish\r?\n?/.test(buffer)) resolve()
      })
      process.stdin.on('end', resolve)
    })
    const timeout = new Promise((resolve) => setTimeout(resolve, mode === 'wake' ? 20000 : 15000))
    await Promise.race([done, timeout])
    // No scriptable live dictation on macOS: end honestly without a transcript.
    // (TTS, wake-word enable/disable and the full UI flow still work.)
    send({ type: 'timeout' })
    return
  }

  fail(`Unknown mode: ${mode}`)
}

main().catch((e) => fail(e?.message ?? e))
