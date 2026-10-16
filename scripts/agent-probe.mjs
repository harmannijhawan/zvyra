// Dev probe: one function-calling round trip with the desktop tool schema.
import { GoogleGenAI, Type } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-flash-latest']
for (const model of models) await probe(model)
process.exit(0)

async function probe(model) {
const t0 = Date.now()
try {
  const r = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Make a simple hello world HTML page in my Downloads folder and open it in Brave.' }] }],
    config: {
      systemInstruction: 'You can create files with create_file and open them with open.',
      tools: [
        {
          functionDeclarations: [
            { name: 'create_file', description: 'Create a file', parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING }, content: { type: Type.STRING } }, required: ['path', 'content'] } },
            { name: 'open', description: 'Open a file', parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING }, app: { type: Type.STRING } }, required: ['target'] } }
          ]
        }
      ],
      abortSignal: AbortSignal.timeout(30000)
    }
  })
  console.log(model, 'ms', Date.now() - t0, 'calls', JSON.stringify((r.functionCalls ?? []).map((c) => ({ name: c.name, path: c.args?.path, app: c.args?.app }))), 'text', (r.text ?? '').slice(0, 100))
} catch (e) {
  console.log(model, 'ERROR', Date.now() - t0, 'ms', e.message?.slice(0, 160))
}
}
