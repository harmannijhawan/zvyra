/**
 * OWNER: Kiro. Preload for the hidden voice window only. Exposes audio
 * transport to the main-process voice engine and nothing else.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { VoiceCommand, VoiceWindowEvent } from '../shared/voiceIo'

contextBridge.exposeInMainWorld('zvyraVoice', {
  sendAudio: (pcm: ArrayBuffer) => ipcRenderer.send('zvyra:voice-audio', new Uint8Array(pcm)),
  sendEvent: (e: VoiceWindowEvent) => ipcRenderer.send('zvyra:voice-event', e),
  onCommand: (cb: (c: VoiceCommand) => void) => {
    ipcRenderer.on('zvyra:voice-cmd', (_e, c: VoiceCommand) => cb(c))
  }
})
