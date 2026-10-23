import {afterEach,describe,it,expect,vi} from 'vitest'
const f=vi.hoisted(()=>({run:vi.fn(),stop:vi.fn(),queueStop:vi.fn()}))
vi.mock('electron',()=>({BrowserWindow:class{},ipcMain:{on:vi.fn(),removeListener:vi.fn()}}))
vi.mock('../../src/main/voice/extraTools',()=>({ALL_TOOL_DECLARATIONS:[],runTool:f.run}))
vi.mock('../../src/main/computer/controller',()=>({computerController:{stop:f.stop}}))
vi.mock('../../src/main/computer/inputQueue',()=>({desktopInput:{stop:f.queueStop}}))
import {VoiceEngine,type VoiceEngineDeps} from '../../src/main/voice/engine'
function setup(){
  const session={close:vi.fn(),sendToolResponse:vi.fn(),sendRealtimeInput:vi.fn()}
  const engine=new VoiceEngine({getKey:()=>null,getConfig:()=>({wakeEnabled:false,model:'test',voice:'Charon',idleTimeoutSec:60,stayAwake:true}),logger:{info:vi.fn(),warn:vi.fn()},emit:vi.fn(),tools:{host:{}},activity:vi.fn()} as unknown as VoiceEngineDeps)
  const runtime=engine as unknown as {session:typeof session;phase:string;onToolCall(calls:unknown[]):Promise<void>}
  runtime.session=session;runtime.phase='listening'
  return {engine,runtime,session}
}
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers()})
describe('voice computer executor integration',()=>{
  it('closes the live session and drops input after three failed clicks',async()=>{
    vi.useFakeTimers();f.run.mockResolvedValue({ok:false,error:'Observe again with a fresh frame before input'})
    const {engine,runtime,session}=setup()
    try{
      for(let i=0;i<3;i++)await runtime.onToolCall([{id:String(i),name:'computer',args:{action:'click',frame:'f1',ref:'e1'}}])
      expect(f.run).toHaveBeenCalledTimes(3);expect(session.sendToolResponse).toHaveBeenCalledTimes(2)
      expect(session.close).toHaveBeenCalledOnce();expect(f.stop).toHaveBeenCalledOnce();expect(f.queueStop).toHaveBeenCalledOnce()
      expect(engine.status().error).toMatch(/three failed actions/)
    }finally{engine.dispose()}
  })
  it('sends actual screenshots as Live video and keeps the frame token in the tool response',async()=>{
    vi.useFakeTimers();f.run.mockResolvedValue({ok:true,image:'data:image/jpeg;base64,YQ==',frame:'f2',verified:false})
    const {engine,runtime,session}=setup()
    try{
      await runtime.onToolCall([{id:'1',name:'computer',args:{action:'observe'}}])
      expect(f.run.mock.calls[0][0]).toMatchObject({computerSnapshots:true})
      expect(session.sendRealtimeInput).toHaveBeenCalledWith({video:{mimeType:'image/jpeg',data:'YQ=='}})
      expect(session.sendToolResponse.mock.calls[0][0].functionResponses[0].response).toEqual({ok:true,frame:'f2',verified:false})
    }finally{engine.dispose()}
  })
})
