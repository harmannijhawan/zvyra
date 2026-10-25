import {beforeEach,describe,it,expect,vi} from 'vitest'
const f=vi.hoisted(()=>({frame:0,current:'',inputs:0,prepare:vi.fn(),execute:vi.fn()}))
vi.mock('../../src/main/computer/controller',()=>({computerArgs:{parse:(v:unknown)=>v},computerController:{prepare:f.prepare,execute:f.execute,target:()=>({name:'Activate',type:'Button'}),hitTarget:vi.fn(),setPhase:vi.fn()}}))
vi.mock('../../src/main/tools/uia',()=>({uia:{foreground:async()=>({process:'fixture',title:'Local test'}),focused:async()=>null}}))
vi.mock('../../src/main/voice/desktopTools',()=>({runDesktopTool:vi.fn()}))
import {runComputerTool} from '../../src/main/voice/computerTools'
import type {ToolHost} from '../../src/main/voice/extraTools'
const host=()=>({computerEnabled:async()=>true,geminiKey:()=>null,computerSession:{}} as unknown as ToolHost)
beforeEach(()=>{
  f.frame=0;f.current='';f.inputs=0;vi.clearAllMocks()
  f.prepare.mockImplementation(async(a:{frame?:string})=>{if(a.frame!==f.current||!a.frame)throw new Error('Observe again with a fresh frame before input')})
  f.execute.mockImplementation(async(a:{action:string})=>{if(a.action!=='observe')f.inputs++;f.current=`f${++f.frame}`;return {ok:true,frame:f.current,inputExecuted:a.action!=='observe'}})
})
describe('session-owned desktop observations',()=>{
  it('carries the observed frame into a follow-up click when the model omits it',async()=>{
    const h=host(),signal=new AbortController().signal
    await runComputerTool(h,{action:'observe'},signal)
    const result=await runComputerTool(h,{action:'click',ref:'e1'},signal)
    expect(result.inputExecuted).toBe(true);expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({frame:'f1'}),signal)
    expect(h.computerSession?.frame).toBe('f2');expect(f.inputs).toBe(1)
  })
  it('never borrows another session frame or silently replaces an explicitly stale one',async()=>{
    const a=host(),b=host(),signal=new AbortController().signal
    await runComputerTool(a,{action:'observe'},signal)
    const noFrame=await runComputerTool(b,{action:'click',ref:'e1'},signal)
    expect(noFrame.recoverable).toBe(true);expect(f.inputs).toBe(0)
    const stale=await runComputerTool(a,{action:'click',frame:'f1',ref:'e1'},signal)
    expect(stale.recoverable).toBe(true);expect(f.inputs).toBe(0)
    expect((await runComputerTool(a,{action:'click',ref:'e1'},signal)).inputExecuted).toBe(true)
    expect(f.inputs).toBe(1)
  })
})
