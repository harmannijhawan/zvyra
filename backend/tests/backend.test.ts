import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const fixture = vi.hoisted(()=>({root:'',ipc: new Map<string,Function>()}));
vi.mock('electron',()=>({
  app:{getPath:()=>fixture.root,getAppPath:()=>path.resolve('..'),setLoginItemSettings:vi.fn()},
  Notification:{isSupported:()=>false},BrowserWindow:{getAllWindows:()=>[],fromWebContents:(contents:any)=>contents.id===1?{}:null},
  powerMonitor:{on:vi.fn(),removeListener:vi.fn()},
  safeStorage:{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from('encrypted:'+s),decryptString:(b:Buffer)=>b.toString().slice(10)},
  ipcMain:{handle:(name:string,fn:Function)=>fixture.ipc.set(name,fn),removeHandler:(name:string)=>fixture.ipc.delete(name)},
  screen:{},nativeImage:{},shell:{},dialog:{},
}));
import { createUiBackend } from '../src/ui';
import { VoiceService } from '../src/voice';
import { db } from '../../SWARM/electron/core/db';
import { getSettings, updateSettings } from '../../SWARM/electron/core/settings';
import { Store } from '../src/store';
import { loadRegistry, discoverProvider } from '../../SWARM/electron/providers/registry';
import { setSecret } from '../../SWARM/electron/core/secrets';
import { registerContractIpc, isTrustedSender } from '../../src/main/ipc';
import { needsComputerApproval, PcAction } from '../../SWARM/electron/computer/service';
import { schemas } from '../src/contract';
import type { ZvyraBackend, ZvyraEvent } from '../../src/shared/contract';
let backend:ZvyraBackend;
const events:ZvyraEvent[]=[];
let server:http.Server;
beforeAll(async()=>{
  fixture.root=fs.mkdtempSync(path.join(os.tmpdir(),'zvyra-test-'));
  vi.spyOn(VoiceService.prototype,'probe').mockImplementation(async function(this:VoiceService){this.capabilities={recognizers:['en-GB'],microphone:'system-default',tts:true};return this.snapshot();});
  backend=await createUiBackend({userDataPath:fixture.root,appVersion:'test',isPackaged:false,resourcesPath:fixture.root,getFocusedWindow:()=>null,logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}});
  backend.subscribe(e=>events.push(e));
});
afterAll(async()=>{await backend.dispose?.();if(server)await new Promise<void>(r=>server.close(()=>r()));db().close();});
describe('real UI facade and SQLite',()=>{
  it('boots with actual backend and reports absent providers honestly',async()=>{
    expect((await backend.invoke('system.info',undefined)).backend).toBe('SWARM embedded');
    expect((await backend.invoke('swarm.connection',undefined)).status).toBe('disconnected');
    expect((await backend.invoke('calls.status',undefined)).configured).toBe(false);
  });
  it('rejects unknown operations and unsafe filesystem input',async()=>{
    await expect(backend.invoke('terminal.run',{command:'echo no'})).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
    await expect(backend.invoke('projects.create',{name:'x',path:'C:\\Windows'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(backend.invoke('chat.create',{title:7} as any)).rejects.toMatchObject({code:'INVALID_ARGS'});
    await expect(backend.invoke('settings.update',{constructor:{bad:true}} as any)).rejects.toMatchObject({code:'INVALID_ARGS'});
  });
  it('persists conversation edits and emits removable subscriptions',async()=>{
    const listener=vi.fn(),off=backend.subscribe(listener);
    const c=await backend.invoke('chat.create',{title:'one'});
    await backend.invoke('chat.rename',{id:c.id,title:'two'});
    expect((await backend.invoke('chat.list',{})).find(x=>x.id===c.id)?.title).toBe('two');
    expect(listener).toHaveBeenCalled();off();listener.mockClear();
    await backend.invoke('chat.delete',{id:c.id});expect(listener).not.toHaveBeenCalled();
  });
  it('stores, updates, deletes memory and enforces disabled storage',async()=>{
    const m=await backend.invoke('memory.create',{kind:'note',title:'Remember',content:'hello',tags:[]});
    await backend.invoke('memory.update',{id:m.id,content:'updated'});
    expect((await backend.invoke('memory.list',{query:'updated'}))[0].id).toBe(m.id);
    await backend.invoke('memory.setSettings',{enabled:false});
    await expect(backend.invoke('memory.create',{kind:'note',title:'No',content:'no',tags:[]})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await backend.invoke('memory.setSettings',{enabled:true});
    await backend.invoke('memory.delete',{id:m.id});expect(await backend.invoke('memory.list',{})).toEqual([]);
  });
  it('does not reset unrelated preferences during partial updates',async()=>{
    await backend.invoke('notifications.setPolicy',{doNotDisturb:true});
    await backend.invoke('memory.setSettings',{enabled:false});
    expect((await backend.invoke('notifications.policy',undefined)).doNotDisturb).toBe(true);
    await backend.invoke('memory.setSettings',{enabled:true});
  });
  it('recovers ambiguous scheduled dispatch without executing again',()=>{
    const store=new Store();store.put('automation',{id:'uncertain',state:'dispatching',projectId:'none',at:1,instruction:'do work'});
    const restarted=new Store();expect(restarted.list<any>('automation').find(a=>a.id==='uncertain').state).toBe('needs_review');
  });
  it('retains all migration data when initialized repeatedly',()=>{
    const store=new Store();store.memory({id:'m',text:'persisted'});const reopened=new Store();expect(reopened.list<any>('memory').find(m=>m.id==='m').text).toBe('persisted');
  });
  it('validates unsupported schedules and missing models',async()=>{
    await expect(backend.invoke('automations.create',{name:'x',instruction:'x',enabled:true,schedule:{type:'interval',everyMinutes:10}})).rejects.toMatchObject({code:'INVALID_ARGS'});
    await expect(backend.invoke('chat.create',{model:'imaginary'})).rejects.toMatchObject({code:'INVALID_ARGS'});
  });
});
describe('security boundaries',()=>{
  it('requires approval even when keyboard actions claim normal risk',()=>{
    expect(needsComputerApproval(PcAction.parse({action:'type',text:'dangerous',risk:'normal'}))).toBe(true);
    expect(needsComputerApproval(PcAction.parse({action:'screenshot'}))).toBe(false);
    expect(schemas['computer.execute'].safeParse({id:'a',action:{action:'shell',command:'whoami'}}).success).toBe(false);
  });
  it('accepts only exact main frames from owned windows',async()=>{
    const previous=process.env.ELECTRON_RENDERER_URL;process.env.ELECTRON_RENDERER_URL='http://localhost:5173';
    const frame={url:'http://localhost:5173/index.html'};const sender={id:1,mainFrame:frame};
    expect(isTrustedSender({sender,senderFrame:frame} as any)).toBe(true);
    expect(isTrustedSender({sender,senderFrame:{...frame}} as any)).toBe(false);
    frame.url='http://localhost:5173.evil.test/index.html';expect(isTrustedSender({sender,senderFrame:frame} as any)).toBe(false);
    const invoke=vi.fn();registerContractIpc(()=>({invoke} as any),{error:vi.fn()} as any);
    const result=await fixture.ipc.get('zvyra:invoke')!({sender:{id:2},senderFrame:{url:'https://bad'}},'system.info');
    expect(result.error.code).toBe('PERMISSION_DENIED');expect(invoke).not.toHaveBeenCalled();fixture.ipc.clear();
    if(previous===undefined)delete process.env.ELECTRON_RENDERER_URL;else process.env.ELECTRON_RENDERER_URL=previous;
  });
});
describe('actual SWARM adapter against a controlled HTTP provider',()=>{
  it('discovers real returned IDs, streams and persists a response',async()=>{
    server=http.createServer((req,res)=>{
      if(req.url==='/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'llama-3.3-70b-versatile',context_window:32768}]}));return;}
      if(req.url==='/chat/completions'){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'Hello from the controlled SWARM provider'}}]})+'\n\n');
        res.end('data: [DONE]\n\n');return;
      }res.writeHead(404);res.end();
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as any).port;
    setSecret('groq','test-only-credential');updateSettings({providers:{baseUrls:{groq:`http://127.0.0.1:${port}`},enabled:{groq:true}},ai:{maxOutputTokens:1024}});loadRegistry();
    await discoverProvider('groq');
    const models=await backend.invoke('models.list',{});expect(models.some(m=>m.id==='groq::llama-3.3-70b-versatile')).toBe(true);
    const c=await backend.invoke('chat.create',{});
    const initial=await backend.invoke('chat.send',{conversationId:c.id,text:'Hello'});
    expect(initial.status).toBe('streaming');
    await vi.waitFor(async()=>{const messages=await backend.invoke('chat.messages',{id:c.id});expect(messages.at(-1)?.status).toBe('complete');expect(messages.at(-1)?.content).toContain('controlled SWARM');},{timeout:5000});
    expect(events.some(e=>e.type==='chat.message'&&e.payload.status==='complete')).toBe(true);
    expect(getSettings().providers.baseUrls.groq).toContain(String(port));
  });
});
