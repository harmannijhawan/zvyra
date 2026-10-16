import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from '../shared/types';
import { defaultSettings } from '../shared/settings';
const fixture = vi.hoisted(() => ({ chat: vi.fn(), models: [] as ModelInfo[], search: vi.fn(), success: vi.fn(), failure: vi.fn(), revision: 0, create: vi.fn(), start: vi.fn(), computer: vi.fn() }));
vi.mock('electron', () => ({ Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../electron/providers/registry', () => ({ getRegistryRevision: () => fixture.revision++, listModels: () => fixture.models, usable: () => true, adapter: () => ({ kind: 'local', chat: fixture.chat }), providerConfig: () => ({}), recordSuccess: fixture.success, recordFailure: fixture.failure }));
vi.mock('../electron/account/sync',()=>({managedRequest:async(path:string,body:any,signal:AbortSignal)=>{
  if(path!=='managed/complete')return {ok:true};
  const result=await fixture.chat({},'managed-model',{...body,signal,onToken:()=>{}});
  return {result,model:{id:'managed-model',displayName:'Managed fixture',contextLength:32000,capabilities:['chat','coding','vision']}};
}}));
vi.mock('../electron/research/search', () => ({ webSearch: fixture.search }));
vi.mock('../electron/core/settings', () => ({ getSettings: () => defaultSettings() }));
vi.mock('../electron/projects/projects', () => ({ createProject: fixture.create, listProjects: () => [], getProject: () => null }));
vi.mock('../electron/agents/orchestrator', () => ({ activeRun: () => null, startRun: fixture.start, runSnapshot: () => null, pauseRun: vi.fn(), resumeRun: vi.fn(), cancelRun: vi.fn(), controlAgent: vi.fn() }));
vi.mock('../electron/computer/service', async importOriginal => ({ ...await importOriginal<typeof import('../electron/computer/service')>(), pcControl: { execute: fixture.computer } }));
import { initDb } from '../electron/core/db';
import { newChat, sendChat, getChat, listChats, renameChat, deleteChat, stopChat } from '../electron/chat/service';
import { chatPurpose, ChatRouter } from '../electron/chat/router';
import { ProviderError } from '../electron/providers/types';
import { resolveTarget } from '../electron/core/target';
import { classifyIntent } from '../electron/core/intent';
const result = (text: string) => ({ text, promptTokens: 20, completionTokens: 10, finishReason: 'stop', latencyMs: 10, ttftMs: 2, usageEstimated: false });
async function finished(id: string) { await vi.waitFor(() => expect(getChat(id).turns.at(-1)?.status).not.toBe('streaming'), { timeout: 8000 }); return getChat(id); }
beforeEach(() => {
  initDb(path.join(mkdtempSync(path.join(tmpdir(), 'swarm-chat-')), 'test.db'));
  fixture.chat.mockReset(); fixture.success.mockReset(); fixture.failure.mockReset(); fixture.search.mockReset();
  fixture.create.mockReset().mockReturnValue({ id: 'project-real', name: 'Requested project' }); fixture.start.mockReset().mockReturnValue({ id: 'run-real' }); fixture.computer.mockReset();
  fixture.models = ['a','b'].map(id => ({id,providerId:'ollama',modelId:id,displayName:id,capabilities:['chat','fast','coding','reasoning'],contextLength:32000,maxOutput:4096,paramsB:8,calls:0,successes:0,consecutiveFailures:0,health:'healthy',enabled:true} as ModelInfo));
  fixture.chat.mockImplementation(async (_cfg,_model,req) => { req.onToken?.('Hello'); return result('Hello'); });
});
describe('Chat service and real shared router', () => {
  it('opens Chrome through the shared PC service without model planning', async () => {
    fixture.computer.mockResolvedValue({ text: 'Actual observation', activeWindow: 'New Tab - Google Chrome', preview: 'actual-preview' });
    const c = newChat(); sendChat({ id: c.id, text: 'Open Chrome.' }); const done = await finished(c.id);
    expect(fixture.chat).not.toHaveBeenCalled(); expect(fixture.computer).toHaveBeenCalledOnce();
    expect(fixture.computer.mock.calls[0][0]).toMatchObject({ action: 'open_application', application: 'chrome' });
    expect(done.turns.at(-1)).toMatchObject({ status: 'complete', text: expect.stringContaining('Launched Chrome') });
    expect(done.turns.at(-1)?.activities?.[0]).toMatchObject({ tool: 'computer.open_application', status: 'complete', preview: 'actual-preview' });
  });
  it('reports PC permission failures immediately without alternate command attempts', async () => {
    fixture.computer.mockRejectedValue(new Error('Native interaction is disabled'));
    const c = newChat(); sendChat({ id: c.id, text: 'Open Chrome' }); const done = await finished(c.id);
    expect(fixture.chat).not.toHaveBeenCalled(); expect(fixture.computer).toHaveBeenCalledOnce();
    expect(done.turns.at(-1)).toMatchObject({ status: 'error', error: 'Native interaction is disabled' });
  });
  it('cancels a direct PC action without planning retries', async () => {
    fixture.computer.mockImplementation((_action, _scope, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')))));
    const c = newChat(); sendChat({ id: c.id, text: 'Open Chrome' }); await vi.waitFor(() => expect(fixture.computer).toHaveBeenCalled()); stopChat(c.id);
    expect((await finished(c.id)).turns.at(-1)?.status).toBe('stopped'); expect(fixture.chat).not.toHaveBeenCalled();
  });
  it('greetings use a model, persist history, and create no projects/runs/commands', async () => {
    const c=newChat();sendChat({id:c.id,text:'hi'});const done=await finished(c.id);
    expect(done.turns.at(-1)?.text).toBe('Hello');expect(fixture.chat).toHaveBeenCalledOnce();expect(fixture.search).not.toHaveBeenCalled();
    const { db }=await import('../electron/core/db');for(const table of ['projects','runs','tasks','commands','sources'])expect(db().list(table)).toEqual([]);
    sendChat({id:c.id,text:'What about useEffect?'});await finished(c.id);
    const msgs=fixture.chat.mock.calls[1][2].messages;expect(msgs.map((m:any)=>m.content)).toContain('hi');expect(msgs.map((m:any)=>m.content)).toContain('Hello');
  });
  it.each(['timeout','rate_limit','server'] as const)('recovers from a transient %s with one bounded retry or fallback and discards partial output', async kind => {
    fixture.chat.mockImplementationOnce(async (_c,_m,req)=>{req.onToken?.('BROKEN');throw new ProviderError(kind,'fixture failure');});
    const c=newChat();sendChat({id:c.id,text:'hi'});const done=await finished(c.id);
    expect(done.turns.at(-1)?.status).toBe('complete');expect(done.turns.at(-1)?.text).not.toContain('BROKEN');expect(done.turns.at(-1)?.text).toBe('Hello');
    // timeout/server: one retry on the same model; rate_limit without a short Retry-After: switch to the next model.
    expect(fixture.chat).toHaveBeenCalledTimes(2);
    const models=fixture.chat.mock.calls.map(c=>c[1]);
    if(kind==='rate_limit')expect(models[0]).not.toBe(models[1]);else expect(models[0]).toBe(models[1]);
  });
  it('all-model failure stays a chat error',async()=>{
    fixture.chat.mockRejectedValue(new ProviderError('server','unavailable'));
    const c=newChat();sendChat({id:c.id,text:'Explain a closure'});const done=await finished(c.id);
    expect(done.turns.at(-1)?.status).toBe('error');expect(done.turns.at(-1)?.model).toBeUndefined();expect(fixture.success).not.toHaveBeenCalled();
    expect(fixture.chat).toHaveBeenCalledTimes(4); // two models, one bounded retry each — never an unbounded loop
  });
  it('research uses search evidence without a project',async()=>{
    fixture.search.mockResolvedValue({results:[{url:'https://example.com',title:'Source',snippet:'Evidence'}],errors:[]});
    const c=newChat();sendChat({id:c.id,text:'Research Nxteraa'});await finished(c.id);
    expect(fixture.search).toHaveBeenCalledOnce();expect(fixture.chat.mock.calls[0][2].messages.at(-1).content).toContain('https://example.com');
  });
  it('includes attachments on followups, edits branch history, and supports CRUD',async()=>{
    const c=newChat();sendChat({id:c.id,text:'Explain this file',attachments:[{name:'code.py',text:'answer = 42'}]});await finished(c.id);
    sendChat({id:c.id,text:'What is answer?'});await finished(c.id);expect(JSON.stringify(fixture.chat.mock.calls[1][2].messages)).toContain('answer = 42');
    sendChat({id:c.id,text:'Corrected question',retryFrom:getChat(c.id).turns[0].id});await finished(c.id);expect(getChat(c.id).turns).toHaveLength(2);
    renameChat(c.id,'Saved discussion');expect(listChats()[0].title).toBe('Saved discussion');deleteChat(c.id);expect(listChats()).toEqual([]);
  });
  it('cancels without fallback',async()=>{
    fixture.chat.mockImplementation((_c,_m,req)=>new Promise((_resolve,reject)=>{req.signal.addEventListener('abort',()=>reject(new ProviderError('cancelled','stopped')));}));
    const c=newChat();sendChat({id:c.id,text:'hi'});await vi.waitFor(()=>expect(fixture.chat).toHaveBeenCalled());stopChat(c.id);expect((await finished(c.id)).turns.at(-1)?.status).toBe('stopped');expect(fixture.chat).toHaveBeenCalledOnce();
  });
  it('starts work from natural conversation through the existing action protocol and retains run context',async()=>{
    fixture.chat.mockImplementationOnce(async (_c,_m,req)=> { const text='I will start your calculator. <swarm>{"action":"build","platform":"windows","objective":"a calculator"}</swarm>'; req.onToken?.(text); return result(text); });
    const c=newChat();sendChat({id:c.id,text:'can you make me a Windows calculator?'});const done=await finished(c.id);
    expect(done.turns.at(-1)?.activities?.[0], JSON.stringify(done.turns.at(-1))).toMatchObject({status:'complete'});
    expect(fixture.create).toHaveBeenCalledWith({ objective: 'a calculator' });
    expect(fixture.start).toHaveBeenCalledWith('project-real', expect.stringContaining('windows'), expect.any(Object));
    expect(done.runId).toBe('run-real'); expect(done.projectId).toBe('project-real');
    expect(done.turns.at(-1)?.activities?.[0]).toMatchObject({ tool:'swarm.build',status:'complete' });
    expect(done.turns.at(-1)?.text).not.toContain('<swarm>');
    sendChat({id:c.id,text:'fix it'});await finished(c.id);
    expect(fixture.chat.mock.calls.at(-1)?.[2].messages[0].content).toContain('run-real');
  });
  it('feeds an actual screenshot observation into the next model request and publishes compact activity',async()=>{
    fixture.models.forEach(m => m.capabilities.push('vision'));
    fixture.computer.mockResolvedValue({text:'Observed desktop',image:'data:image/jpeg;base64,dGVzdA==',preview:'data:image/jpeg;base64,dGVzdA=='});
    fixture.chat.mockImplementationOnce(async (_c,_m,req)=>{ const text='I will check your PC. <computer>{"action":"screenshot"}</computer>'; req.onToken?.(text); return result(text); });
    const {bus}=await import('../electron/core/bus'); const updated=vi.fn(); bus.on('chat:turn',updated);
    const c=newChat();sendChat({id:c.id,text:'can you check the PC?'});const done=await finished(c.id);
    expect(fixture.computer).toHaveBeenCalledOnce();
    expect(fixture.chat.mock.calls[1][2].messages.at(-1).content).toEqual(expect.arrayContaining([expect.objectContaining({type:'image'})]));
    expect(done.turns.at(-1)?.activities?.[0].status).toBe('complete');
    expect(done.turns.at(-1)?.text).not.toContain('screenshot"'); expect(updated).toHaveBeenCalled();bus.off('chat:turn',updated);
  });
  it('reports a tool failure without claiming success',async()=>{
    fixture.computer.mockRejectedValue(new Error('Native interaction is disabled'));
    fixture.chat.mockImplementationOnce(async()=>result('<computer>{"action":"screenshot"}</computer>'));
    const c=newChat();sendChat({id:c.id,text:'check PC'});const done=await finished(c.id);
    expect(done.turns.at(-1)?.activities?.[0]).toMatchObject({status:'error',detail:'Native interaction is disabled'});
    expect(done.turns.at(-1)).toMatchObject({ status: 'error', error: 'Native interaction is disabled' });
    expect(fixture.chat).not.toHaveBeenCalled();
  });
  it('selects routing purposes for fast chat, coding, reasoning and research',()=>{
    expect(chatPurpose('hi')).toBe('classify');expect(chatPurpose('debug Python code')).toBe('code');expect(chatPurpose('distributed architecture tradeoffs')).toBe('architecture');expect(chatPurpose('research latest Android APIs')).toBe('research');
  });
  it('bounds long history and reports omitted context',async()=>{
    fixture.models.forEach(m=>m.contextLength=8192);
    const r=await new ChatRouter().respond([{role:'system',content:'Help'},{role:'user',content:'old '.repeat(10000)},{role:'assistant',content:'old response'},{role:'user',content:'new question'}],'new question',new AbortController().signal,()=>{},()=>{});
    expect(r.omitted).toBe(2);expect(fixture.chat.mock.calls[0][2].messages.at(-1).content).toBe('new question');
  });
});
describe('mode and target boundary',()=>{
  it.each(['hi','hello','what is SWARM?','explain quantum computing','help me fix this Python error','write a JavaScript function','research the latest Android development tools','I am thinking about the best way to explain a complex recursive algorithm to a beginner.'])('keeps %s out of execution',text=>expect(classifyIntent(text,false).shouldStartRun).toBe(false));
  it.each([['build a website','web'],['build me a Windows calculator','windows'],['make an Android app','android'],['create a CLI tool','cli'],['build an Android React Native app','android'],['build a Windows app using React','windows'],['create a backend service','backend'],['create an API service','api'],['create a library','library']])('resolves %s to %s',(text,target)=>expect(resolveTarget(text)).toBe(target));
  it.each(['Research Nxteraa','hi','build an app'])('rejects execution without an appropriate explicit target: %s',text=>expect(()=>resolveTarget(text)).toThrow());
});
