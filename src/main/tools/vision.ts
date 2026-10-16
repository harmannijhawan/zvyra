/**
 * OWNER: Kiro. Looks at a still image (webcam frame) with Gemini and answers
 * a question about it. Ported from E.D.I.T.H. screen_process (camera angle).
 */
import { generateWithFallback } from './gemini'

export async function describeImage(key: string, dataUrl: string, question: string, signal?: AbortSignal): Promise<string> {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl)
  if (!m) throw new Error('The camera frame was not a valid image')
  const { res } = await generateWithFallback(
    key,
    {
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: m[1], data: m[2] } }, { text: `[IMAGE SOURCE: the user's webcam, captured just now]\n\n${question || 'What do you see?'}` }]
        }
      ],
      config: {
        temperature: 0.4,
        maxOutputTokens: 1024,
        systemInstruction:
          'You are ZVYRA looking through the user’s webcam. Answer the question from what is actually visible, in two to four natural sentences. ' +
          'Do not identify people by name or guess who they are; describe appearance, expression, actions and objects instead. If the image is dark or blurry, say so.'
      }
    },
    { timeoutMs: 40_000, signal }
  )
  const text = (res.text ?? '').trim()
  if (!text) throw new Error('Gemini returned no description')
  return text
}
