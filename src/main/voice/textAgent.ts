/**
 * OWNER: Kiro. Typed-command / builder agent: Gemini function calling over the
 * same tools the voice session uses. Handles quick jobs (“make X and open
 * it”) and big ones (a full multi-page e-commerce site): a long step budget,
 * generous output for whole files, edit/verify tools and a build workflow.
 */
import { GoogleGenAI, ThinkingLevel, type Content, type FunctionCall } from '@google/genai'
import type { ShellLogger } from '../backendContext'
import { AGENT_GUIDE, BUILDER_GUIDE } from './desktopTools'
import { ALL_TOOL_DECLARATIONS, runTool, type ToolHost } from './extraTools'
import { FLASH_MODELS, isRetryable } from '../tools/gemini'

// One model call may write several whole files; aborting a slow-but-working call wastes all of it.
const ATTEMPT_TIMEOUT_MS = 300_000
const MAX_STEPS = 80
const MAX_OUTPUT_TOKENS = 32_768
// The agent does the work itself; run_task is only for the voice session's hand-off.
const AGENT_TOOLS = ALL_TOOL_DECLARATIONS.filter((d) => d.name !== 'run_task')

export interface AgentProgress {
  (update: { action?: string; reply?: string; step?: number; files?: string[]; thinking?: string }): void
}

const tail = (p: unknown) => String(p ?? '').split(/[\\/]/).pop()

const ACTION_LABEL: Record<string, (a: Record<string, unknown>) => string> = {
  create_file: (a) => `Writing ${tail(a['path'] ?? 'file')}`,
  edit_file: (a) => `Fixing ${tail(a['path'])}`,
  open: (a) => `Opening ${tail(a['target'])}${a['app'] ? ` in ${String(a['app'])}` : ''}`,
  launch_app: (a) => `Launching ${String(a['name'] ?? 'app')}`,
  list_folder: (a) => `Looking in ${String(a['path'] ?? 'Downloads')}`,
  list_tree: () => 'Reviewing the project files',
  read_file: (a) => `Reading ${tail(a['path'])}`,
  check_site: (a) => `Testing ${tail(a['target'])}`,
  run_command: (a) => `Running ${String(a['command'] ?? '').slice(0, 50)}`,
  inspect_project: () => 'Inspecting the project',
  open_project: (a) => `Opening ${String(a['name'] ?? 'the project')}`,
  get_workspace: () => 'Checking the workspace',
  get_status: () => 'Checking status',
  web_search: (a) => `Searching: ${String(a['query'] ?? '').slice(0, 60)}`,
  read_webpage: () => 'Reading a web page',
  play_media: (a) => `Playing ${String(a['query'] ?? '')}`,
  media_control: (a) => `Media: ${String(a['action'] ?? '')}`,
  camera: (a) => (a['action'] === 'look' ? 'Looking through the camera' : `Camera ${String(a['action'] ?? '')}`),
  weather: (a) => `Weather in ${String(a['city'] ?? '')}`,
  system_status: () => 'Checking the PC',
  set_timer: () => 'Setting a timer',
  clipboard: () => 'Using the clipboard'
}

export class TextAgent {
  private history: Content[] = []
  private model = FLASH_MODELS[0]

  constructor(
    private readonly getKey: () => string | null,
    private readonly host: ToolHost,
    private readonly context: () => Promise<string>,
    private readonly logger: ShellLogger
  ) {}

  reset() {
    this.history = []
  }

  async run(text: string, onProgress: AgentProgress, signal?: AbortSignal): Promise<{ reply: string; actions: string[]; files: string[] }> {
    const key = this.getKey()
    if (!key) throw new Error('Add a Gemini API key in Settings → Voice to use ZVYRA’s assistant.')
    const ai = new GoogleGenAI({ apiKey: key })
    const systemInstruction = [
      'You are ZVYRA, a capable personal AI that lives on the user’s Windows PC. Be brief, warm and direct in what you say, and thorough in what you build.',
      AGENT_GUIDE,
      BUILDER_GUIDE,
      await this.context().catch(() => '')
    ].join('\n')
    const contents: Content[] = [...this.history.slice(-16), { role: 'user', parts: [{ text }] }]
    const actions: string[] = []
    const files = new Set<string>()
    let reply = ''
    let finished = false

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Error('Cancelled')
      const t0 = Date.now()
      const beat = setInterval(() => onProgress({ thinking: `${files.size ? 'Writing the next file' : 'Designing the project'}… ${Math.round((Date.now() - t0) / 1000)}s` }), 4000)
      let res: Awaited<ReturnType<TextAgent['generate']>>
      try {
        res = await this.generate(ai, contents, systemInstruction, signal)
      } finally {
        clearInterval(beat)
      }
      this.logger.info('agent', `step ${step + 1}`, { ms: Date.now() - t0, model: this.model, calls: res.functionCalls?.length ?? 0, finish: res.candidates?.[0]?.finishReason })
      const cand = res.candidates?.[0]?.content
      if (cand?.parts?.length) contents.push(cand)
      const calls: FunctionCall[] = res.functionCalls ?? []
      if (!calls.length) {
        reply = (res.text ?? '').trim()
        // A model that stops mid-build with "I'll now create…" gets nudged to keep working.
        if (!reply && res.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
          contents.push({ role: 'user', parts: [{ text: 'Your last answer was cut off. Continue with the next tool call; split very large files into smaller ones.' }] })
          continue
        }
        finished = true
        break
      }
      const parts = []
      for (const c of calls) {
        const args = (c.args ?? {}) as Record<string, unknown>
        const label = ACTION_LABEL[c.name ?? '']?.(args) ?? c.name ?? 'Working'
        onProgress({ action: label, step: step + 1, files: [...files] })
        let response: Record<string, unknown>
        try {
          response = await runTool(this.host, c.name ?? '', args, signal)
        } catch (err) {
          response = { error: err instanceof Error ? err.message : String(err) }
        }
        if ((c.name === 'create_file' || c.name === 'edit_file') && typeof response['path'] === 'string') files.add(response['path'])
        actions.push(response['error'] ? `${label} — failed` : label)
        this.logger.info('agent', `tool ${c.name}`, { ok: !response['error'], error: response['error'] as string | undefined })
        parts.push({ functionResponse: { id: c.id, name: c.name, response } })
      }
      contents.push({ role: 'user', parts })
    }
    if (!reply) {
      const made = [...files].map((f) => tail(f))
      reply = !finished
        ? `I worked through ${MAX_STEPS} steps${made.length ? ` and wrote ${made.length} file(s): ${made.slice(0, 12).join(', ')}` : ''}. Say “continue” and I’ll pick up where I stopped.`
        : actions.length
          ? `Done: ${actions.slice(-6).join(', ')}.`
          : 'I couldn’t work that out — try rephrasing?'
    }
    // Keep a compact history (no bulky tool payloads) for follow-ups like “now make it blue” or “continue”.
    const note = actions.length ? `\n(Actions: ${actions.slice(-40).join('; ')}${files.size ? `; files: ${[...files].join(', ')}` : ''})` : ''
    this.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: reply + note }] })
    this.history = this.history.slice(-16)
    onProgress({ reply, files: [...files] })
    return { reply, actions, files: [...files] }
  }

  private async generate(ai: GoogleGenAI, contents: Content[], systemInstruction: string, signal?: AbortSignal) {
    let lastErr: unknown
    const order = [this.model, ...FLASH_MODELS.filter((m) => m !== this.model)]
    for (let i = 0; i < order.length; i++) {
      const model = order[i]
      const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
      // Deep thinking made every file take minutes; low thinking writes the same code far faster.
      const lowThinking = !TextAgent.noThinkingLevel.has(model)
      try {
        const r = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: AGENT_TOOLS }],
            abortSignal: signal ? AbortSignal.any([signal, attempt]) : attempt,
            temperature: 0.4,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            ...(lowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
            httpOptions: { retryOptions: { attempts: 1 } }
          }
        })
        this.model = model
        return r
      } catch (err) {
        lastErr = err
        if (signal?.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        if (lowThinking && /thinking/i.test(msg) && /400|INVALID|not supported|unsupported/i.test(msg)) {
          // This model doesn't take a thinking level: retry it once without.
          TextAgent.noThinkingLevel.add(model)
          i--
          continue
        }
        if (!attempt.aborted && !isRetryable(err)) throw err
        this.logger.warn('agent', `model ${model} unavailable, trying next`, { message: msg.slice(0, 200) })
      }
    }
    throw lastErr
  }

  private static noThinkingLevel = new Set<string>()
}
