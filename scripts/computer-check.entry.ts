import { app, BrowserWindow, screen, safeStorage } from 'electron'
import { writeFileSync, mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import assert from 'node:assert/strict'
import { pcControl } from '../src/main/tools/pcControl'
import { uia } from '../src/main/tools/uia'
import { computerController } from '../src/main/computer/controller'
import { captureScreen } from '../src/main/tools/screenVision'
import { desktopInput } from '../src/main/computer/inputQueue'
import { segmentDistance } from '../src/main/computer/paths'
import { getNutJs } from '../SWARM/electron/remote/desktop'
import {SecretStore} from '../src/main/desktop/secrets'
import {TextAgent} from '../src/main/voice/textAgent'
import type {ToolHost} from '../src/main/voice/extraTools'
import type {ShellLogger} from '../src/main/backendContext'
const output = process.env.ZVYRA_COMPUTER_CHECK_DIR!
// Keep Chromium's test profile isolated. DPAPI needs the existing encrypted
// OSCrypt key to read the app's saved provider credential; never copy plaintext.
const installedProfile = join(app.getPath('appData'), 'ZVYRA')
const testProfile = mkdtempSync(join(tmpdir(), 'zvyra-input-check-'))
const localState = join(installedProfile, 'Local State')
if (process.env.ZVYRA_LIVE_AGENT === '1' && existsSync(localState)) copyFileSync(localState, join(testProfile, 'Local State'))
app.setPath('userData', testProfile)
const results: Record<string, unknown> = { tests: [], platform: process.platform }
const tests = results.tests as { name: string; ok: boolean; details?: unknown; error?: string }[]
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (predicate: () => Promise<boolean>, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await wait(25) } throw new Error('Expected application state did not appear') }
let target: BrowserWindow | undefined
let previousHwnd = 0
async function main() {
await app.whenReady()
app.setAccessibilitySupportEnabled(true)
try {
  previousHwnd = (await pcControl.metrics()).hwnd
  target = new BrowserWindow({ x: 100, y: 100, width: 1000, height: 760, title: 'ZVYRA disposable input verification', alwaysOnTop: true, webPreferences: { backgroundThrottling: false } })
  await target.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:#fff"><button id="target" style="position:absolute;left:30px;top:20px;width:180px;height:50px">Verified target</button><input aria-label="Test text" id="text" style="position:absolute;left:250px;top:20px;width:300px;height:45px"><canvas id="c" width="950" height="600" style="position:absolute;left:20px;top:90px;background:#f9f9f9;touch-action:none"></canvas><script>
  window.events=[];window.paths=[];window.moves=[];window.clicks=0;window.lastButtons=0;document.onmousemove=e=>{lastButtons=e.buttons;moves.push({x:e.clientX,y:e.clientY})};target.onclick=()=>{window.clicks++;target.textContent='Clicked '+window.clicks};
  for(const t of ['mousedown','mouseup','dblclick','contextmenu','wheel','keydown'])document.addEventListener(t,e=>{events.push({type:t,key:e.key,button:e.button,buttons:e.buttons,ctrl:e.ctrlKey});if(t==='contextmenu')e.preventDefault()});
  const ctx=c.getContext('2d');ctx.lineWidth=3;ctx.strokeStyle='#1616db';let down=false;
  c.onpointerdown=e=>{down=true;c.setPointerCapture(e.pointerId);paths.push([{x:e.offsetX,y:e.offsetY}]);ctx.beginPath();ctx.moveTo(e.offsetX,e.offsetY)};
  c.onpointermove=e=>{if(down){paths.at(-1).push({x:e.offsetX,y:e.offsetY});ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke()}};
  c.onpointerup=e=>{if(down){paths.at(-1).push({x:e.offsetX,y:e.offsetY});ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke()}down=false};
  window.clearCanvas=()=>{ctx.clearRect(0,0,c.width,c.height);paths=[]};window.heartbeat=0;setInterval(()=>heartbeat++,10);
  </script></body></html>`))
  const hwnd = Number(target.getNativeWindowHandle().readBigUInt64LE())
  const focus = async () => { target!.show(); target!.focus(); await pcControl.show({hwnd,pid:0,process:'electron',title:'test',cls:'',minimized:false},'focus'); await until(async () => (await pcControl.metrics()).hwnd === hwnd,5000) }
  await focus()
  const js = <T>(code: string) => target!.webContents.executeJavaScript(code) as Promise<T>
  const point = async (selector: string) => { const r = await js<{x:number;y:number}>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); const b = target!.getContentBounds(); return screen.dipToScreenPoint({ x: b.x+r.x, y: b.y+r.y }) }
  const canvas = async (x: number, y: number) => { const r = await js<{x:number;y:number}>('({x:c.getBoundingClientRect().x,y:c.getBoundingClientRect().y})'); const b = target!.getContentBounds(); return screen.dipToScreenPoint({ x: b.x+r.x+x, y: b.y+r.y+y }) }
  const check = async (name: string, fn: () => Promise<unknown>) => { if(process.env.ZVYRA_LIVE_ONLY==='1'&&!name.startsWith('live AI'))return;if(process.env.ZVYRA_REAL_APP_ONLY==='1'&&!name.startsWith('real Windows'))return;if(process.env.ZVYRA_REAL_BROWSER_ONLY==='1'&&!name.startsWith('real browser'))return;try { await focus(); const details = await fn(); tests.push({name,ok:true,details}); console.log('PASS',name,JSON.stringify(details??{})) } catch(e) { tests.push({name,ok:false,error:String(e)}); console.error('FAIL',name,String(e)) } }
  await check('capture desktop, map a target in captured pixels, click and verify changed application', async () => {
    const o = await computerController.execute({action:'observe'},null,new AbortController().signal)
    const native = await point('#target'), display=screen.getAllDisplays().find(d=>d.id===o.displayId)!, dip=screen.screenToDipPoint(native)
    const x=(dip.x-display.bounds.x)*Number(o.width)/display.bounds.width, y=(dip.y-display.bounds.y)*Number(o.height)/display.bounds.height
    const r=await computerController.execute({action:'click',frame:o.frame,x,y},null,new AbortController().signal)
    await until(async()=>await js<number>('clicks')===1)
    assert.equal(r.inputExecuted,true);assert.equal(r.verified,false)
    assert.ok((r.observation as {frame:string}).frame!==o.frame)
    const shot=await captureScreen(display);writeFileSync(join(output,'desktop-after.jpg'),Buffer.from(shot.dataUrl.split(',')[1],'base64'))
    return {capture:[o.width,o.height],native,clicks:await js('clicks'),truthfulVerification:r.verified}
  })
  await check('double-click, right-click and wheel reach the real app',async()=>{
    const p=await point('#target');await pcControl.click(p.x,p.y,'left',2,hwnd);await pcControl.click(p.x,p.y,'right',1,hwnd);await pcControl.scroll(2,0,hwnd)
    await until(async()=>await js<boolean>(`events.some(e=>e.type==='dblclick')&&events.some(e=>e.type==='contextmenu')&&events.some(e=>e.type==='wheel')`))
    return await js('events.filter(e=>["dblclick","contextmenu","wheel"].includes(e.type))')
  })
  await check('Unicode text and Ctrl+A keyboard selection',async()=>{
    const p=await point('#text');await pcControl.click(p.x,p.y,'left',1,hwnd);await pcControl.text('Zvyra Ω नमस्ते',hwnd);await wait(100);assert.equal(await js<string>('document.getElementById("text").value'),'Zvyra Ω नमस्ते');await pcControl.keys('ctrl+a');await pcControl.text('replaced',hwnd);await wait(100);assert.equal(await js<string>('document.getElementById("text").value'),'replaced');return {value:await js('text.value')}
  })
  await check('UI Automation locates and invokes a named button',async()=>{
    const before=await js<number>('clicks');const tree=await uia.tree({hwnd,max:100});writeFileSync(join(output,'uia-tree.json'),JSON.stringify(tree,null,2));const button=tree.find(e=>e.type==='Button'&&e.name.startsWith('Clicked'));assert.ok(button);await uia.invoke({hwnd,name:'^'+button.name+'$'});await until(async()=>await js<number>('clicks')===before+1);return {method:'UIA',name:button.name}
  })
  await check('smooth real cursor reaches a semantic button before activation',async()=>{
    const start=await canvas(850,450);await pcControl.move(start.x,start.y);await js('moves=[]')
    const before=await js<number>('clicks'),beat=await js<number>('heartbeat'),signal=new AbortController().signal
    const o=await computerController.execute({action:'observe'},null,signal,true)
    const button=(o.controls as {ref:string;type:string;name:string}[]).find(e=>e.type==='Button'&&e.name.startsWith('Clicked'));assert.ok(button)
    const result=await computerController.execute({action:'click',frame:o.frame,ref:button.ref},null,signal,true)
    await until(async()=>await js<number>('clicks')===before+1)
    const cursor=(await pcControl.metrics()).cursor,destination=await point('#target'),moves=await js<{x:number;y:number}[]>('moves')
    const error=Math.hypot(cursor.x-destination.x,cursor.y-destination.y)
    assert.ok(moves.length>=8,'The actual app must receive intermediate OS mouse moves');assert.ok(error<=2);assert.ok(await js<number>('heartbeat')>beat+5)
    writeFileSync(join(output,'smooth-click.png'),(await target!.webContents.capturePage()).toPNG())
    return {motion:result.metrics,receivedMouseMoves:moves.length,endpointError:error,clickVerified:true}
  })
  await check('emergency stop interrupts smooth cursor motion before any click',async()=>{
    const start=await canvas(40,100),end=await canvas(850,500);await pcControl.move(start.x,start.y)
    const before=await js<number>('clicks'),controller=new AbortController()
    const motion=pcControl.smoothMove(end.x,end.y,hwnd,controller.signal),stopped=assert.rejects(motion)
    await wait(50);const t=Date.now();controller.abort();await stopped
    const latency=Date.now()-t,cursor=(await pcControl.metrics()).cursor
    assert.ok(latency<200);assert.ok(Math.hypot(cursor.x-end.x,cursor.y-end.y)>10);assert.equal(await js<number>('clicks'),before)
    return {stopLatencyMs:latency,noClick:true}
  })
  await check('window resize, minimize, restore and foreground switching',async()=>{
    const win={hwnd,pid:0,process:'electron',title:'test',cls:'',minimized:false}
    await pcControl.resize(hwnd,110,110,1000,760);await until(async()=>target!.getBounds().x===110)
    await pcControl.show(win,'minimize');await until(async()=>target!.isMinimized())
    await pcControl.show(win,'focus');await until(async()=>!target!.isMinimized()&&(await pcControl.metrics()).hwnd===hwnd)
    return {bounds:target!.getBounds(),foregroundVerified:true}
  })
  await check('unexpected dialog recovery through accessibility and fresh observations',async()=>{
    await js(`(()=>{const d=document.createElement('dialog');d.id='unexpected';const p=document.createElement('p');p.textContent='Disposable unexpected dialog';const b=document.createElement('button');b.textContent='Dismiss unexpected dialog';b.onclick=()=>d.close();d.append(p,b);document.body.append(d);d.showModal()})()`)
    const o=await computerController.execute({action:'observe'},null,new AbortController().signal)
    try {await computerController.execute({action:'click',name:'Dismiss unexpected dialog',frame:o.frame},null,new AbortController().signal)}
    catch(error){
      writeFileSync(join(output,'dialog-diagnostics.json'),JSON.stringify({controls:o.controls,foreground:o.foreground},null,2))
      const shot=await captureScreen();writeFileSync(join(output,'dialog-failure.jpg'),Buffer.from(shot.dataUrl.split(',')[1],'base64'))
      await js('unexpected.close()');throw error
    }
    assert.equal(await js<boolean>('unexpected.open'),false)
    await assert.rejects(computerController.execute({action:'click',name:'Dismiss unexpected dialog',frame:o.frame},null,new AbortController().signal),/stale/)
    return {dialogClosed:true,duplicateFrameRejected:true}
  })
  for(const shape of ['line','circle','spiral','irregular','separate']) await check('native drawing '+shape,async()=>{
    await js('clearCanvas()')
    const local=shape==='line'?[{x:40,y:40},{x:700,y:40}]:Array.from({length:361},(_,i)=>{const t=i/360*Math.PI*(shape==='spiral'?6:2),r=shape==='spiral'?20+i/3:shape==='irregular'?100+30*Math.sin(5*t):100;return {x:350+Math.cos(t)*r,y:260+Math.sin(t)*r}})
    const strokes=[await Promise.all(local.map(p=>canvas(p.x,p.y)))];if(shape==='separate')strokes.push([await canvas(100,450),await canvas(700,480)])
    let mainTicks=0;const tick=setInterval(()=>mainTicks++,10)
    const beat=await js<number>('heartbeat');let metrics:Awaited<ReturnType<typeof pcControl.draw>>
    try { metrics=await pcControl.draw(strokes,{hwnd,speed:2400,hz:125}) } finally {clearInterval(tick)}
    await wait(100)
    const received=await js<{x:number;y:number}[][]>('paths');assert.equal(received.length,strokes.length);assert.ok(received[0].length>5);assert.ok(metrics.endpointError<=2);assert.ok(await js<number>('heartbeat')>beat+5)
    const deviation=Math.max(...received[0].map(p=>Math.min(...local.slice(1).map((b,i)=>segmentDistance(p,local[i],b)))))
    assert.ok(deviation<=2.5,`Observed path deviation ${deviation}px`);assert.ok(mainTicks>5)
    writeFileSync(join(output,shape+'.png'),(await target!.webContents.capturePage()).toPNG())
    return {...metrics,maxObservedDeviation:deviation,appSamples:received.map(s=>s.length),mainTicks,uiTicks:(await js<number>('heartbeat'))-beat}
  })
  await check('interrupt active stroke, release button and cancel queued input',async()=>{
    await js('events=[]');const start=await canvas(100,100),end=await canvas(850,500),ctrl=new AbortController();const t=Date.now()
    const stroke=desktopInput.run(s=>pcControl.draw([[start,end]],{hwnd,speed:100,signal:s}),ctrl.signal)
    // Attach the assertion before cancellation so Node never sees an unhandled
    // rejection while the stop cleanup is awaiting the native helper.
    const stopped=assert.rejects(stroke)
    const next=desktopInput.run(async()=>{throw new Error('Queued input ran after emergency stop')})
    const rejected=next.catch(e=>String(e));await wait(170);desktopInput.stop();pcControl.stop();await stopped;assert.match(await rejected,/stopped/)
    const p=await canvas(500,50);await pcControl.move(p.x,p.y);await wait(50)
    const events=await js<{type:string;buttons?:number}[]>('events');assert.ok(events.some(e=>e.type==='mouseup'));assert.equal(await js<number>('lastButtons'),0);return {stopLatencyMs:Date.now()-t-170,buttonReleased:true}
  })
  await check('approval-style focus change restores the named editor without typing into the other app',async()=>{
    const o=await computerController.execute({action:'observe'},null,new AbortController().signal)
    const editor=(o.controls as {ref:string;name:string}[]).find(e=>e.name==='Test text');assert.ok(editor,'The actual editor must have an observed accessibility ref')
    const other=new BrowserWindow({width:300,height:200,alwaysOnTop:true});await other.loadURL('data:text/html,<h1>Disposable focus target</h1>');other.focus();await wait(100)
    try{const r=await computerController.execute({action:'type',frame:o.frame,ref:editor.ref,text:' recovered'},null,new AbortController().signal);assert.equal(r.inputExecuted,true);await until(async()=>(await js<string>('text.value')).endsWith(' recovered'));assert.equal(await other.webContents.executeJavaScript('document.body.innerText'),'Disposable focus target')}finally{other.destroy()}
    return {targetFocusRecovered:true,otherAppUnchanged:true}
  })
  await check('lost focus interrupts an active stroke and releases input',async()=>{
    const other=new BrowserWindow({width:300,height:200,show:false,alwaysOnTop:true});await other.loadURL('data:text/html,<h1>Disposable focus interrupt</h1>');await focus()
    const drawing=pcControl.draw([[await canvas(40,100),await canvas(850,500)]],{hwnd,speed:100})
    const rejected=assert.rejects(drawing,/Foreground window changed/);await wait(150);other.show();other.focus()
    try{await rejected}finally{other.destroy()}
    await focus();await pcControl.move(...Object.values(await canvas(50,40)) as [number,number]);await wait(30);assert.equal(await js<number>('lastButtons'),0)
    return {interrupted:true,buttonReleased:true}
  })
  await check('existing nut-js drag baseline on the same disposable canvas',async()=>{
    const nut=await getNutJs(),a=await canvas(40,550),b=await canvas(850,550);const t=Date.now();await nut.mouse.setPosition(new nut.Point(a.x,a.y));try{await nut.mouse.pressButton(nut.Button.LEFT);for(let i=1;i<=100;i++)await nut.mouse.setPosition(new nut.Point(a.x+(b.x-a.x)*i/100,a.y))}finally{await nut.mouse.releaseButton(nut.Button.LEFT)}return {elapsedMs:Date.now()-t,points:100,note:'Existing waypoint injection baseline; not an earlier freeform drawing implementation'}
  })
  if(process.env.ZVYRA_REAL_APP_ONLY==='1')await check('real Windows Notepad: locate editor, physically click, type Unicode and verify the saved file',async()=>{
    const file=join(testProfile,`ZVYRA-mouse-${Date.now()}.txt`),name=basename(file)
    writeFileSync(file,'Disposable ZVYRA input check.');target!.setAlwaysOnTop(false);target!.hide()
    let win:Awaited<ReturnType<typeof pcControl.windows>>[number]|undefined
    try {
      const child=spawn('notepad.exe',[file],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{})
      await until(async()=>{win=(await pcControl.windows()).find(w=>w.title.includes(name.replace(/\.txt$/,'')));return !!win},20000)
      await pcControl.show(win!,'focus');await until(async()=>(await pcControl.metrics()).hwnd===win!.hwnd,5000)
      const signal=new AbortController().signal,o=await computerController.execute({action:'observe'},null,signal,true)
      const editor=(o.controls as {ref:string;type:string;enabled:boolean}[]).find(e=>e.type==='Document'&&e.enabled);assert.ok(editor,'Notepad must expose its actual editor')
      let r=await computerController.execute({action:'click',frame:o.frame,ref:editor.ref},null,signal,true)
      r=await computerController.execute({action:'keys',frame:(r.observation as {frame:string}).frame,keys:'ctrl+a'},null,signal,true)
      const expected='ZVYRA physically clicked this real Notepad editor. Ω नमस्ते'
      r=await computerController.execute({action:'type',frame:(r.observation as {frame:string}).frame,text:expected},null,signal,true)
      await computerController.execute({action:'keys',frame:(r.observation as {frame:string}).frame,keys:'ctrl+s'},null,signal,true)
      await until(async()=>readFileSync(file,'utf8').replace(/^\uFEFF/,'')===expected,5000)
      const shot=await captureScreen();writeFileSync(join(output,'notepad-real-after.jpg'),Buffer.from(shot.dataUrl.split(',')[1],'base64'))
      return {app:win!.process,physicalClick:true,savedContentVerified:true,unicodeVerified:true}
    } catch(error) {
      writeFileSync(join(output,'notepad-diagnostics.json'),JSON.stringify({windows:(await pcControl.windows()).filter(w=>/notepad/i.test(w.process)),foreground:await uia.foreground().catch(()=>null)},null,2))
      const shot=await captureScreen();writeFileSync(join(output,'notepad-failure.jpg'),Buffer.from(shot.dataUrl.split(',')[1],'base64'))
      throw error
    } finally {
      if(win){await pcControl.show(win,'focus');await pcControl.keys('ctrl+s',1,win.hwnd).catch(()=>undefined);await pcControl.keys('ctrl+w',1,win.hwnd).catch(()=>undefined)}
      target!.show();target!.setAlwaysOnTop(true)
    }
  })
  if(process.env.ZVYRA_REAL_BROWSER_ONLY==='1')await check('real browser receives trusted mouse moves and physical button events',async()=>{
    const {chromium}=await import('playwright-core')
    const exe=[join(process.env.ProgramFiles??'C:/Program Files','BraveSoftware/Brave-Browser/Application/brave.exe'),join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')].find(existsSync)
    assert.ok(exe,'An installed Brave or Edge is required')
    target!.setAlwaysOnTop(false);target!.hide()
    const browser=await chromium.launchPersistentContext(join(testProfile,'browser'),{executablePath:exe,headless:false,args:['--force-renderer-accessibility','--no-first-run'],viewport:null})
    try {
      const page=browser.pages()[0]??await browser.newPage(),title=`ZVYRA real mouse ${Date.now()}`
      await page.setContent(`<title>${title}</title><body style="font:24px Segoe UI;padding:100px"><h1>Real browser input check</h1><button id="action" style="padding:30px;font-size:24px">Activate local check</button><h2 id="result">Waiting for a physical click</h2><script>window.proof={moves:0,downs:0,ups:0,clicks:0,trusted:false};document.onmousemove=e=>{if(e.isTrusted)proof.moves++};action.onmousedown=e=>{if(e.isTrusted)proof.downs++};action.onmouseup=e=>{if(e.isTrusted)proof.ups++};action.onclick=e=>{proof.trusted=e.isTrusted;proof.clicks++;result.textContent='Physical click verified'}</script>`)
      let win:Awaited<ReturnType<typeof pcControl.windows>>[number]|undefined
      await until(async()=>{win=(await pcControl.windows()).find(w=>w.title.includes(title));return !!win},10000)
      await pcControl.show(win!,'focus');await until(async()=>(await pcControl.metrics()).hwnd===win!.hwnd,5000)
      const fg=await uia.foreground();assert.ok(fg.rect);await pcControl.move(fg.rect.x+fg.rect.w-40,fg.rect.y+fg.rect.h-40)
      const signal=new AbortController().signal,o=await computerController.execute({action:'observe'},null,signal,true)
      const button=(o.controls as {ref:string;name:string}[]).find(e=>e.name==='Activate local check');assert.ok(button,'The real browser button must be resolved through accessibility')
      const r=await computerController.execute({action:'click',frame:o.frame,ref:button.ref},null,signal,true)
      await page.waitForFunction('proof.clicks===1')
      const proof=await page.evaluate('proof') as {moves:number;downs:number;ups:number;clicks:number;trusted:boolean}
      writeFileSync(join(output,'real-browser-result.json'),JSON.stringify({app:win!.process,proof,motion:r.metrics},null,2))
      assert.equal(proof.downs,1);assert.equal(proof.ups,1);assert.equal(proof.clicks,1);assert.equal(proof.trusted,true);assert.ok(proof.moves>=5)
      await page.screenshot({path:join(output,'real-browser-click.png')})
      writeFileSync(join(output,'real-browser-result.json'),JSON.stringify({app:win!.process,proof,motion:r.metrics},null,2))
      return {app:win!.process,proof,motion:r.metrics}
    }finally{await browser.close();target!.show();target!.setAlwaysOnTop(true)}
  })
  const smoke=process.env.ZVYRA_SCREEN_SMOKE==='1'
  if(process.env.ZVYRA_LIVE_AGENT==='1')await check(smoke?'live AI identifies ORION, moves the actual mouse, clicks and verifies the changed screen':'live AI analyzes the real screen, performs a multi-step review and verifies the result',async()=>{
    const secrets=new SecretStore(installedProfile)
    const key=secrets.get('gemini.apiKey')
    assert.ok(key,`A configured Gemini key is required for the live AI check (appData=${app.getPath('appData')}, stored=${secrets.has('gemini.apiKey')}, encryption=${safeStorage.isEncryptionAvailable()})`)
    target!.setTitle('ZVYRA screen task challenge');target!.maximize()
    await target!.loadURL('data:text/html,'+encodeURIComponent(`<!doctype html><html lang="en"><title>ZVYRA screen task challenge</title><body style="font:20px Segoe UI;margin:50px;background:#edf3fa;color:#172b4d"><h1>Local release review</h1><p>This is a disposable local workspace.</p><nav><button id="orion">Open ORION</button> <button id="luna">Open LUNA</button></nav><h2 id="project">Choose a project</h2><button id="review" disabled>Review tab</button><section id="panel" hidden><p><label>Release note <input id="note" style="width:600px;font-size:20px"></label></p><p><label>Priority <select id="priority" style="font-size:20px"><option>Low</option><option>Normal</option><option>High</option></select></label></p><p><label><input type="checkbox" id="reviewed"> Screenshots reviewed</label></p><button id="details">Open Details</button><button id="apply">Apply local review</button></section><dialog id="dialog"><h2>Review details</h2><label>Review code <input id="code"></label><button id="keep">Keep details</button></dialog><h2 id="result">No review applied</h2><pre id="receipt"></pre><script>
    window.challenge={project:'',note:'',priority:'Low',reviewed:false,code:'',applied:false};
    for(const id of ['orion','luna'])document.getElementById(id).onclick=()=>{challenge.project=id.toUpperCase();project.textContent=challenge.project+' project';review.disabled=false};
    review.onclick=()=>panel.hidden=false;details.onclick=()=>dialog.showModal();keep.onclick=()=>{challenge.code=code.value;dialog.close()};
    apply.onclick=()=>{challenge.note=note.value;challenge.priority=priority.value;challenge.reviewed=reviewed.checked;challenge.applied=challenge.project==='ORION'&&challenge.note==='Ready for QA – Ω नमस्ते'&&challenge.priority==='High'&&challenge.reviewed&&challenge.code==='ORION-42';result.textContent=challenge.applied?'Review complete ORION-42':'Review incomplete';receipt.textContent=JSON.stringify(challenge,null,2)};
    </script></body></html>`))
    await focus()
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    writeFileSync(join(output,'model-before.png'),(await target!.webContents.capturePage()).toPNG())
    const activity:{label:string;status:string}[]=[],progress:string[]=[]
    const logger:ShellLogger={debug:()=>{},warn:(scope,message,data)=>console.log('AI warning',scope,message,String(data?.message??'').replaceAll(key,'[redacted]')),error:()=>{},info:(scope,message,data)=>{if(scope==='agent')console.log('AI',message,JSON.stringify({model:data?.model,ms:data?.ms,ok:data?.ok,error:data?.error}))}}
    // This test host exposes the real computer executor only. No fake tool
    // responses, browser DOM actions or precomputed agent action sequence.
    const host={geminiKey:()=>key,computerEnabled:async()=>true,toolActivity:(a:{label:string;status:string})=>{activity.push({label:a.label,status:a.status});console.log('ACTION',a.status,a.label)},requestApproval:async()=>{throw new Error('Unexpected consequential action in the disposable local review')},status:async()=>({test:'local review'})} as unknown as ToolHost
    const agent=new TextAgent(()=>key,host,async()=> 'The active window is ZVYRA screen task challenge, a disposable local test application. Computer Control is enabled.',logger)
    let answer:Awaited<ReturnType<TextAgent['run']>>|undefined
    try{answer=await agent.run(smoke?'Computer task: Analyze the actual open screen. Identify the button named Open ORION, use computer click to activate it, and then use computer observe(expected) to verify the visible heading changed to ORION project. Explain briefly which element you clicked and the observed change. Use the actual visible UI and screenshots only.': 'Computer task: Analyze the actual open screen and carry out this local review through its visible UI. Choose ORION (not LUNA), open the Review tab, enter exactly Ready for QA – Ω नमस्ते in Release note, set Priority to High, check Screenshots reviewed, open Details, enter ORION-42 as the Review code and keep the details. Apply the local review. Use repeated real computer tool actions and inspect their screenshots; do not use source code, terminal commands, DOM scripting or shortcuts that skip the UI. Make ONE computer action per model turn. Finally use computer observe with expected to independently verify that Review complete ORION-42 and the correct note are visible. Finish the entire task without asking me to perform routine clicks.',u=>{if(u.action)progress.push(u.action)},AbortSignal.timeout((smoke?4:10)*60*1000))}
    finally{
      writeFileSync(join(output,'model-task.json'),JSON.stringify({answer,actual:await js('challenge'),activity,progress},null,2))
      writeFileSync(join(output,'model-final.png'),(await target!.webContents.capturePage()).toPNG())
    }
    const actual=await js<Record<string,unknown>>('challenge')
    const completed=activity.filter(a=>a.status==='done')
    assert.ok(answer)
    if(smoke){assert.equal(actual.project,'ORION');assert.ok(completed.some(a=>a.label==='Computer: click'));assert.ok(completed.length>=3)}
    else {assert.equal(actual.applied,true,JSON.stringify(actual));assert.equal(actual.note,'Ready for QA – Ω नमस्ते');assert.equal(actual.code,'ORION-42');assert.ok(completed.length>=8,'The model must actually use repeated computer actions')}
    assert.equal(answer.ok,true,answer.reply)
    return {actual,computerCalls:completed.length,reply:answer.reply}
  })
  results.displays=screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,scale:d.scaleFactor}))
} catch(e) {
  results.fatal=String(e)
  results.foreground=await uia.foreground().catch(()=>null)
  results.metrics=await pcControl.metrics().catch(()=>null)
  console.error('FATAL',String(e),JSON.stringify(results.foreground),JSON.stringify(results.metrics))
  const shot=await captureScreen().catch(()=>null)
  if(shot)writeFileSync(join(output,'failure-desktop.jpg'),Buffer.from(shot.dataUrl.split(',')[1],'base64'))
}
finally {
  target?.destroy();computerController.stop();uia.dispose();
  if(previousHwnd)await pcControl.show({hwnd:previousHwnd,pid:0,process:'',title:'',cls:'',minimized:false},'focus').catch(()=>undefined)
  pcControl.dispose();writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2));
  app.on('quit',()=>{try{
    const resolved=resolve(testProfile)
    if(dirname(resolved)!==resolve(tmpdir())||!basename(resolved).startsWith('zvyra-input-check-'))throw new Error('Unexpected test profile cleanup path')
    rmSync(resolved,{recursive:true,force:true})
  }catch{ /* Chromium may still be releasing its temporary profile. */ }})
  app.exit(tests.some(t=>!t.ok)||results.fatal?1:0)
}
}
void main()
