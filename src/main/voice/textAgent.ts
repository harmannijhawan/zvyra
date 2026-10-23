/**
 * OWNER: Kiro. Typed-command / builder agent: Gemini function calling over the
 * same tools the voice session uses. Handles quick jobs (“make X and open
 * it”) and big ones (a full multi-page e-commerce site): a long step budget,
 * generous output for whole files, edit/verify tools and a build workflow.
 */
import { GoogleGenAI, ThinkingLevel, type Content, type FunctionCall } from '@google/genai'
import type { ShellLogger } from '../backendContext'
import { AGENT_GUIDE, BUILDER_GUIDE, OPERATOR_GUIDE } from './desktopTools'
import { ALL_TOOL_DECLARATIONS, runTool, type ToolHost } from './extraTools'
import { FLASH_MODELS, isRetryable, markModelFailed, markModelOk, modelOrder } from '../tools/gemini'
import { CompletionEvidence } from '../agent/completion'
import { isDesktopMission } from '../computer/focusPolicy'
import {InputQueue} from '../computer/inputQueue'
import {abortable} from '../agent/abortable'
import {ComputerFailureBudget} from '../computer/failureBudget'

// One model call may write several whole files; aborting a slow-but-working call wastes all of it.
const ATTEMPT_TIMEOUT_MS = 300_000
const MAX_STEPS = 80
const MAX_OUTPUT_TOKENS = 32_768
// The agent does the work itself; run_task is only for the voice session's hand-off.
const AGENT_TOOLS = ALL_TOOL_DECLARATIONS.filter((d) => d.name !== 'run_task')
const DESKTOP_TOOLS = AGENT_TOOLS.filter(d=>['computer','update_plan','get_status','control_tasks'].includes(d.name??''))
// Hold a mission lease while its model is planning too, so two desktop tasks
// cannot alternate focus and invalidate each other's screen observations.
const desktopMissions=new InputQueue()

export interface AgentProgress {
  /** `partial`: the reply text streamed so far (shown live before the model has finished). */
  (update: { action?: string; reply?: string; step?: number; files?: string[]; thinking?: string; partial?: string; plan?: { title: string; status: string }[] }): void
}

/** What one model turn produced, assembled from the streamed chunks. */
interface Turn {
  content?: Content
  functionCalls: FunctionCall[]
  text: string
  finishReason?: string
}

const tail = (p: unknown) => String(p ?? '').split(/[\\/]/).pop()

const ACTION_LABEL: Record<string, (a: Record<string, unknown>) => string> = {
  build_business_site: () => 'Writing source-based website',
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
  list_open_apps: () => 'Checking open apps',
  close_app: (a) => `Closing ${String(a['name'] ?? 'the app')}`,
  window: (a) => `${String(a['action'] ?? 'Arranging')} ${String(a['name'] ?? '')}`.trim(),
  press_keys: (a) => `Pressing ${String(a['keys'] ?? '')}`,
  pc_settings: (a) => `PC: ${String(a['action'] ?? '')}`.replace(/_/g, ' '),
  get_status: () => 'Checking status',
  web_search: (a) => `Searching: ${String(a['query'] ?? '').slice(0, 60)}`,
  read_webpage: () => 'Reading a web page',
  play_media: (a) => `Playing ${String(a['query'] ?? '')}`,
  media_control: (a) => `Media: ${String(a['action'] ?? '')}`,
  camera: (a) => (a['action'] === 'look' ? 'Looking through the camera' : `Camera ${String(a['action'] ?? '')}`),
  weather: (a) => `Weather in ${String(a['city'] ?? '')}`,
  system_status: () => 'Checking the PC',
  set_timer: () => 'Setting a timer',
  clipboard: () => 'Using the clipboard',
  research_business: (a) => `Researching ${String(a['name'] ?? a['url'] ?? 'the business')}`,
  download_images: () => 'Downloading real images',
  find_stock_images: (a) => `Finding stock photos: ${String(a['query'] ?? '')}`,
  design_brief: () => 'Choosing the design direction',
  preview_site: () => 'Opening the preview',
  screen_context: () => 'Reading the screen',
  ui_click: (a) => `Clicking ${String(a['name'] ?? '')}`,
  ui_type: (a) => `Typing into ${String(a['field'] ?? '')}`,
  lead_save: (a) => `Saving lead ${String(a['name'] ?? '')}`,
  lead_list: () => 'Checking leads',
  lead_update: () => 'Updating the lead',
  whatsapp: (a) => `WhatsApp: ${String(a['action'] ?? '')}`.replace('_', ' '),
  email_draft: () => 'Drafting the e-mail',
  control_tasks: (a) => `Tasks: ${String(a['action'] ?? '')}`,
  look_at_screen: () => 'Looking at the screen',
  browser: (a) => `Browser: ${String(a['action'] ?? '')}${a['url'] ? ' ' + String(a['url']).replace(/^https?:\/\/(www\.)?/, '').slice(0, 40) : ''}`
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

  async run(text: string, onProgress: AgentProgress, signal?: AbortSignal): Promise<{ reply: string; actions: string[]; files: string[]; ok: boolean }> {
    if(isDesktopMission(text))return desktopMissions.run(s=>this.runMission(text,onProgress,s),signal)
    return this.runMission(text,onProgress,signal)
  }
  private async runMission(text: string, onProgress: AgentProgress, signal?: AbortSignal): Promise<{ reply: string; actions: string[]; files: string[]; ok: boolean }> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30 * 60 * 1000)])
    const key = this.getKey()
    if (!key) throw new Error('Add a Gemini API key in Settings → Voice to use ZVYRA’s assistant.')
    const ai = new GoogleGenAI({ apiKey: key })
    const desktopMission=isDesktopMission(text)
    const runHost={...this.host,computerSnapshots:true}
    const declaredTools=desktopMission?DESKTOP_TOOLS:AGENT_TOOLS
    const systemInstruction = [
      'You are ZVYRA, a capable personal AI that lives on the user’s Windows PC. Be brief, warm and direct in what you say, and thorough in what you build.',
      AGENT_GUIDE,
      OPERATOR_GUIDE,
      BUILDER_GUIDE,
      desktopMission?'DESKTOP MISSION: perform this complete request with the computer tool. Start update_plan, then computer launch/observe/focus. Use real clicks, keystrokes and typing, repeatedly, until all requested results are verified. You receive actual screenshots and accessible refs after every action. Do not return instructions or ask the user to click routine controls. Do not create results through shell commands or source-file tools. Recover from stale frames by observing; continue without needing another user message. Use expected only at meaningful checkpoints and the final outcome. Never stop after announcing a plan. If you cannot finish, report the actual blocker and completed steps.':'',
      await this.context().catch(() => '')
    ].join('\n')
    // Earlier turns are context only; the model must work on THIS request (unless it asks to continue).
    const followUp = /^\s*(continue|keep going|go on|resume|carry on|finish (it|that)|do (it|that) again|retry|try again)\b/i.test(text)
    const framed = this.history.length
      ? `NEW REQUEST — do only this${followUp ? ' (it refers to the previous request)' : '. Everything earlier in this conversation is already finished: do not repeat earlier tasks or tool calls; use them only as background (e.g. “it”, “that file”)'}:\n${text}`
      : text
    const contents: Content[] = [...this.history.slice(-12), { role: 'user', parts: [{ text: framed }] }]
    const actions: string[] = []
    const files = new Set<string>()
    let reply = ''
    let finished = false
    const evidence = new CompletionEvidence()
    let correctionAttempts = 0
    let computerActions=0
    const failedActions = new Map<string, number>()
    const computerFailures=new ComputerFailureBudget()
    // The last website test result: if it still failed when the agent stopped, the reply must say so.
    let lastQa: { ok: boolean; issues: string[] } | null = null

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Error('Cancelled')
      const t0 = Date.now()
      const beat = setInterval(() => onProgress({ thinking: `${desktopMission?'Planning the next desktop action':files.size ? 'Writing the next file' : 'Working on your request'}… ${Math.round((Date.now() - t0) / 1000)}s` }), 4000)
      let res: Turn
      let firstTokenMs = 0
      try {
        res = await this.generate(ai, contents, systemInstruction, signal, (partial) => {
          if (!firstTokenMs) firstTokenMs = Date.now() - t0
          onProgress({ partial })
        },declaredTools)
      } finally {
        clearInterval(beat)
      }
      this.logger.info('agent', `step ${step + 1}`, { ms: Date.now() - t0, firstTokenMs: firstTokenMs || undefined, model: this.model, calls: res.functionCalls.length, finish: res.finishReason })
      const cand = res.content
      if (cand?.parts?.length) contents.push(cand)
      const calls = res.functionCalls
      if (!calls.length) {
        reply = res.text.trim()
        // A model that stops mid-build with "I'll now create…" gets nudged to keep working.
        if (!reply && res.finishReason === 'MAX_TOKENS') {
          contents.push({ role: 'user', parts: [{ text: 'Your last answer was cut off. Continue with the next tool call; split very large files into smaller ones.' }] })
          continue
        }
        const unresolved = evidence.issues()
        if(desktopMission&&!computerActions)unresolved.push('The desktop task has not executed any computer input. Start the computer tool now.')
        if (unresolved.length && correctionAttempts++ < 2) {
          contents.push({ role: 'user', parts: [{ text: `Verification is incomplete: ${unresolved.join('; ')}. Use tools to recover and verify. If blocked, explain the actual blocker; do not claim success.` }] })
          continue
        }
        finished = true
        break
      }
      const parts = []
      for (const c of calls) {
        signal.throwIfAborted()
        const args = (c.args ?? {}) as Record<string, unknown>
        // The plan is progress for the user, not work: show it and move on.
        if (c.name === 'update_plan') {
          const steps = Array.isArray(args['steps']) ? (args['steps'] as { title: string; status: string }[]) : []
          onProgress({ plan: steps })
          parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: true, steps: steps.length } } })
          continue
        }
        const label = ACTION_LABEL[c.name ?? '']?.(args) ?? c.name ?? 'Working'
        onProgress({ action: label, step: step + 1, files: [...files] })
        let response: Record<string, unknown>
        // Frame tokens change on observation; they must not disguise a repeated failing action.
        const { frame: _frame, ...identityArgs } = args
        const actionIdentity = JSON.stringify([c.name, identityArgs])
        try {
          if ((failedActions.get(actionIdentity) ?? 0) >= 3) throw new Error('Retry limit reached for this action. Observe, change strategy, or report the blocker.')
          response = await runTool(runHost, c.name ?? '', args, signal)
        } catch (err) {
          response = { error: err instanceof Error ? err.message : String(err) }
        }
        if (['create_file', 'edit_file', 'build_business_site'].includes(c.name ?? '') && typeof response['path'] === 'string') files.add(response['path'])
        if (c.name === 'check_site' && !response['error']) lastQa = { ok: response['ok'] === true, issues: Array.isArray(response['issues']) ? (response['issues'] as string[]) : [] }
        if ((c.name === 'create_file' || c.name === 'edit_file') && lastQa?.ok) lastQa = { ok: false, issues: ['files changed after the last passing test (not re-tested)'] }
        signal.throwIfAborted()
        if(c.name==='computer'&&computerFailures.record(response))throw new Error('Computer control stopped after three failed actions. No further input was sent. Observe and start a new request to recover.')
        evidence.observe(c.name ?? '', args, response)
        const failed = !!response['error'] || response['ok'] === false
        if(c.name==='computer'&&response.inputExecuted===true)computerActions++
        if (failed) failedActions.set(actionIdentity, (failedActions.get(actionIdentity) ?? 0) + 1)
        else failedActions.delete(actionIdentity)
        actions.push(failed ? `${label} — failed` : label)
        this.logger.info('agent', `tool ${c.name}`, { ok: !failed, error: response['error'] as string | undefined })
        const {image,...metadata}=response
        parts.push({ functionResponse: { id: c.id, name: c.name, response:metadata } })
        if(typeof image==='string') {
          const match=/^data:(image\/[a-z+]+);base64,(.+)$/i.exec(image)
          if(match) {
            // Keep only the latest two screenshots; past action metadata remains.
            const imageTurns=contents.filter(t=>t.parts?.some(p=>p.inlineData))
            for(const old of imageTurns.slice(0,-1))old.parts=old.parts?.filter(p=>!p.inlineData)
            parts.push({inlineData:{mimeType:match[1],data:match[2]}})
          }
        }
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
    if (lastQa && !lastQa.ok) reply += `\n\nNot yet resolved in the last website test (${lastQa.issues.length}): ${lastQa.issues.slice(0, 6).join('; ')}${lastQa.issues.length > 6 ? '; …' : ''}`
    const unresolved = evidence.issues()
    const ok = finished && !unresolved.length && (!desktopMission||computerActions>0) && (!lastQa || lastQa.ok)
    if (unresolved.length) reply = `Work remains incomplete: ${unresolved.join('; ')}\n\n${reply}`
    // Keep a compact history (no bulky tool payloads) for follow-ups like “now make it blue” or “continue”.
    const note = actions.length ? `\n(Done earlier: ${actions.slice(-20).join('; ')}${files.size ? `; files: ${[...files].slice(0, 20).join(', ')}` : ''})` : ''
    // Stored as a finished exchange so the next request isn't mistaken for a reason to redo this one.
    this.history.push({ role: 'user', parts: [{ text: `[Earlier request — ${finished ? 'already handled' : 'stopped before finishing; only resume if asked to continue'}]: ${text}` }] }, { role: 'model', parts: [{ text: reply + note }] })
    this.history = this.history.slice(-12)
    onProgress({ reply, files: [...files] })
    return { reply, actions, files: [...files], ok }
  }

  /**
   * One model turn, streamed: reply text reaches the UI as it is generated
   * (time-to-first-word instead of time-to-whole-answer). Every part is kept
   * exactly as received, so function calls keep their thought signatures.
   */
  private async generate(ai: GoogleGenAI, contents: Content[], systemInstruction: string, signal: AbortSignal | undefined, onText: (partial: string) => void, declarations=AGENT_TOOLS): Promise<Turn> {
    let lastErr: unknown
    const order = modelOrder(FLASH_MODELS, this.model)
    for (let i = 0; i < order.length; i++) {
      const model = order[i]
      // A stalled inference must not leave desktop input waiting for five
      // minutes. Builder generations keep their longer existing budget.
      const attempt = AbortSignal.timeout(declarations===DESKTOP_TOOLS?60_000:ATTEMPT_TIMEOUT_MS)
      // Deep thinking made every file take minutes; low thinking writes the same code far faster.
      const lowThinking = !TextAgent.noThinkingLevel.has(model)
      const requestSignal=signal?AbortSignal.any([signal,attempt]):attempt
      try {
        return await abortable(async()=>{
        const stream = await ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: declarations }],
            abortSignal: requestSignal,
            temperature: 0.4,
            maxOutputTokens: declarations===DESKTOP_TOOLS?4096:MAX_OUTPUT_TOKENS,
            ...(lowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
            httpOptions: { retryOptions: { attempts: 1 } }
          }
        })
        const parts: NonNullable<Content['parts']> = []
        const functionCalls: FunctionCall[] = []
        let text = ''
        let finishReason: string | undefined
        let lastEmit = 0
        for await (const chunk of stream) {
          requestSignal.throwIfAborted()
          const cand = chunk.candidates?.[0]
          if (cand?.finishReason) finishReason = cand.finishReason
          for (const p of cand?.content?.parts ?? []) {
            parts.push(p)
            if (p.functionCall) functionCalls.push(p.functionCall)
            else if (typeof p.text === 'string' && !p.thought) text += p.text
          }
          // Stream plain answers only; once a tool call shows up this turn is work, not a reply.
          const now = Date.now()
          if (text && !functionCalls.length && now - lastEmit > 60) {
            lastEmit = now
            onText(text)
          }
        }
        if (text && !functionCalls.length) onText(text)
        requestSignal.throwIfAborted()
        this.model = model
        markModelOk(model)
        return { content: parts.length ? { role: 'model', parts } : undefined, functionCalls, text, finishReason }
        },requestSignal)
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
        markModelFailed(model, attempt.aborted ? new Error('timed out') : err)
        this.logger.warn('agent', `model ${model} unavailable, trying next`, { message: msg.slice(0, 200) })
      }
    }
    throw lastErr
  }

  private static noThinkingLevel = new Set<string>()
}
