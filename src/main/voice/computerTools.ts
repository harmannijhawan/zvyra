import { Type, type FunctionDeclaration } from '@google/genai'
import { computerArgs, computerController } from '../computer/controller'
import type { OperatorHost } from './operatorTools'
import { uia } from '../tools/uia'
import { runDesktopTool } from './desktopTools'
import { ComputerInputError, isObservationConflict } from '../computer/recovery'

const point = { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] }
export const COMPUTER_DECLARATIONS: FunctionDeclaration[] = [{
  name: 'computer',
  description: 'Execute real Windows tasks in any app. launch(app) opens an installed app and observes it. observe(window?,question?) returns the ACTUAL screenshot, windows, controls with refs (e1), and frame. focus(window) switches to a named app. watch(duration_ms,interval_ms,question?) returns timestamped screen samples for changing UI; repeat to cover longer durations. It does not hear audio or prove unsampled content. wait(duration_ms) waits for loading then observes. For input use the latest frame (observation.frame after input). Prefer click(ref) and type(ref,text); name and control_type also work. type inserts literal Unicode at the caret; keys supports ctrl+a, ctrl+s, enter, tab. Coordinates refer to the actual screenshot pixels. scroll(ref or x,y) moves the pointer over that region first. Each action observes its result: CONTINUE the whole task. Set expected for concrete checkpoint and FINAL visible results. window(window_action) minimizes/maximizes/restores. draw takes arbitrary polylines. Recover by observing and replanning. inputExecuted=true or unknown forbids blindly repeating that action: inspect the outcome first. Consequential submissions ask approval; CAPTCHA/MFA require the user.',
  parameters: { type: Type.OBJECT, properties: {
    action: { type: Type.STRING, enum: ['observe','watch','wait','launch','focus','window','move','click','double_click','right_click','scroll','type','keys','drag','draw','resize'] },
    window:{type:Type.STRING},app:{type:Type.STRING},ref:{type:Type.STRING},control_type:{type:Type.STRING},window_action:{type:Type.STRING,enum:['minimize','maximize','restore']},
    frame: { type: Type.STRING,description:'Optional. The runtime automatically uses this session’s latest returned frame when omitted. If supplied, copy the exact latest token; never invent one.' }, question: { type: Type.STRING }, display_id: { type: Type.NUMBER },
    duration_ms:{type:Type.INTEGER,description:'Real time to wait/watch, 0–60000 ms; repeated watch calls cover longer content.'},interval_ms:{type:Type.INTEGER,description:'500–10000 ms between samples, automatically increased to keep at most 11 samples.'},
    x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, toX: { type: Type.NUMBER }, toY: { type: Type.NUMBER },
    name: { type: Type.STRING }, text: { type: Type.STRING }, keys: { type: Type.STRING }, deltaY: { type: Type.NUMBER }, deltaX: { type: Type.NUMBER },
    strokes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: point } }, space: { type: Type.STRING, enum: ['frame','physical'] },
    speed: { type: Type.NUMBER }, precision: { type: Type.NUMBER }, hz: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER },
    expected: { type: Type.STRING, description: 'Specific visible postcondition, not just successful input' }, intent: { type: Type.STRING }
  }, required: ['action'] }
}]
const sensitive = /\b(send|pay|buy|purchase|order|checkout|submit|publish|post|delete|remove|confirm|call|book|reserve|transfer|sign|subscribe|uninstall|format|erase|password|captcha|mfa|verification code)\b/i
type ComputerHost=OperatorHost & { computerEnabled?(): Promise<boolean>; computerSnapshots?:boolean; computerSession?:{frame?:string} }
export async function runComputerTool(host:ComputerHost,args:Record<string,unknown>,signal:AbortSignal):Promise<Record<string,unknown>> {
  // The runtime owns the last frame for this caller. Models often omit a
  // redundant frame argument on a follow-up click. Bind only that caller's
  // previously returned frame; never substitute another task's observation.
  const boundArgs=args.frame===undefined&&host.computerSession?.frame?{...args,frame:host.computerSession.frame}:args
  try{
    const result=await runComputerToolChecked(host,boundArgs,signal)
    if(host.computerSession&&typeof result.frame==='string')host.computerSession.frame=result.frame
    return result
  }catch(error){
    signal.throwIfAborted()
    if(isObservationConflict(error)||error instanceof ComputerInputError) {
      const inputExecuted=error instanceof ComputerInputError?error.inputExecuted:false
      const reason=error instanceof Error?error.message:String(error)
      let fresh:Record<string,unknown>={}
      try {fresh=await computerController.execute({action:'observe'},host.geminiKey(),signal,host.computerSnapshots)}
      catch(observationError) {
        signal.throwIfAborted()
        // Preserve the input receipt even if recovery itself cannot capture.
        fresh={observationError:observationError instanceof Error?observationError.message:String(observationError)}
      }
      if(host.computerSession)host.computerSession.frame=typeof fresh.frame==='string'?fresh.frame:undefined
      return {...fresh,ok:false,recoverable:error instanceof ComputerInputError?error.recoverable:true,inputExecuted,error:reason,verification:'pending',verified:false,note:inputExecuted===false?'No activating input was sent. Inspect the fresh frame and replan; do not reuse old refs or coordinates.': 'Input was delivered or may be partial. Inspect the fresh frame to determine what happened; do not repeat typing, clicks or submissions blindly.'}
    }
    throw error
  }
}
async function runComputerToolChecked(host: ComputerHost, args: Record<string, unknown>, signal: AbortSignal) {
  const a = computerArgs.parse(args)
  if(a.action==='launch') {
    if(!host.computerEnabled||!await host.computerEnabled())throw new Error('Enable Computer Control before launching apps')
    if(!a.app)throw new Error('Provide app, for example notepad, calculator or paint')
    const launched=await runDesktopTool(host,'launch_app',{name:a.app},signal)
    if(launched.error)return launched
    await computerController.waitForApp(a.app,signal)
    const observation = await computerController.execute({action:'observe'},host.geminiKey(),signal,host.computerSnapshots)
    return {...observation,inputExecuted:true,launched:a.app,ready:true,verified:true}
  }
  if (!['observe','watch','wait'].includes(a.action)) {
    if (!host.computerEnabled || !await host.computerEnabled()) throw new Error('Enable Computer Control before sending input.')
    if(a.action!=='focus')await computerController.prepare(a,signal)
    const fg = await uia.foreground()
    if (['type','keys'].includes(a.action) && /^(powershell|pwsh|cmd|windowsterminal|conhost)$/i.test(fg.process)) throw new Error('Use run_command for terminal work so command permissions and exit status are preserved.')
    const focused=await uia.focused().catch(()=>null)
    if(['type','keys'].includes(a.action)&&focused?.password)throw new Error('Authentication fields require the user')
    const target=computerController.target(a)??await computerController.hitTarget(a)
    const label=target?.name??a.name??''
    const consequentialKey=a.action==='keys'&&(/delete|\bdel\b/i.test(a.keys??'')||(/enter|return/i.test(a.keys??'')&&/chrome|msedge|brave|firefox/i.test(fg.process)&&!/(address|search|url)/i.test(focused?.name??'')))
    const unknownWebClick=['click','double_click'].includes(a.action)&&!target&&!a.name&&/chrome|msedge|brave|firefox/i.test(fg.process)
    if (sensitive.test(`${label} ${a.intent ?? ''}`) || consequentialKey || unknownWebClick) {
      computerController.setPhase('waiting_approval')
      const r = await host.requestApproval({ category: 'computer_input', title: `Computer: ${a.action}`, description: a.intent ?? 'This input may submit data or change the application.', risk: 'high', details: [{ label: 'Window', value: `${fg.process}: ${fg.title}` }, { label: 'Target', value: a.name ?? `${a.x ?? ''}, ${a.y ?? ''}` }], payload: a }, signal)
      if (!r.approved) return { ok: false, status: r.outcome, error: 'Computer action was not approved; no input sent.' }
    }
  }
  return computerController.execute(a,host.geminiKey(),signal,host.computerSnapshots)
}
