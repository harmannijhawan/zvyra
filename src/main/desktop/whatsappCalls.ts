/**
 * OWNER: Kiro. WhatsApp voice-call service for automatic task notifications
 * and voice-commanded contact search ("call [name]").
 *
 * Integrates:
 * - WhatsApp Desktop contact search and calling (whatsappVision.ts)
 * - Assisted call audio routing with VB-CABLE (callAgent.ts)
 * - Task completion events (agentTasks.ts)
 * - Natural voice conversation during calls
 *
 * Default contact: configured via settings (defaults to +91 9999653622).
 */
import { join } from 'node:path'
import type { ShellLogger } from '../backendContext'
import { CallAgent, type CallLine, type CallOptions } from '../voice/callAgent'
import { hangUpCall, openChatByName, callOpenChat } from '../tools/whatsappVision'
import { audioState, MicSwap } from '../tools/audioDevices'
import type { JsonDoc } from './jsonDoc'

export interface WhatsAppCallsState {
  /** Preferred contact name or phone number for automatic calls. */
  defaultContact: string
  /** Enable automatic calls on task completion. */
  autoCallEnabled: boolean
  /** Minimum task priority that triggers a call. */
  minPriority: 'low' | 'normal' | 'high' | 'critical'
  /** Last notification sent to avoid duplicates. */
  lastNotification?: { taskId: string; timestamp: string }
  /** Verified contact identity for WhatsApp search. */
  verifiedContact?: { name: string; header: string }
}

type CallState = 'idle' | 'preparing' | 'ringing' | 'connected' | 'ended' | 'failed'

export class WhatsAppCallService {
  private callAgent: CallAgent
  private micSwap: MicSwap
  private currentState: CallState = 'idle'
  private currentContact: string | null = null
  private callLines: CallLine[] = []
  private callNote: string = ''

  constructor(
    private readonly doc: JsonDoc<WhatsAppCallsState>,
    private readonly logger: ShellLogger,
    private readonly getKey: () => string | null,
    private readonly getModel: () => string,
    private readonly getVoice: () => string,
    private readonly getOwnerName: () => Promise<string | undefined>,
    userDataPath: string
  ) {
    this.callAgent = new CallAgent(logger, join(userDataPath, '../preload'))
    this.micSwap = new MicSwap(join(userDataPath, 'mic-swap.json'))
    // Recover microphone state on startup in case a previous call left it changed
    void this.micSwap.recover().catch((e) => logger.warn('whatsapp-calls', 'mic recovery failed', { message: String((e as Error)?.message ?? e) }))

    // Migration: if defaultContact is still "Rachna" or another obsolete name, update to the authorized number
    const state = this.doc.get()
    if (state.defaultContact === 'Rachna' || !/^\+?\d[\d\s\-]+$/.test(state.defaultContact)) {
      this.doc.set({ ...state, defaultContact: '+91 9999653622' })
      this.logger.info('whatsapp-calls', 'Migrated defaultContact to authorized number', { old: state.defaultContact, new: '+91 9999653622' })
    }
  }

  getState(): WhatsAppCallsState {
    return this.doc.get()
  }

  updateState(patch: Partial<WhatsAppCallsState>): WhatsAppCallsState {
    this.doc.set({ ...this.doc.get(), ...patch })
    return this.doc.get()
  }

  /** Check if WhatsApp is ready for calling (authenticated, audio devices available). */
  async checkReadiness(): Promise<{ ok: boolean; outputs: string[]; error?: string }> {
    try {
      const audio = await this.callAgent.checkAudio()
      if (!audio.ok) {
        return { ok: false, outputs: audio.outputs, error: `Audio device "${audio.label}" not found. Install VB-CABLE and set WhatsApp's microphone to "CABLE Output".` }
      }
      // Verify WhatsApp Desktop is installed and can be opened
      const { openChatByName } = await import('../tools/whatsappVision')
      await openChatByName(this.getKey()!, this.getState().defaultContact)
      return { ok: true, outputs: audio.outputs }
    } catch (err) {
      return { ok: false, outputs: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Resolve a contact by name and verify it exists in WhatsApp. */
  async resolveContact(name: string): Promise<{ found: boolean; header?: string; error?: string }> {
    try {
      const key = this.getKey()
      if (!key) return { found: false, error: 'Gemini API key required for contact search' }
      const chat = await openChatByName(key, name)
      // Persist the verified contact
      this.updateState({ verifiedContact: { name, header: chat.header } })
      return { found: true, header: chat.header }
    } catch (err) {
      return { found: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Start a WhatsApp voice call to the specified contact. */
  async startCall(contact: string, goal: string, options?: { joined?: boolean }): Promise<{ started: boolean; error?: string }> {
    if (this.currentState !== 'idle') {
      return { started: false, error: `A call is already in progress (${this.currentState})` }
    }

    const key = this.getKey()
    if (!key) return { started: false, error: 'Gemini API key required for voice calls' }

    this.currentState = 'preparing'
    this.currentContact = contact
    this.callLines = []
    this.callNote = ''

    try {
      // Prepare audio: switch default mic to VB-CABLE
      await this.micSwap.toCable()

      // Open the chat and verify the contact
      const chat = await openChatByName(key, contact)

      // Initiate the call through WhatsApp
      const callResult = await callOpenChat(key, chat, false)
      if (callResult.status !== 'call_interface_opened') {
        throw new Error(callResult.note)
      }

      this.currentState = 'ringing'

      // Start the assisted voice session
      const owner = await this.getOwnerName() ?? 'the user'
      const audio = await audioState()
      const realMic = audio.devices.find((d) => d.flow === 'recording' && !/CABLE/i.test(d.name))?.name ?? 'Default'

      const callOptions: CallOptions = {
        key,
        model: this.getModel(),
        voice: this.getVoice(),
        contact,
        owner,
        goal,
        realMic,
        joined: options?.joined ?? false,
        hangUp: async () => {
          const hungUp = await hangUpCall(key)
          return hungUp
        },
        onUpdate: (update) => {
          if (update.state === 'connecting') this.currentState = 'ringing'
          else if (update.state === 'live') this.currentState = 'connected'
          else if (update.state === 'ended') this.currentState = 'ended'
          this.callLines = update.lines
          this.callNote = update.note ?? ''
          this.logger.info('whatsapp-calls', 'state update', { state: update.state, lines: update.lines.length, note: update.note })
        }
      }

      await this.callAgent.start(callOptions)
      this.currentState = 'connected'
      return { started: true }
    } catch (err) {
      this.currentState = 'failed'
      this.callNote = err instanceof Error ? err.message : String(err)
      // Cleanup audio on failure
      await this.micSwap.restore().catch(() => undefined)
      return { started: false, error: this.callNote }
    }
  }

  /** End the current call. */
  async endCall(): Promise<void> {
    if (this.currentState === 'idle') return
    await this.callAgent.end('Call ended by user')
    await this.micSwap.restore().catch(() => undefined)
    this.currentState = 'idle'
    this.currentContact = null
  }

  /** Current call state for UI display. */
  getStatus(): { state: CallState; contact: string | null; lines: CallLine[]; note: string } {
    return {
      state: this.currentState,
      contact: this.currentContact,
      lines: this.callLines,
      note: this.callNote
    }
  }

  /** Hand the call back to the user (their mic goes into WhatsApp). */
  handBack(): boolean {
    return this.callAgent.handBack()
  }

  /** Take over the call (ZVYRA speaks again). */
  takeOver(goal?: string): boolean {
    return this.callAgent.takeOver(goal)
  }

  /** Check if a call is currently active. */
  isActive(): boolean {
    return this.callAgent.active
  }

  /** Trigger an automatic call for task completion. */
  async notifyTaskCompletion(taskId: string, taskTitle: string, summary: string, priority: 'low' | 'normal' | 'high' | 'critical'): Promise<{ called: boolean; error?: string }> {
    const state = this.getState()

    // Check if auto-calls are enabled and priority threshold is met
    if (!state.autoCallEnabled) return { called: false, error: 'Auto-calls disabled' }

    const priorityOrder = { low: 0, normal: 1, high: 2, critical: 3 }
    if (priorityOrder[priority] < priorityOrder[state.minPriority]) {
      return { called: false, error: `Task priority (${priority}) below minimum (${state.minPriority})` }
    }

    // Prevent duplicate calls for the same task
    if (state.lastNotification?.taskId === taskId) {
      const age = Date.now() - Date.parse(state.lastNotification.timestamp)
      if (age < 5 * 60 * 1000) { // 5 minute cooldown
        return { called: false, error: 'Already notified for this task recently' }
      }
    }

    // Check if a call is already active
    if (this.isActive()) {
      return { called: false, error: 'Another call is in progress' }
    }

    // Check audio readiness
    const readiness = await this.checkReadiness()
    if (!readiness.ok) {
      return { called: false, error: readiness.error }
    }

    // Start the call to the default contact
    const contact = state.defaultContact
    const goal = `Tell ${contact} that ${taskTitle} is finished. ${summary}`

    const result = await this.startCall(contact, goal)
    if (result.started) {
      this.updateState({ lastNotification: { taskId, timestamp: new Date().toISOString() } })
    }

    return { called: result.started, error: result.error }
  }

  /** Trigger an automatic call for a blocker that needs user input. */
  async notifyBlocker(taskId: string, taskTitle: string, blocker: string): Promise<{ called: boolean; error?: string }> {
    const state = this.getState()

    // Blockers always trigger a call regardless of priority if auto-calls are enabled
    if (!state.autoCallEnabled) return { called: false, error: 'Auto-calls disabled' }

    // Prevent duplicate blocker calls
    if (state.lastNotification?.taskId === taskId) {
      const age = Date.now() - Date.parse(state.lastNotification.timestamp)
      if (age < 10 * 60 * 1000) { // 10 minute cooldown for blockers
        return { called: false, error: 'Already notified about this blocker recently' }
      }
    }

    // Check if a call is already active
    if (this.isActive()) {
      return { called: false, error: 'Another call is in progress' }
    }

    // Check audio readiness
    const readiness = await this.checkReadiness()
    if (!readiness.ok) {
      return { called: false, error: readiness.error }
    }

    // Start the call to the default contact
    const contact = state.defaultContact
    const goal = `Ask ${contact} for help with ${taskTitle}. The blocker is: ${blocker}`

    const result = await this.startCall(contact, goal)
    if (result.started) {
      this.updateState({ lastNotification: { taskId, timestamp: new Date().toISOString() } })
    }

    return { called: result.started, error: result.error }
  }

  /** Clean up resources on shutdown. */
  dispose(): void {
    void this.endCall()
    this.callAgent.dispose()
  }
}
