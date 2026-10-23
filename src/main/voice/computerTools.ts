import { Type, type FunctionDeclaration } from '@google/genai'
import { computerArgs, computerController } from '../computer/controller'
import type { OperatorHost } from './operatorTools'
import { uia } from '../tools/uia'
import { runDesktopTool } from './desktopTools'

const point = { type: Type.OBJECT, properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } }, required: ['x', 'y'] }
export const COMPUTER_DECLARATIONS: FunctionDeclaration[] = [{
  name: 'computer',
  description: 'Execute real Windows tasks. launch(app) opens an installed app and observes it. observe(window?,question?) returns the ACTUAL screenshot, windows, controls with refs (e1), and frame. focus(window) switches to a named app. For input use the latest frame (observation.frame after input). Prefer click(ref) and type(ref,text); name and control_type also work. type inserts literal Unicode at the caret; keys supports ctrl+a, ctrl+s, enter, tab. Coordinates refer to the actual screenshot pixels. Each action observes its result: CONTINUE the whole task without asking the user for routine clicks. Set expected for the FINAL visible result, then verify before finishing. window(window_action) minimizes/maximizes/restores the app. draw takes arbitrary polylines. Recover by observing and replanning, never replay stale coordinates. Consequential submissions ask approval; CAPTCHA/MFA require the user.',
  parameters: { type: Type.OBJECT, properties: {
    action: { type: Type.STRING, enum: ['observe','launch','focus','window','move','click','double_click','right_click','scroll','type','keys','drag','draw','resize'] },
    window:{type:Type.STRING},app:{type:Type.STRING},ref:{type:Type.STRING},control_type:{type:Type.STRING},window_action:{type:Type.STRING,enum:['minimize','maximize','restore']},
    frame: { type: Type.STRING }, question: { type: Type.STRING }, display_id: { type: Type.NUMBER },
    x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, toX: { type: Type.NUMBER }, toY: { type: Type.NUMBER },
    name: { type: Type.STRING }, text: { type: Type.STRING }, keys: { type: Type.STRING }, deltaY: { type: Type.NUMBER }, deltaX: { type: Type.NUMBER },
    strokes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: point } }, space: { type: Type.STRING, enum: ['frame','physical'] },
    speed: { type: Type.NUMBER }, precision: { type: Type.NUMBER }, hz: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER },
    expected: { type: Type.STRING, description: 'Specific visible postcondition, not just successful input' }, intent: { type: Type.STRING }
  }, required: ['action'] }
}]
const sensitive = /\b(send|pay|buy|purchase|order|checkout|submit|publish|post|delete|remove|confirm|call|book|reserve|transfer|sign|subscribe|uninstall|format|erase|password|captcha|mfa|verification code)\b/i
type ComputerHost=OperatorHost & { computerEnabled?(): Promise<boolean>; computerSnapshots?:boolean }
export async function runComputerTool(host:ComputerHost,args:Record<string,unknown>,signal:AbortSignal):Promise<Record<string,unknown>> {
  try{return await runComputerToolChecked(host,args,signal)}catch(error){
    signal.throwIfAborted()
    if(/observe again|stale|window changed|moved|ref|resolve uniquely/i.test(String(error)))return {...await computerController.execute({action:'observe'},host.geminiKey(),signal,host.computerSnapshots),ok:false,recoverable:true,error:String(error),note:'Replan from this fresh screenshot and continue; do not replay a failed click.'}
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
    return {...await computerController.execute({action:'observe'},host.geminiKey(),signal,host.computerSnapshots),inputExecuted:true,launched:a.app}
  }
  if (a.action !== 'observe') {
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
