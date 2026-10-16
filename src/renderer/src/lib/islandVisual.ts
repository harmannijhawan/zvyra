/**
 * Pure derivation of what the Dynamic Island shows, from real application
 * state only (voice engine status, approvals, camera, tools, agent work).
 * No timers decide voice states: the engine reports listening, speech
 * detected (on-device VAD), processing (model turn / tool call / waiting for
 * the reply) and speaking (TTS playback), and the island mirrors it.
 */
import type { VoiceStatus } from '@shared/contract'
import type { IslandMode } from '@shared/shell'

export type IslandVisual =
  | 'mini'
  | 'idle'
  | 'listening'
  | 'speech'
  | 'processing'
  | 'speaking'
  | 'working'
  | 'notice'
  | 'approval'
  | 'tool'
  | 'peek'
  | 'camera'
  | 'expanded'

export interface IslandInput {
  mode: IslandMode
  voice: Pick<VoiceStatus, 'state' | 'userSpeaking'> | null
  permissions: number
  camera: { open: boolean; captureId?: string }
  freshTools: number
  agentWorking: boolean
  hasPeek: boolean
  /** A live ZVYRA notification (file created, command failed, task completed…). */
  hasNotice?: boolean
}

export const VOICE_VISUALS: readonly IslandVisual[] = ['listening', 'speech', 'processing', 'speaking']

export function deriveIslandVisual(i: IslandInput): IslandVisual {
  // A pending camera capture keeps the stream mounted so the frame can be taken.
  if (i.camera.open && i.camera.captureId) return 'camera'
  if (i.permissions > 0) return 'approval'
  if (i.camera.open) return 'camera'
  if (i.mode === 'expanded') return 'expanded'
  switch (i.voice?.state) {
    case 'wake_detected':
    case 'listening':
      return i.voice.userSpeaking ? 'speech' : 'listening'
    case 'transcribing':
      return 'processing'
    case 'speaking':
      return 'speaking'
  }
  // Notifications appear in the island (there are no separate notification windows).
  if (i.hasNotice) return 'notice'
  if (i.freshTools > 0) return 'tool'
  if (i.agentWorking) return 'working'
  if (i.hasPeek) return 'peek'
  return i.mode === 'mini' ? 'mini' : 'idle'
}

/** Content groups: switching inside a group updates in place (no remount, no re-fade). */
export function visualGroup(v: IslandVisual): string {
  return VOICE_VISUALS.includes(v) ? 'voice' : v
}

export interface IslandSize {
  w: number
  /** Resting height (one row). */
  h: number
  /** Upper bound when content grows (transcript, cards). */
  max: number
  r: number
}

/** Surface sizes (DIPs). Idle is deliberately tiny; everything else grows only as far as its content. */
export const ISLAND_SIZES: Record<IslandVisual, IslandSize> = {
  mini: { w: 104, h: 32, max: 32, r: 16 },
  idle: { w: 212, h: 40, max: 40, r: 20 },
  listening: { w: 344, h: 46, max: 108, r: 23 },
  speech: { w: 344, h: 46, max: 108, r: 23 },
  processing: { w: 344, h: 46, max: 108, r: 23 },
  speaking: { w: 344, h: 46, max: 108, r: 23 },
  working: { w: 372, h: 46, max: 46, r: 23 },
  notice: { w: 392, h: 58, max: 96, r: 26 },
  approval: { w: 464, h: 130, max: 500, r: 26 },
  tool: { w: 424, h: 70, max: 360, r: 26 },
  peek: { w: 404, h: 60, max: 220, r: 26 },
  camera: { w: 480, h: 310, max: 580, r: 28 },
  expanded: { w: 480, h: 210, max: 610, r: 28 }
}

export function surfaceHeight(v: IslandVisual, measured: number): number {
  const s = ISLAND_SIZES[v]
  if (s.h === s.max) return s.h
  return Math.round(Math.min(s.max, Math.max(s.h, measured || s.h)))
}
