/** OWNER: Kiro. Gemini Live voice + model catalogue helpers. */

/** Prebuilt Gemini voices with a short character note. */
export const GEMINI_VOICES: { name: string; style: string }[] = [
  { name: 'Charon', style: 'Informative' },
  { name: 'Puck', style: 'Upbeat' },
  { name: 'Kore', style: 'Firm' },
  { name: 'Fenrir', style: 'Excitable' },
  { name: 'Aoede', style: 'Breezy' },
  { name: 'Zephyr', style: 'Bright' },
  { name: 'Leda', style: 'Youthful' },
  { name: 'Orus', style: 'Firm' },
  { name: 'Callirrhoe', style: 'Easy-going' },
  { name: 'Autonoe', style: 'Bright' },
  { name: 'Enceladus', style: 'Breathy' },
  { name: 'Iapetus', style: 'Clear' },
  { name: 'Umbriel', style: 'Easy-going' },
  { name: 'Algieba', style: 'Smooth' },
  { name: 'Despina', style: 'Smooth' },
  { name: 'Erinome', style: 'Clear' },
  { name: 'Algenib', style: 'Gravelly' },
  { name: 'Rasalgethi', style: 'Informative' },
  { name: 'Laomedeia', style: 'Upbeat' },
  { name: 'Achernar', style: 'Soft' },
  { name: 'Alnilam', style: 'Firm' },
  { name: 'Schedar', style: 'Even' },
  { name: 'Gacrux', style: 'Mature' },
  { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Achird', style: 'Friendly' },
  { name: 'Zubenelgenubi', style: 'Casual' },
  { name: 'Vindemiatrix', style: 'Gentle' },
  { name: 'Sadachbia', style: 'Lively' },
  { name: 'Sadaltager', style: 'Knowledgeable' },
  { name: 'Sulafat', style: 'Warm' }
]

export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview'
export const DEFAULT_VOICE = 'Charon'

export interface LiveModel {
  id: string
  label: string
  description?: string
}

/** Keeps conversational Live models (drops transcribe/translate/robotics variants). */
export function pickConversationalLiveModels(models: { name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }[]): LiveModel[] {
  return models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('bidiGenerateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, ''), description: m.description }))
    .filter((m) => !/transcribe|translate|robotics/i.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
}

/** Phrases that end a voice conversation locally (in addition to the model's end_conversation tool). */
export function isSleepPhrase(text: string): boolean {
  const t = text.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim()
  return /\b(go to sleep|stop listening|that'?s all( for now)?|goodbye zvyra|bye zvyra|good night zvyra|you can sleep|dismissed)\b/.test(t)
}
