import {beforeEach,describe,expect,it,vi} from 'vitest'
const f=vi.hoisted(()=>({hwnd:42,pixels:10,fg:{hwnd:42,pid:7,process:'notepad',title:'Disposable note',rect:{x:10,y:10,w:800,h:600}},display:{id:1,bounds:{x:0,y:0,width:1920,height:1080},size:{width:1920,height:1080},scaleFactor:1},controls:[{name:'Editor',type:'Document',runtimeId:'1.4.7',enabled:true,rect:{x:40,y:80,w:600,h:400}}]}))
vi.mock('electron',()=>({screen:{getAllDisplays:()=>[f.display],getDisplayNearestPoint:()=>f.display,screenToDipPoint:(p:unknown)=>p,dipToScreenPoint:(p:unknown)=>p},nativeImage:{createFromDataURL:()=>({crop(){return this},resize(){return this},toBitmap:()=>Buffer.alloc(64000,f.pixels)})}}))
vi.mock('../../src/main/tools/screenVision',()=>({captureScreen:vi.fn(async()=>({dataUrl:'data:image/jpeg;base64,YQ==',display:f.display,width:1920,height:1080,capturedAt:Date.now()})),describeScreen:vi.fn(async()=>'screen'),verifyScreen:vi.fn(async()=>({verified:true,description:'confirmed'}))}))
vi.mock('../../src/main/tools/pcControl',()=>({pcControl:{metrics:vi.fn(async()=>({hwnd:f.hwnd,x:0,y:0,width:1920,height:1080})),windows:vi.fn(async()=>[{hwnd:42,pid:7,title:'Disposable note',process:'notepad'}]),show:vi.fn(async()=>{f.hwnd=42}),smoothMove:vi.fn(async()=>({samples:20})),keys:vi.fn(async()=>true),text:vi.fn(async()=>true),click:vi.fn(async()=>true),scroll:vi.fn(async()=>true),stop:vi.fn()}}))
vi.mock('../../src/main/tools/uia',()=>({exactName:(s:string)=>`^${s}$`,uia:{foreground:vi.fn(async()=>({...f.fg,hwnd:f.hwnd})),tree:vi.fn(async()=>f.controls),resolve:vi.fn(async()=>f.controls[0]),checkPoint:vi.fn(async()=>true),focusControl:vi.fn(async()=>true),invoke:vi.fn(async()=>true)}}))
const {ComputerController}=await import('../../src/main/computer/controller')
const {pcControl}=await import('../../src/main/tools/pcControl')
const {uia}=await import('../../src/main/tools/uia')
const {desktopInput}=await import('../../src/main/computer/inputQueue')
const {captureScreen}=await import('../../src/main/tools/screenVision')
describe('desktop task focus and actual screenshot contract',()=>{
  beforeEach(()=>{f.hwnd=42;f.pixels=10;vi.clearAllMocks()})
  it('starts independent screen reads together while still validating focus',async()=>{
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const original=await captureScreen()
    vi.mocked(captureScreen).mockImplementationOnce(async()=>{await gate;return original})
    const c=new ComputerController()
    const pending=c.execute({action:'observe'},null,new AbortController().signal,true)
    try {
      await vi.waitFor(()=>expect(uia.tree).toHaveBeenCalled())
      expect(pcControl.windows).toHaveBeenCalled()
      // A focus change during overlapping reads must invalidate this attempt.
      f.hwnd=99
    } finally {release()}
    const result=await pending
    expect(result.foreground).toMatchObject({hwnd:99})
    expect(uia.tree).toHaveBeenCalledTimes(2)
  })
  it('passes the actual image and stable refs through observations',async()=>{
    const c=new ComputerController(),o=await c.execute({action:'observe'},null,new AbortController().signal,true)
    expect(o.image).toBe('data:image/jpeg;base64,YQ==');expect(o.controls).toMatchObject([{ref:'e1',name:'Editor'}]);expect(o.frame).toMatch(/^f\d+$/)
    const result=await c.execute({action:'type',frame:o.frame,ref:'e1',text:'two\nlines'},null,new AbortController().signal,true)
    expect(uia.focusControl).toHaveBeenCalledWith(expect.objectContaining({hwnd:42,runtimeId:'1.4.7'}));expect(pcControl.text).toHaveBeenCalledWith('two\nlines',42,expect.any(AbortSignal));expect(result.inputExecuted).toBe(true);expect(result.image).toBeTruthy();expect(result.frame).toBe((result.observation as {frame:string}).frame);expect(result.frame).not.toBe(o.frame)
  })
  it('recovers focus stolen by an approval card and reacquires the semantic target',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    f.hwnd=99;f.pixels=210
    const r=await c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)
    expect(pcControl.show).toHaveBeenCalled();expect(uia.resolve).toHaveBeenCalledWith(expect.objectContaining({hwnd:42,runtimeId:'1.4.7'}));expect(pcControl.click).toHaveBeenCalledWith(340,280,'left',1,42);expect(r.inputExecuted).toBe(true)
  })
  it('restores a visually unchanged coordinate target but rejects changed pixels',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    f.hwnd=99
    await c.execute({action:'click',frame:o.frame,x:200,y:100},null,signal,true)
    const fresh=await c.execute({action:'observe'},null,signal,true);f.hwnd=99;f.pixels=220
    await expect(c.execute({action:'click',frame:fresh.frame,x:200,y:100},null,signal,true)).rejects.toThrow(/content moved/)
    expect(pcControl.click).toHaveBeenCalledTimes(1)
  })
  it('invalidates tokens when another tool changes the desktop',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true);desktopInput.invalidate()
    await expect(c.execute({action:'keys',frame:o.frame,keys:'ctrl+a'},null,signal,true)).rejects.toThrow(/stale/);expect(pcControl.keys).not.toHaveBeenCalled()
  })
  it('binds shortcuts to the observed HWND',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    await c.execute({action:'keys',frame:o.frame,keys:'ctrl+s'},null,signal,true);expect(pcControl.keys).toHaveBeenCalledWith('ctrl+s',1,42)
  })
  it('moves the real cursor before activating semantic targets and supports right-click refs',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    await c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)
    expect(pcControl.smoothMove).toHaveBeenCalledWith(340,280,42,signal)
    expect(vi.mocked(pcControl.smoothMove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(pcControl.click).mock.invocationCallOrder[0]);expect(uia.invoke).not.toHaveBeenCalled()
    const next=await c.execute({action:'observe'},null,signal,true)
    await c.execute({action:'right_click',frame:next.frame,ref:'e1'},null,signal,true)
    expect(pcControl.click).toHaveBeenCalledWith(340,280,'right',1,42)
  })
  it('does not click when a control moves out from under the animated cursor',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    vi.mocked(uia.resolve).mockResolvedValueOnce(f.controls[0]).mockResolvedValueOnce({...f.controls[0],rect:{x:900,y:800,w:30,h:30}})
    await expect(c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)).rejects.toThrow(/moved/)
    expect(uia.invoke).not.toHaveBeenCalled();expect(pcControl.click).not.toHaveBeenCalled()
  })
  it('recaptures a focus change during capture without failing the action',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal
    vi.mocked(uia.tree).mockImplementationOnce(async()=>{f.hwnd=99;return f.controls})
    const o=await c.execute({action:'observe'},null,signal,true)
    expect(captureScreen).toHaveBeenCalledTimes(2);expect(o.foreground).toMatchObject({hwnd:99});expect(o.ok).toBe(true)
  })
  it('keeps an executed click receipt when the following screenshot fails',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    vi.mocked(captureScreen).mockRejectedValueOnce(new Error('Capture temporarily unavailable'))
    await expect(c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)).rejects.toMatchObject({inputExecuted:true,recoverable:true})
    expect(pcControl.click).toHaveBeenCalledTimes(1);expect(c.actions()[0].status).toBe('executed')
    await expect(c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)).rejects.toThrow(/stale/)
  })
  it('uses the accessible exposed point and refuses raw clicks covered by a window',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    vi.mocked(uia.resolve).mockResolvedValueOnce({...f.controls[0],clickablePoint:{x:80,y:120}})
    await c.execute({action:'click',frame:o.frame,ref:'e1'},null,signal,true)
    expect(pcControl.click).toHaveBeenCalledWith(80,120,'left',1,42)
    const next=await c.execute({action:'observe'},null,signal,true)
    vi.mocked(uia.checkPoint).mockRejectedValueOnce(new Error('Target is covered by another window; observe again'))
    await expect(c.execute({action:'click',frame:next.frame,x:100,y:100},null,signal,true)).rejects.toMatchObject({inputExecuted:false,recoverable:true})
    expect(pcControl.click).toHaveBeenCalledTimes(1)
  })
  it('scrolls the requested region after moving the pointer there',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    await c.execute({action:'scroll',frame:o.frame,x:500,y:600,deltaY:3},null,signal,true)
    expect(pcControl.smoothMove).toHaveBeenCalledWith(500,600,42,signal);expect(pcControl.scroll).toHaveBeenCalledWith(3,0,42)
    expect(vi.mocked(pcControl.smoothMove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(pcControl.scroll).mock.invocationCallOrder[0])
  })
  it('physically focuses an editor when its accessibility SetFocus provider refuses',async()=>{
    const c=new ComputerController(),signal=new AbortController().signal,o=await c.execute({action:'observe'},null,signal,true)
    vi.mocked(uia.focusControl).mockRejectedValueOnce(new Error('Element does not support focus'))
    const result=await c.execute({action:'type',frame:o.frame,ref:'e1',text:'Visible editor input'},null,signal,true)
    expect(result.inputExecuted).toBe(true)
    expect(pcControl.click).toHaveBeenCalledWith(340,280,'left',1,42)
    expect(pcControl.text).toHaveBeenCalledWith('Visible editor input',42,signal)
    expect(vi.mocked(pcControl.click).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(pcControl.text).mock.invocationCallOrder[0])
  })
})
