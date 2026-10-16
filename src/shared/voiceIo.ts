/**
 * OWNER: Kiro. Private channel between the hidden voice window (mic capture +
 * playback) and the main-process voice engine. Not part of the backend contract.
 */

export type VoiceCommand =
  | { type: 'start'; deviceId: string | null }
  | { type: 'stop' }
  /** PCM16 mono little-endian at 24 kHz (Gemini output). */
  | { type: 'play'; pcm: Uint8Array }
  | { type: 'flush' }
  | { type: 'chime'; kind: 'wake' | 'sleep' | 'error' }
  | { type: 'enumerate' }

export type VoiceWindowEvent =
  | { type: 'ready' }
  | { type: 'started'; deviceLabel: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string; permission?: boolean }
  | { type: 'devices'; devices: { id: string; label: string; isDefault: boolean }[] }
  /** Playback queue finished — the assistant has stopped talking. */
  | { type: 'drained' }
  | { type: 'outLevel'; level: number }

export const VOICE_CAPTURE_RATE = 16000
export const VOICE_PLAYBACK_RATE = 24000
