/**
 * OWNER: Kiro. Keyword definitions for the local "Hey Zvyra" spotter.
 *
 * Tokens were produced with the model's own bpe.model (sentencepiece, canonical
 * + n-best segmentations). "Zvyra" is not an English word, so several common
 * pronunciations are listed.
 *
 * Two classes, because they behave very differently in practice:
 *  - CORE variants contain the "Z(V)…RA" sound and rarely occur in normal speech.
 *  - LOOSE variants ("his veera", "hey vira"…) catch fast accents, but also
 *    appear in ordinary sentences and TV audio. They get a stricter threshold,
 *    a smaller boost and their own label, and the engine verifies them before waking.
 */

export const WAKE_LABEL = 'HEY_ZVYRA'
export const WAKE_LABEL_LOOSE = 'HEY_ZVYRA_ALT'

/** Token sequences per pronunciation variant (from resources/kws/bpe.model). */
const CORE: string[] = [
  '▁HE Y ▁ Z V Y RA', // hey zvyra
  '▁HE Y ▁ Z V Y R A',
  '▁HE Y ▁ Z Y RA', // hey zyra
  '▁HE Y ▁ Z Y R A',
  '▁HE Y ▁ Z IR A', // hey zira
  '▁HE Y ▁ Z I RA',
  '▁HE Y ▁ Z E ER A', // hey zeera
  '▁HE Y ▁ Z E E RA',
  '▁HE Y ▁ Z VI RA', // hey zvira
  '▁HE Y ▁ Z I V RA', // hey zivra
  '▁HE Y ▁ Z E V RA', // hey zevra
  '▁HE Y ▁ Z A VI RA', // hey zavira
  '▁HI ▁ Z Y RA', // hi zyra
  '▁HI ▁ Z V Y RA', // hi zvyra
  '▁HI ▁ Z I RA', // hi zira
  '▁HA Y ▁ Z Y RA', // hay zyra
  // Fast, merged forms recorded from real (Indian-English) speech: “hezira”, “he zira”
  '▁HE Z I RA', // hezira
  '▁HE Z IR A',
  '▁HE ▁ Z I RA', // he zira
  '▁HE ▁ Z IR A',
  '▁HE Y Z I RA', // heyzira
  '▁HE Z V I RA', // hezvira
  '▁HE ▁ Z VI RA'
]

const LOOSE: string[] = [
  '▁HE Y ▁ V Y RA', // hey vyra
  '▁HE Y ▁SA VI RA', // hey savira
  '▁HE Y ▁VI RA', // hey vira
  '▁HE Y ▁ J I RA', // hey jira (z → j accents)
  '▁HE Y ▁ Z ER A', // hey zera
  '▁HIS ▁VI RA', // his veera
  '▁HE ▁VI RA', // he veera
  '▁HE Y ▁VI E RA' // hey vee-ra
]

/**
 * Builds a sherpa-onnx keywords file. `sensitivity` 0..1 maps to a lower
 * trigger threshold and higher boost (more sensitive = fires more easily).
 */
export function buildKeywords(sensitivity: number): string {
  const s = Math.min(0.95, Math.max(0.05, sensitivity))
  const threshold = 0.42 - s * 0.3 // 0.405 (strict) … 0.135 (very sensitive)
  const boost = 1.0 + s * 2.5 // 1.12 … 3.37
  const core = CORE.map((t) => `${t} @${WAKE_LABEL} :${boost.toFixed(2)} #${threshold.toFixed(3)}`)
  // Look-alike phrases need clearly more evidence.
  const loose = LOOSE.map((t) => `${t} @${WAKE_LABEL_LOOSE} :${Math.max(1, boost * 0.6).toFixed(2)} #${Math.min(0.5, threshold + 0.1).toFixed(3)}`)
  return [...core, ...loose].join('\n') + '\n'
}
