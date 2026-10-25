import {describe,it,expect,vi} from 'vitest'
import type {Content} from '@google/genai'
const f=vi.hoisted(()=>({run:vi.fn()}))
vi.mock('../../src/main/voice/desktopTools',()=>({AGENT_GUIDE:'',OPERATOR_GUIDE:'',BUILDER_GUIDE:''}))
vi.mock('../../src/main/voice/extraTools',()=>({ALL_TOOL_DECLARATIONS:[{name:'computer'},{name:'update_plan'}],runTool:f.run}))
import {TextAgent} from '../../src/main/voice/textAgent'
import type {ToolHost} from '../../src/main/voice/extraTools'
type MockTurn={content?:Content;functionCalls:{id:string;name:string;args:Record<string,unknown>}[];text:string}
function setup(generate:(contents:Content[])=>MockTurn) {
  const agent=new TextAgent(()=> 'test-key',{} as ToolHost,async()=>'',{info:vi.fn(),warn:vi.fn()} as never)
  vi.spyOn(agent as unknown as {generate(ai:unknown,contents:Content[]):Promise<MockTurn>},'generate').mockImplementation(async(_ai,contents)=>generate(contents))
  return agent
}
const call=(name:string,args:Record<string,unknown>,id='1'):MockTurn=>({content:{role:'model',parts:[{functionCall:{name,args,id}}]},functionCalls:[{name,args,id}],text:''})

describe('persistent general UI missions',()=>{
  it('continues beyond the old 80-turn limit with compacted context and verifies before finishing',async()=>{
    let turns=0,compacted=false
    f.run.mockImplementation(async(_host,_tool,args)=>({ok:true,inputExecuted:args.action!=='observe',frame:`f${turns}`,verified:turns===95,description:'Actual visible result'}))
    const agent=setup(contents=>{
      compacted ||= contents.some(t=>t.parts?.some(p=>p.text?.includes('CONTEXT CHECKPOINT')))
      if(turns===0){turns++;return call('select_workflow',{mode:'computer',needs_screen:true,reason:'Operate the existing UI'})}
      if(turns++<=94)return call('computer',{action:'click',frame:`f${turns-1}`,x:10,y:20},String(turns))
      return {functionCalls:[],text:'The requested result is verified.'}
    })
    const r=await agent.run('Computer task: complete this multi-step workflow',vi.fn())
    expect(r.ok).toBe(true);expect(f.run).toHaveBeenCalledTimes(95);expect(compacted).toBe(true)
  })
  it('does not call unfinished plan milestones complete just because the model stops',async()=>{
    let turns=0
    const agent=setup(()=>{
      if(turns++===0)return call('select_workflow',{mode:'research',needs_screen:false,reason:'Review information'})
      if(turns===2)return call('update_plan',{steps:[{title:'Inspect all requested items',status:'running'}]})
      return {functionCalls:[],text:'Done'}
    })
    const r=await agent.run('Review all requested items',vi.fn())
    expect(r.ok).toBe(false);expect(r.reply).toContain('Plan milestones remain incomplete')
  })
  it('passes ordered watch samples as actual images with timestamps, never base64 in tool JSON',async()=>{
    let turns=0
    f.run.mockImplementation(async(_host,_tool,args)=>args.action==='observe'?{ok:true,frame:'f1',image:'data:image/jpeg;base64,ZA=='}:{ok:true,frame:'f2',images:[{image:'data:image/jpeg;base64,YQ==',elapsedMs:0,capturedAt:1},{image:'data:image/jpeg;base64,Yg==',elapsedMs:1000,capturedAt:1001}],image:'data:image/jpeg;base64,Yw==',verified:true})
    const agent=setup(contents=>{
      if(turns++===0)return call('select_workflow',{mode:'computer',needs_screen:true,reason:'Inspect changing UI'})
      if(turns===2)return call('computer',{action:'watch',duration_ms:1000})
      const parts=contents.at(-1)?.parts??[]
      const response=parts.find(p=>p.functionResponse)?.functionResponse?.response
      expect(JSON.stringify(response)).not.toContain('base64')
      expect(parts.filter(p=>p.inlineData)).toHaveLength(3)
      expect(parts.some(p=>p.text?.includes('+1000 ms'))).toBe(true)
      return {functionCalls:[],text:'The visible changes were inspected.'}
    })
    expect((await agent.run('Computer task: observe the changing UI',vi.fn())).ok).toBe(true)
  })
  it('answers a general question without inspecting or changing the desktop',async()=>{
    f.run.mockClear();let turns=0
    const agent=setup(()=>turns++===0?call('select_workflow',{mode:'answer',needs_screen:false,reason:'No current app context needed'}):{functionCalls:[],text:'Here is the explanation.'})
    expect((await agent.run('Explain the concept',vi.fn())).ok).toBe(true)
    expect(f.run).not.toHaveBeenCalled()
  })
  it('inspects current app context before answering an on-screen question, without activating a control',async()=>{
    f.run.mockClear();f.run.mockResolvedValue({ok:true,frame:'f1',description:'The selected item is paused',image:'data:image/jpeg;base64,YQ=='})
    let turns=0
    const agent=setup(contents=>{
      if(turns++===0)return call('select_workflow',{mode:'answer',needs_screen:true,reason:'The question refers to the selected item in the current UI'})
      expect(contents.at(-1)?.parts?.some(p=>p.inlineData)).toBe(true)
      return {functionCalls:[],text:'The selected item is paused.'}
    })
    expect((await agent.run('Why is this paused?',vi.fn())).ok).toBe(true)
    expect(f.run).toHaveBeenCalledTimes(1);expect(f.run.mock.calls[0][2].action).toBe('observe')
  })
})
