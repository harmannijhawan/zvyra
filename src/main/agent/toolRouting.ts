import { Type, type FunctionDeclaration } from '@google/genai'
import { z } from 'zod'

export const workflowArgs=z.object({
  mode:z.enum(['answer','research','computer','build','mixed']),
  needs_screen:z.boolean(),reason:z.string().min(1).max(800)
}).strict()
export const WORKFLOW_TOOL:FunctionDeclaration={
  name:'select_workflow',
  description:'Choose tools from the meaning of the CURRENT user request before acting. computer=operate an existing application or the user’s current browser/account through its visible UI; research=gather information; build=write/edit source files or a software project; mixed=combine UI work and research/files; answer=explain without modifying anything. Set needs_screen=true whenever the request depends on what is open/selected/visible, even for a question. The runtime then gives you a real computer observation before you choose an action. Never choose by a fixed list of app names. You can call again when a later phase needs different tools.',
  parameters:{type:Type.OBJECT,properties:{mode:{type:Type.STRING,enum:['answer','research','computer','build','mixed']},needs_screen:{type:Type.BOOLEAN},reason:{type:Type.STRING}},required:['mode','needs_screen','reason']}
}

// Only one desktop input API is offered to the model. Legacy APIs remain for
// existing integrations, but cannot bypass frame/permission checks here.
const legacyUi=new Set(['ui_click','ui_type','press_keys','screen_context','look_at_screen'])
export const canonicalTools=(tools:FunctionDeclaration[])=>tools.filter(t=>!legacyUi.has(t.name??''))

export const TOOL_ROUTING_GUIDE=[
  'Choose a workflow with select_workflow before using tools. Route by the objective and current phase, not app names or trigger words. A question about an open app requires observation before an answer; a general question does not require mouse input.',
  'When the user asks you to operate an existing app, edit existing content, or work inside their current signed-in page/account, use computer. First inspect the current screen; focus the intended window if needed. Do not substitute a new file, instructions, a web search, or an isolated browser profile for work in that app.',
  'Use web tools for facts and source discovery. Use source/file tools when the objective is code or file creation. If research depends on the user’s open context, inspect it first and then research. Combine methods for mixed work, retaining the current user objective.',
  'For visible UI, computer is the only input path: observe before input, use the newest frame, inspect every result, and switch back to observation when a menu/dialog/navigation changes the interface. For a how-to question explain or guide; only perform modifications the user requested.'
].join('\n')
