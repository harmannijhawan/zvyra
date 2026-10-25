/**
 * OWNER: Kiro. Typed-command / builder agent: Gemini function calling over the
 * same tools the voice session uses. Handles quick jobs (“make X and open
 * it”) and big ones (a full multi-page e-commerce site): a long step budget,
 * generous output for whole files, edit/verify tools and a build workflow.
 */
import { randomUUID } from 'node:crypto'
import { GoogleGenAI, ThinkingLevel, FunctionCallingConfigMode, type Content, type FunctionCall } from '@google/genai'
import type { ShellLogger } from '../backendContext'
import { AGENT_GUIDE, BUILDER_GUIDE, OPERATOR_GUIDE } from './desktopTools'
import { ALL_TOOL_DECLARATIONS, runTool, type ToolHost } from './extraTools'
import { FLASH_MODELS, isRetryable, markModelFailed, markModelOk, modelOrder } from '../tools/gemini'
import { CompletionEvidence } from '../agent/completion'
import { isDesktopMission } from '../computer/focusPolicy'
import { InputQueue } from '../computer/inputQueue'
import { abortable } from '../agent/abortable'
import { ComputerFailureBudget } from '../computer/failureBudget'
import { CHECKPOINT_TOOL, LONG_TASK_GUIDE, MissionMemory } from '../agent/missionMemory'
import { WORKFLOW_TOOL, TOOL_ROUTING_GUIDE, canonicalTools, workflowArgs } from '../agent/toolRouting'
import { WEBSITE_GUIDE } from '../agent/websiteDesign'
import { canUseFastPath, parseFastPathIntent, executeFastPath } from '../computer/fastPath'
import { TaskStateMachine } from '../computer/taskLifecycle'
import { TaskTelemetry } from '../computer/instrumentation'
import { computerController } from '../computer/controller'

// One model call may write several whole files; aborting a slow-but-working call wastes all of it.
const ATTEMPT_TIMEOUT_MS = 300_000
const MAX_STEPS = 600
const MAX_OUTPUT_TOKENS = 32_768
// The agent does the work itself; run_task is only for the voice session's hand-off.
const ROUTING_TOOLS = [WORKFLOW_TOOL]
const AGENT_TOOLS = [...canonicalTools(ALL_TOOL_DECLARATIONS).filter((d) => d.name !== 'run_task'), CHECKPOINT_TOOL, WORKFLOW_TOOL]
const DESKTOP_TOOLS = AGENT_TOOLS.filter((d) => ['computer', 'update_plan', 'task_checkpoint', 'select_workflow', 'get_status', 'control_tasks', 'web_search', 'read_webpage', 'list_folder', 'read_file', 'show_me_how'].includes(d.name ?? ''))
// Hold a mission lease while its model is planning too, so two desktop tasks
// cannot alternate focus and invalidate each other's screen observations.
const desktopMissions = new InputQueue()

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
    // Fast path: bypass large reasoning models for straightforward tasks
    if (canUseFastPath(text)) {
      const intent = parseFastPathIntent(text)
      if (intent.kind !== 'unknown' && intent.confidence >= 0.9) {
        const taskId = `zt-${randomUUID()}`
        const lifecycle = new TaskStateMachine(taskId, text, true)
        const telemetry = new TaskTelemetry(taskId, true)
        onProgress({ action: `Starting ${intent.targetApp ?? intent.kind}`, step: 1 })
        const result = await executeFastPath(intent, this.host, lifecycle, telemetry, signal)
        if (result.ok) {
          telemetry.finish(true, result.summary)
          this.logger.info('agent', 'fast path completed', { action: result.action, durationMs: telemetry.snapshot().totalDurationMs })
          onProgress({ reply: result.summary })
          return { reply: result.summary, actions: [result.summary], files: [], ok: true }
        }
      }
    }

    // A request may discover that it needs UI midway through research. Lease
    // the mission regardless of wording, so arbitrary apps receive the same
    // protection as the explicitly labelled Computer tasks.
    return desktopMissions.run((s) => this.runMission(text, onProgress, s), signal)
  }

  private async runMission(text: string, onProgress: AgentProgress, signal?: AbortSignal): Promise<{ reply: string; actions: string[]; files: string[]; ok: boolean }> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(2 * 60 * 60 * 1000)])
    const key = this.getKey()
    if (!key) throw new Error('Add a Gemini API key in Settings → Voice to use ZVYRA’s assistant.')
    const ai = new GoogleGenAI({ apiKey: key })
    const desktopHint = isDesktopMission(text)
    let desktopMission = desktopHint
    const runHost = { ...this.host, computerSnapshots: true, computerSession: {} }
    let declaredTools = ROUTING_TOOLS
    let routed = false
    const websiteMission = /\b(website|web site|webpage|landing page|storefront|portfolio|dashboard|hero section|product page|mobile navigation)\b/i.test(text)
    let websiteDesign: Record<string, unknown> | null = null
    let websiteChanged = false
    const websiteStarted = Date.now()
    let modelMs = 0
    let toolMs = 0

    const taskId = `zt-${randomUUID()}`
    const lifecycle = new TaskStateMachine(taskId, text)
    const telemetry = new TaskTelemetry(taskId)
    computerController.bindLifecycle(lifecycle)

    const systemInstruction = [
      'You are ZVYRA, a capable personal AI that lives on the user’s Windows PC. Be brief, warm and direct in what you say, and thorough in what you build.',
      AGENT_GUIDE,
      OPERATOR_GUIDE,
      BUILDER_GUIDE,
      WEBSITE_GUIDE,
      LONG_TASK_GUIDE,
      TOOL_ROUTING_GUIDE,
      desktopMission ? 'DESKTOP MISSION: perform this complete request with the computer tool. Start update_plan, then computer launch/observe/focus. Use real clicks, keystrokes and typing, repeatedly, until all requested results are verified. You receive actual screenshots and accessible refs after every action. Do not return instructions or ask the user to click routine controls. Do not create results through shell commands or source-file tools. Recover from stale frames by observing; continue without needing another user message. Use expected only at meaningful checkpoints and the final outcome. Never stop after announcing a plan. When the outcome is confirmed, finish immediately. If you cannot finish, report the actual blocker and completed steps.' : '',
      await this.context().catch(() => '')
    ].join('\n')

    try {
      // Earlier turns are context only; the model must work on THIS request (unless it asks to continue).
      const followUp = /^\s*(continue|keep going|go on|resume|carry on|finish (it|that)|do (it|that) again|retry|try again)\b/i.test(text)
      const framed = this.history.length
        ? `NEW REQUEST — do only this${followUp ? ' (it refers to the previous request)' : '. Everything earlier in this conversation is already finished: do not repeat earlier tasks or tool calls; use them only as background (e.g. “it”, “that file”)'}:\n${text}`
        : text
      // Keep the immediately preceding exchange inside the compaction anchor so
      // references such as "continue" or "that document" survive rotation too.
      const previous = this.history.slice(-2).flatMap((t) => (t.parts ?? []).map((p) => p.text ?? '')).join('\n')
      const request: Content = { role: 'user', parts: [{ text: previous ? `Previous exchange for reference only; do not replay it unless the current request asks:\n${previous}\n\n${framed}` : framed }] }
      const contents: Content[] = [...this.history.slice(-12, -2), request]
      const memory = new MissionMemory()
      const actions: string[] = []
      const files = new Set<string>()
      let reply = ''
      let finished = false
      const evidence = new CompletionEvidence()
      let correctionAttempts = 0
      let computerObserved = false
      let usedComputer = false
      const failedActions = new Map<string, number>()
      const computerFailures = new ComputerFailureBudget()
      // The last website test result: if it still failed when the agent stopped, the reply must say so.
      let lastQa: { ok: boolean; issues: string[] } | null = null

      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal?.aborted) throw new Error('Cancelled')
        if (memory.compact(contents, request)) onProgress({ thinking: 'Keeping task findings and the current UI in working memory…' })
        const t0 = Date.now()
        const beat = setInterval(() => onProgress({ thinking: `${desktopMission || usedComputer ? 'Planning the next desktop action' : files.size ? 'Writing the next file' : 'Working on your request'}… ${Math.round((Date.now() - t0) / 1000)}s` }), 4000)
        let res: Turn
        let firstTokenMs = 0
        try {
          telemetry.startModelCall()
          res = await this.generate(ai, contents, websiteDesign ? systemInstruction + '\nCURRENT WEBSITE CONTRACT (project data):\n' + JSON.stringify(websiteDesign) : systemInstruction, signal, (partial) => {
            if (!firstTokenMs) firstTokenMs = Date.now() - t0
            onProgress({ partial })
          }, declaredTools, websiteMission && (!websiteDesign || !!lastQa && !lastQa.ok))
          telemetry.stopModelCall()
        } finally {
          clearInterval(beat)
        }
        this.logger.info('agent', `step ${step + 1}`, { ms: Date.now() - t0, firstTokenMs: firstTokenMs || undefined, model: this.model, calls: res.functionCalls.length, finish: res.finishReason })
        modelMs += Date.now() - t0
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
          if (websiteChanged && !lastQa?.ok) unresolved.push('Website source changes require a passing check_site against the actual preview before delivery.')
          if (desktopMission && !computerObserved) unresolved.push('The desktop task has not inspected the UI. Start the computer tool now.')
          if (memory.pending().length) unresolved.push(`Plan milestones remain incomplete: ${memory.pending().join('; ')}`)
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
          if (c.name === 'select_workflow') {
            try {
              const workflow = workflowArgs.parse(args)
              desktopMission = desktopHint || workflow.mode === 'computer'
              declaredTools = desktopMission ? DESKTOP_TOOLS : AGENT_TOOLS
              routed = true
              let observation: Record<string, unknown> = {}
              if (workflow.needs_screen || desktopMission) {
                onProgress({ action: 'Inspecting the current screen', step: step + 1 })
                try {
                  telemetry.startUiInspection()
                  observation = await runTool(runHost, 'computer', { action: 'observe', question: text.slice(0, 1000) }, signal)
                  telemetry.stopUiInspection()
                } catch (error) {
                  signal.throwIfAborted()
                  observation = { ok: false, error: error instanceof Error ? error.message : String(error) }
                }
                computerObserved ||= typeof observation.frame === 'string'
                usedComputer = true
                evidence.observe('computer', { action: 'observe' }, observation)
                memory.record('computer', { action: 'observe' }, observation)
                actions.push('Inspecting the current screen')
              }
              const { image, ...metadata } = observation
              parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: true, ...workflow, observation: metadata, note: desktopMission ? 'Use computer for this application. Continue from the actual frame.' : 'Use the tools that fit each phase. No modifying input is needed for an explanation alone.' } } })
              if (typeof image === 'string') {
                const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(image)
                if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
              }
            } catch (error) {
              parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: false, error: error instanceof Error ? error.message : String(error) } } })
            }
            continue
          }
          if (!routed) {
            parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: false, error: 'Select a workflow with select_workflow before taking actions.' } } })
            continue
          }
          if (!declaredTools.some((tool) => tool.name === c.name)) {
            parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: false, error: 'That tool is not available in this workflow. Use computer for visible UI, or select_workflow to change the work mode.' } } })
            continue
          }
          // The plan is progress for the user, not work: show it and move on.
          if (c.name === 'update_plan') {
            const steps = Array.isArray(args['steps']) ? (args['steps'] as { title: string; status: string }[]) : []
            memory.setPlan(steps)
            lifecycle.setPlan(steps)
            onProgress({ plan: steps })
            parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: true, steps: steps.length } } })
            continue
          }
          if (c.name === 'task_checkpoint') {
            try {
              parts.push({ functionResponse: { id: c.id, name: c.name, response: memory.save(args) } })
            } catch (error) {
              parts.push({ functionResponse: { id: c.id, name: c.name, response: { ok: false, error: error instanceof Error ? error.message : String(error) } } })
            }
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
            if (websiteMission && c.name === 'build_business_site') throw new Error('The fixed restaurant scaffold cannot implement this custom website. Commit design_brief and implement its components with create_file/edit_file.')
            if (websiteMission && ['create_file', 'edit_file'].includes(c.name ?? '') && /\.(html?|css|[jt]sx?)$/i.test(String(args.path ?? '')) && !websiteDesign)
              throw new Error('Before website source edits, commit design_brief with project_dir and specification_json, or read the existing .zvyra/website-design.json to reuse its decisions.')
            const toolStarted = Date.now()
            telemetry.startActionExecution()
            response = await runTool(runHost, c.name ?? '', args, signal)
            telemetry.stopActionExecution(!response['error'] && response['ok'] !== false)
            toolMs += Date.now() - toolStarted
          } catch (err) {
            telemetry.stopActionExecution(false)
            response = { error: err instanceof Error ? err.message : String(err) }
          }
          if (!response.error && response.ok !== false) {
            if (c.name === 'design_brief' && response.specification) websiteDesign = response.specification as Record<string, unknown>
            if (c.name === 'read_file' && /[\\/]\.zvyra[\\/]website-design\.json$/i.test(String(response.path ?? ''))) {
              try { websiteDesign = JSON.parse(String(response.content)).specification ?? null } catch { /* invalid persisted data must be recommitted */ }
            }
            if (websiteMission && ['create_file', 'edit_file'].includes(c.name ?? '') && /\.(html?|css|[jt]sx?)$/i.test(String(response.path ?? ''))) websiteChanged = true
          }
          if (['create_file', 'edit_file', 'build_business_site'].includes(c.name ?? '') && typeof response['path'] === 'string') files.add(response['path'])
          if (c.name === 'check_site' && !response['error']) lastQa = { ok: response['ok'] === true, issues: Array.isArray(response['issues']) ? (response['issues'] as string[]) : [] }
          if ((c.name === 'create_file' || c.name === 'edit_file') && lastQa?.ok) lastQa = { ok: false, issues: ['files changed after the last passing test (not re-tested)'] }
          signal.throwIfAborted()
          if (c.name === 'computer' && computerFailures.record(response)) throw new Error('Computer control stopped after repeated failed actions or unsuccessful recovery attempts. No further input was sent.')
          evidence.observe(c.name ?? '', args, response)
          memory.record(c.name ?? '', args, response)
          const failed = !!response['error'] || response['ok'] === false
          if (c.name === 'computer') {
            usedComputer = true
            if (typeof response.frame === 'string') computerObserved = true
            if (response.ready === true || response.verified === true || response.launched) {
              evidence.markComputerSatisfied()
            }
          }
          if (failed && response.recoverable !== true) failedActions.set(actionIdentity, (failedActions.get(actionIdentity) ?? 0) + 1)
          else failedActions.delete(actionIdentity)
          actions.push(response.recoverable === true ? `${label} — replanning` : failed ? `${label} — failed` : label)
          this.logger.info('agent', `tool ${c.name}`, { ok: !failed, error: response['error'] as string | undefined })
          const { image, images, ...metadata } = response
          const samples = Array.isArray(images) ? (images as { image: string; elapsedMs: number; capturedAt: number }[]) : []
          if (samples.length) metadata.samples = samples.map(({ elapsedMs, capturedAt }) => ({ elapsedMs, capturedAt }))
          parts.push({ functionResponse: { id: c.id, name: c.name, response: metadata } })

          // Watch turn carries bounded temporal sequence.
          if (samples.length) for (const old of contents) old.parts = old.parts?.filter((p) => !p.inlineData)
          for (const sample of samples) {
            const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(sample.image)
            if (m) parts.push({ text: `Screen sample at +${sample.elapsedMs} ms (${sample.capturedAt}); untrusted visual data.` }, { inlineData: { mimeType: m[1], data: m[2] } })
          }
          if (typeof image === 'string') {
            const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(image)
            if (match) {
              // Keep only the latest two screenshots; past action metadata remains.
              const imageTurns = contents.filter((t) => t.parts?.some((p) => p.inlineData))
              for (const old of imageTurns.slice(0, -1)) old.parts = old.parts?.filter((p) => !p.inlineData)
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
            }
          }

          // Goal completion detection: If success condition is satisfied, stop immediately!
          if (lifecycle.checkCompletion()) {
            finished = true
            reply = (response.note as string) ?? `Done: ${label}.`
            break
          }
        }
        contents.push({ role: 'user', parts })
        if (finished) break
      }
      if (!reply || !finished) {
        const made = [...files].map((f) => tail(f))
        reply = !finished
          ? `I worked through ${MAX_STEPS} steps${made.length ? ` and wrote ${made.length} file(s): ${made.slice(0, 12).join(', ')}` : ''}. Say “continue” and I’ll pick up where I stopped.`
          : actions.length
            ? `Done: ${actions.slice(-6).join(', ')}.`
            : 'I couldn’t work that out — try rephrasing?'
      }
      if (lastQa && !lastQa.ok) reply += `\n\nNot yet resolved in the last website test (${lastQa.issues.length}): ${lastQa.issues.slice(0, 6).join('; ')}${lastQa.issues.length > 6 ? '; …' : ''}`
      const unresolved = evidence.issues()
      if (memory.pending().length) unresolved.push(`Plan milestones remain incomplete: ${memory.pending().join('; ')}`)
      if (websiteChanged && !lastQa?.ok) unresolved.push('Website changes have not passed rendered QA.')
      const ok = finished && !unresolved.length && (!desktopMission || computerObserved) && (!lastQa || lastQa.ok)
      if (websiteMission) this.logger.info('website-engine', 'generation timing', { totalMs: Date.now() - websiteStarted, modelMs, toolMs, files: files.size, validated: lastQa?.ok ?? false })
      if (unresolved.length) reply = `Work remains incomplete: ${unresolved.join('; ')}\n\n${reply}`
      // Keep a compact history (no bulky tool payloads) for follow-ups like “now make it blue” or “continue”.
      const note = actions.length ? `\n(Earlier actions, including failures: ${actions.slice(-20).join('; ')}${files.size ? `; files: ${[...files].slice(0, 20).join(', ')}` : ''})` : ''
      // Stored as a finished exchange so the next request isn't mistaken for a reason to redo this one.
      this.history.push({ role: 'user', parts: [{ text: `[Earlier request — ${ok ? 'already handled' : 'stopped before finishing; only resume if asked to continue'}]: ${text}` }] }, { role: 'model', parts: [{ text: reply + note + (!ok ? `\nTask checkpoint: ${memory.summary()}` : '') }] })
      this.history = this.history.slice(-12)
      telemetry.finish(ok, reply)
      onProgress({ reply, files: [...files] })
      return { reply, actions, files: [...files], ok }
    } finally {
      computerController.unbindLifecycle()
    }
  }

  /**
   * One model turn, streamed: reply text reaches the UI as it is generated
   * (time-to-first-word instead of time-to-whole-answer). Every part is kept
   * exactly as received, so function calls keep their thought signatures.
   */
  private async generate(ai: GoogleGenAI, contents: Content[], systemInstruction: string, signal: AbortSignal | undefined, onText: (partial: string) => void, declarations = AGENT_TOOLS, reasoning = false): Promise<Turn> {
    let lastErr: unknown
    const order = modelOrder(FLASH_MODELS, this.model)
    for (let i = 0; i < order.length; i++) {
      const model = order[i]
      // A stalled inference must not leave desktop input waiting for five
      // minutes. Builder generations keep their longer existing budget.
      const attempt = AbortSignal.timeout(declarations === DESKTOP_TOOLS ? 90_000 : ATTEMPT_TIMEOUT_MS)
      // Deep thinking made every file take minutes; low thinking writes the same code far faster.
      const lowThinking = !TextAgent.noThinkingLevel.has(model)
      const requestSignal = signal ? AbortSignal.any([signal, attempt]) : attempt
      try {
        return await abortable(async () => {
          const stream = await ai.models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: declarations }],
              ...(declarations === ROUTING_TOOLS ? { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['select_workflow'] } } } : {}),
              abortSignal: requestSignal,
              temperature: 0.4,
              maxOutputTokens: declarations === DESKTOP_TOOLS ? 4096 : MAX_OUTPUT_TOKENS,
              ...(lowThinking ? { thinkingConfig: { thinkingLevel: reasoning ? ThinkingLevel.HIGH : ThinkingLevel.LOW } } : {}),
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
        }, requestSignal)
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
