import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dialog, app } from 'electron';
import { z } from 'zod';
import { startBackend, type Backend } from './index';
import { ZvyraError, CONTRACT_VERSION, type ZvyraBackend, type ZvyraEvent, type MethodName, type MethodArgs, type MethodResult } from '../../src/shared/contract';
import type * as UI from '../../src/shared/contract/types';
import type { BackendContext } from '../../src/main/backendContext';
import { DEFAULT_SETTINGS, DEFAULT_ROUTING, DEFAULT_NOTIFICATION_POLICY, deepMerge } from '../../src/shared/defaults';
import { db } from '../../SWARM/electron/core/db';
import { getSettings, updateSettings } from '../../SWARM/electron/core/settings';
import { getChat, listChats, newChat, renameChat, deleteChat, sendChat, stopChat, stopAllChats } from '../../SWARM/electron/chat/service';
import { getProject, listProjects, listRuns, createProject, updateProject, saveProject } from '../../SWARM/electron/projects/projects';
import { listActiveRuns, runSnapshot, startRun, cancelAll, controlAgent } from '../../SWARM/electron/agents/orchestrator';
import { listApprovals, resolveApproval } from '../../SWARM/electron/tools/approvals';
import { listModels, listProviders, usable, BYOK_PROVIDER_IDS } from '../../SWARM/electron/providers/registry';
import { queryEvents } from '../../SWARM/electron/core/bus';
import { ROLES } from '../../SWARM/electron/agents/roles';
import { redact } from '../../SWARM/electron/core/util';
import { clearNotifications, listNotifications, notify } from '../../SWARM/electron/core/notify';
import type { Run, AgentRole, SwarmEvent, ApprovalRequest } from '../../SWARM/shared/types';
import type { Conversation, ChatTurn } from '../../SWARM/shared/chat';
import type { Automation } from './store';
import * as map from './ui-mapping';
import { pcControl } from '../../SWARM/electron/computer/service';

const id = z.string().min(1).max(128), text = z.string().trim().min(1).max(100000);
const obj = z.object({}).strict();
const idArg = z.object({id}).strict();
const limit = z.number().int().min(1).max(1000).optional();
const source = z.enum(['voice','island','home','chat','automation','api']);
const memorySchema = z.object({kind:z.enum(['preference','fact','note','task_context','project']),title:z.string().min(1).max(200),content:z.string().max(10000),tags:z.array(z.string().max(100)).max(30),projectId:id.optional(),pinned:z.boolean().optional()}).strict();

/** Implements the existing UI contract; no renderer changes or alternate UI protocol. */
export async function createUiBackend(ctx: BackendContext): Promise<ZvyraBackend> {
  const listeners = new Set<(event: ZvyraEvent) => void>();
  const emit = (event: ZvyraEvent) => { for (const listener of listeners) { try { listener(event); } catch { ctx.logger.warn('backend','Event subscriber failed'); } } };
  let backend: Backend;
  let previousApprovals = new Set<string>();
  // PowerShell can't read inside app.asar: use the unpacked copy in installed builds.
  const script = (fs.existsSync(path.join(__dirname,'speech.ps1')) ? path.join(__dirname,'speech.ps1') : path.join(app.getAppPath(),'backend','src','speech.ps1')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const interactions = new Map<string,UI.Interaction>();
  backend = await startBackend({dataDirectory:ctx.userDataPath,speechScript:script,publish(event) {
    const p = event.payload as any;
    if (event.topic === 'chat:updated') emit({type:'chat.conversation',payload:map.conversation(p as Conversation)});
    if (event.topic === 'chat:turn') {
      emit({type:'chat.message',payload:map.message(p.conversationId,p.turn as ChatTurn)});
      const interaction = [...interactions.values()].find(i => i.conversationId === p.conversationId && ['pending','streaming'].includes(i.status));
      if (interaction && p.turn.role === 'assistant') { interaction.response=p.turn.text; interaction.status=p.turn.status==='complete'?'done':p.turn.status==='error'?'error':p.turn.status==='stopped'?'cancelled':'streaming'; interaction.updatedAt=map.iso(Date.now()); interaction.error=p.turn.error; saveInteraction(interaction); emit({type:'assistant.interaction',payload:interaction}); }
    }
    if (event.topic === 'run:updated') { const r = p.run ?? p; if (r.id && r.objective) emit({type:'task.upsert',payload:map.task(r)}); }
    if (event.topic === 'events') for (const e of p as SwarmEvent[]) { emit({type:'activity.new',payload:map.activity(e)}); if (e.runId) { emit({type:'task.event',payload:{id:e.id,taskId:e.runId,ts:map.iso(e.ts),kind:e.level==='error'?'error':e.type.includes('TOOL')?'tool_result':'status',message:e.message,data:e.data}}); const r=runSnapshot(e.runId); if(r) emit({type:'task.upsert',payload:map.task(r.run)}); } }
    if (event.topic === 'approvals:changed') { const current = new Set<string>((p as ApprovalRequest[]).map(a=>a.id)); for (const a of p as ApprovalRequest[]) if(!previousApprovals.has(a.id)) emit({type:'permission.requested',payload:map.permission(a)}); for(const id of previousApprovals) if(!current.has(id)) emit({type:'permission.resolved',payload:{id,decision:'expired'}}); previousApprovals=current; }
    if (event.topic === 'notification') emit({type:'notification.new',payload:map.notification(p)});
    if (event.topic === 'voice.state' && backend) emit({type:'voice.status',payload:voice()});
    if (event.topic === 'computer:activity' && backend) emit({type:'computer.status',payload:{...computer(),phase:p.controlling?'executing':'idle'}});
    if (event.topic === 'voice.transcript') emit({type:'voice.transcript',payload:{text:p.text,final:true}});
    if (event.topic === 'models:changed' && backend) emit({type:'swarm.connection',payload:connection()});
    if (event.topic === 'automation.changed') emit({type:'automation.upsert',payload:automation(p)});
  }});
  const read = <T>(key:string, fallback:T):T => JSON.parse(db().kvGet(`zvyra.ui.${key}`) ?? JSON.stringify(fallback));
  const write = <T>(key:string,value:T) => {db().kvSet(`zvyra.ui.${key}`,JSON.stringify(value));return value;};
  function saveInteraction(i:UI.Interaction) { interactions.set(i.id,i); backend.service.store.put('interaction',i); }
  for(const i of backend.service.store.list<UI.Interaction>('interaction')) { if(['pending','streaming'].includes(i.status)){i.status='cancelled';i.error='Interrupted by application exit';} interactions.set(i.id,i); }
  async function call(op: Parameters<Backend['invoke']>[0],input: any = {}) {
    const result=await backend.invoke(op,input);
    if(!result.ok) throw new ZvyraError(result.error.code==='INVALID_INPUT'?'INVALID_ARGS':result.error.code==='no_provider'?'NOT_CONFIGURED':'BACKEND_ERROR',redact(result.error.message));
    return result.data as any;
  }
  function ensureModel(model?:string|null) { if(model&&!listModels().some(m=>m.id===model)) throw new ZvyraError('INVALID_ARGS','Discover models before selecting this model'); }
  function settings() { return read('settings',DEFAULT_SETTINGS); }
  const VOICE_IS_MAC = process.platform==='darwin';
  const VOICE_ENGINE_NAME = VOICE_IS_MAC ? 'macOS Speech (say)' : 'Windows System.Speech';
  function voice():UI.VoiceStatus {
    const v=backend.service.voice.snapshot(), ready=!!v.capabilities?.recognizers.includes(v.settings.language);
    const setup=VOICE_IS_MAC?'Allow microphone access for ZVYRA in System Settings → Privacy & Security':'Install the Windows desktop speech language and allow microphone access';
    // Engine ids stay stable (`windows-*`) across platforms so the contract/renderer and the
    // testEngine enum are unchanged; only the user-visible name/setup text is platform-correct.
    const engine=(kind:string,available:boolean):UI.VoiceEngineStatus=>({id:`windows-${kind}`,name:VOICE_ENGINE_NAME,processing:'local',ready:available,setupRequired:available?undefined:setup});
    return {state:v.state==='disabled'||v.state==='planning'?'off':v.state==='wake_word_detected'?'wake_detected':v.state,wakeWordEnabled:v.settings.wakeWord,wakePhrase:'Hey Zvyra',wake:engine('wake',ready),stt:engine('stt',ready),tts:engine('tts',!!v.capabilities?.tts),micAvailable:['standby','listening'].includes(v.state),micDeviceId:'system-default',error:v.error ?? undefined};
  }
  function connection():UI.SwarmConnection {
    const providers=listProviders().filter(p=>p.id!=='managed'); const selected=read('provider','swarm://embedded/openrouter').split('/').at(-1); const last=read<{status:string;checkedAt:number}|null>('providerTest.'+selected,null); const connected=providers.some(p=>p.id===selected && p.configured && (p.health==='healthy' || last?.status==='connected' && Date.now()-last.checkedAt<300000));
    return {status:connected?'connected':'disconnected',baseUrl:read('provider','swarm://embedded/openrouter'),hasApiKey:providers.some(p=>p.configured),lastCheckedAt:providers.some(p=>p.lastDiscoveryAt)?map.iso(Math.max(...providers.map(p=>p.lastDiscoveryAt??0))):undefined,error:connected?undefined:'Embedded SWARM: connect a BYOK provider and test it',account:providers.map(p=>({label:p.name,value:`${p.configured?'configured':'needs key'}; ${p.health}`})),endpointPresets:providers.map(p=>({value:`swarm://embedded/${p.id}`,label:p.name,configured:p.configured}))};
  }
  function taskById(id:string) { const snapshot=runSnapshot(id); if(!snapshot)throw new ZvyraError('NOT_FOUND','Task not found');return map.task(snapshot.run); }
  function agents():UI.AgentInfo[] {const s=getSettings();return Object.values(ROLES).map(r=>{const assignments=listActiveRuns().filter(run=>runSnapshot(run.id)?.agents.some(a=>a.role===r.role&&a.status==='working'));return {id:r.role,name:r.name,role:r.role,description:r.description,tools:r.tools,enabled:s.agents.enabled[r.role]!==false,state:s.agents.enabled[r.role]===false?'disabled':assignments.length?'running':'idle',activeTaskIds:assignments.map(a=>a.id),model:s.agents.modelPreference[r.role]??undefined};});}
  function automation(a:Automation):UI.Automation { return {id:a.id,name:read(`automationName.${a.id}`,a.instruction.slice(0,60)),instruction:a.instruction,schedule:{type:'once',at:map.iso(a.at)},enabled:a.state==='scheduled',projectId:a.projectId,createdAt:read(`automationCreated.${a.id}`,map.iso(a.at)),nextRunAt:a.state==='scheduled'?map.iso(a.at):undefined,lastTaskId:a.runId,lastResult:a.error,lastStatus:a.runId?taskById(a.runId).status:a.state==='failed'?'failed':undefined}; }
  const selectedFolders = new Set<string>();
  const handlers: Record<string,{schema:z.ZodType;run:(p:any)=>unknown}> = {};
  function add<K extends MethodName>(name:K,schema:z.ZodType,run:(p:any)=>MethodResult<K>|Promise<MethodResult<K>>) {handlers[name]={schema,run};}
  add('system.info',obj,()=>({contractVersion:CONTRACT_VERSION,backend:'SWARM embedded',backendVersion:'1.0.6 + ZVYRA 0.1',appVersion:ctx.appVersion,platform:process.platform,dataPath:ctx.userDataPath,capabilities:{chat:true,chatStreaming:true,tasks:true,taskPause:true,agents:true,projects:true,memory:true,automations:true,notifications:true,diagnostics:true,voice:voice().stt.ready,wakeWord:voice().wake.ready,computerControl:process.platform==='win32'||process.platform==='darwin',files:false,terminal:false,browser:false,apps:false}}));
  add('system.diagnostics',obj,()=>[{id:'sqlite',label:'SQLite',status:'ok',detail:'Persistent database initialized'},{id:'swarm',label:'SWARM providers',status:connection().status==='connected'?'ok':'warning',detail:connection().error,fixRoute:'settings/swarm'},{id:'voice',label:VOICE_IS_MAC?'macOS speech':'Windows speech',status:voice().stt.ready?'ok':'warning',detail:voice().stt.setupRequired}]);
  add('system.stopAll',obj,async()=>{const count=listActiveRuns().length;cancelAll();stopAllChats();await pcControl.releaseInput();backend.service.close();return {cancelledTasks:count};});
  add('system.logs',z.object({limit,level:z.enum(['debug','info','warn','error']).optional(),query:z.string().max(500).optional()}),p=>queryEvents({limit:p.limit??200}).filter(e=>!p.query||e.message.includes(p.query)).map(e=>({ts:map.iso(e.ts),level:e.level==='warning'?'warn':e.level==='success'?'info':e.level,scope:e.type,message:redact(e.message)})));
  add('settings.get',obj,settings);
  add('settings.update',z.record(z.string(),z.unknown()),p=>{
    // Validate against the persisted settings shape; unknown keys and type changes are rejected.
    const validate=(base:any,patch:any,depth=0)=>{if(depth>5||!patch||typeof patch!=='object'||Array.isArray(patch))throw new ZvyraError('INVALID_ARGS','Invalid settings patch');for(const [key,value] of Object.entries(patch)){if(!Object.hasOwn(base,key)||['__proto__','constructor','prototype'].includes(key))throw new ZvyraError('INVALID_ARGS','Unknown settings field');if(base[key]!==null&&typeof base[key]==='object')validate(base[key],value,depth+1);else if(base[key]!==null&&typeof value!==typeof base[key])throw new ZvyraError('INVALID_ARGS','Invalid settings type');}};
    validate(DEFAULT_SETTINGS,p);const next=deepMerge(settings(),p);if(next.background.maxConcurrentTasks<1||next.background.maxConcurrentTasks>16||next.appearance.uiScale<0.75||next.appearance.uiScale>2)throw new ZvyraError('INVALID_ARGS','Settings value out of range');
    if(p.voice)throw new ZvyraError('NOT_IMPLEMENTED','Use voice engine controls; custom rates, thresholds and microphone IDs are not implemented');
    if(p.startup)app.setLoginItemSettings({openAtLogin:next.startup.openAtLogin});
    updateSettings({agents:{maxConcurrent:next.background.maxConcurrentTasks}});write('settings',next);emit({type:'settings.changed',payload:next});return next;
  });
  add('voice.status',obj,voice);
  add('voice.setWakeWord',z.object({enabled:z.boolean()}),async p=>{await call('voice.configure',{enabled:true,wakeWord:p.enabled});return voice();});
  add('voice.startListening',z.object({source}),async()=>{await call('voice.configure',{enabled:true});await call('voice.start');return voice();});
  add('voice.cancel',obj,async()=>{await call('voice.stop');return voice();});
  add('voice.stopListening',obj,async()=>{await call('voice.finish');return voice();});
  add('voice.configureEngine',z.object({engineId:z.enum(['windows-wake','windows-stt','windows-tts']),values:z.object({language:z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),speakReplies:z.boolean().optional()}).strict()}),async p=>{await call('voice.configure',p.values);return handlers['voice.engines'].run({}) as UI.VoiceEngineOption[];});
  add('voice.speak',z.object({text:text.max(10000)}),async p=>{await call('voice.speak',p);});
  add('voice.stopSpeaking',obj,async()=>{await call('voice.stopPlayback');});
  add('voice.devices',obj,()=>[{id:'system-default',label:`${VOICE_IS_MAC?'macOS':'Windows'} default input (availability checked when listening starts)`,isDefault:true}]);
  add('voice.selectDevice',z.object({deviceId:z.literal('system-default').nullable()}),()=>voice());
  add('voice.engines',obj,()=>['wake','stt','tts'].map(kind=>({id:`windows-${kind}`,kind:kind as 'wake'|'stt'|'tts',name:VOICE_ENGINE_NAME,processing:'local',description:VOICE_IS_MAC?'Local macOS speech. Uses the system microphone and the built-in say voice. No audio files are saved.':'Local desktop speech. Uses Windows default microphone. No audio files are saved.',installed:kind==='tts'?voice().tts.ready:voice().stt.ready,fields:[]})));
  add('voice.testEngine',z.object({engineId:z.enum(['windows-wake','windows-stt','windows-tts'])}),async p=>{await backend.service.voice.probe();const ok=p.engineId==='windows-tts'?voice().tts.ready:voice().stt.ready;return {ok,message:ok?'Runtime is installed; microphone and recognition require an explicit listening test':VOICE_IS_MAC?'Allow microphone access for ZVYRA in System Settings':'Install the Windows desktop speech language'};});
  add('chat.list',z.object({projectId:id.optional()}),p=>listChats().filter(c=>!p.projectId||c.projectId===p.projectId).map(c=>map.conversation(getChat(c.id))));
  add('chat.create',z.object({title:z.string().max(100).optional(),projectId:id.optional(),model:id.optional()}),p=>{ensureModel(p.model);if(p.projectId&&!getProject(p.projectId))throw new ZvyraError('NOT_FOUND','Project not found');let c=newChat({projectId:p.projectId});if(p.title)c=renameChat(c.id,p.title);if(p.model)write(`chatModel.${c.id}`,p.model);return map.conversation(c);});
  add('chat.rename',z.object({id,title:z.string().min(1).max(100)}),p=>map.conversation(renameChat(p.id,p.title)));
  add('chat.delete',idArg,p=>{deleteChat(p.id);emit({type:'chat.conversationRemoved',payload:p});});
  add('chat.setModel',z.object({id,model:id.nullable()}),p=>{ensureModel(p.model);write(`chatModel.${p.id}`,p.model);return {...map.conversation(getChat(p.id)),model:p.model??undefined};});
  add('chat.messages',idArg,p=>getChat(p.id).turns.map(t=>map.message(p.id,t)));
  add('chat.send',z.object({conversationId:id,text,attachmentIds:z.array(id).max(0).optional(),model:id.optional()}),p=>{const model=p.model??read(`chatModel.${p.conversationId}`,null)??read('routingRoles',DEFAULT_ROUTING.roles).conversation;ensureModel(model);const c=sendChat({id:p.conversationId,text:p.text,model:model??undefined});return map.message(c.id,c.turns.at(-1)!);});
  add('chat.stop',z.object({conversationId:id}),p=>{stopChat(p.conversationId);});
  add('chat.retry',z.object({conversationId:id}),p=>{const c=getChat(p.conversationId),turn=c.turns.findLast(t=>t.role==='user');if(!turn)throw new ZvyraError('NOT_FOUND','No user message to retry');const next=sendChat({id:c.id,text:turn.text,retryFrom:turn.id});return map.message(c.id,next.turns.at(-1)!);});
  add('assistant.submit',z.object({text,source,projectId:id.optional(),model:id.optional()}),p=>{ensureModel(p.model);if(p.projectId&&!getProject(p.projectId))throw new ZvyraError('NOT_FOUND','Project not found');const c=newChat({projectId:p.projectId});const i:UI.Interaction={id:randomUUID(),source:p.source,input:p.text,status:'pending',conversationId:c.id,createdAt:map.iso(Date.now()),updatedAt:map.iso(Date.now())};saveInteraction(i);sendChat({id:c.id,text:p.text,model:p.model??read('routingRoles',DEFAULT_ROUTING.roles)[p.source==='voice'?'voice':'conversation']??undefined});emit({type:'assistant.interaction',payload:i});return i;});
  add('assistant.cancel',idArg,p=>{const i=interactions.get(p.id);if(!i)throw new ZvyraError('NOT_FOUND','Interaction not found');if(i.conversationId)stopChat(i.conversationId);});
  add('assistant.recent',z.object({limit}),p=>[...interactions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,p.limit??50));
  add('tasks.list',z.object({status:z.array(z.string()).optional(),projectId:id.optional(),limit}),p=>listRuns(p.projectId,p.limit??100).map(map.task).filter(t=>!p.status||p.status.includes(t.status)));
  add('tasks.get',idArg,p=>taskById(p.id));
  add('tasks.create',z.object({instruction:text,source,agentId:id.optional(),projectId:id.optional(),model:id.optional()}),p=>{ensureModel(p.model);if(p.agentId)throw new ZvyraError('NOT_IMPLEMENTED','SWARM assigns agents from the task plan');const projectId=p.projectId??createProject({name:p.instruction.slice(0,60)}).id;return map.task(startRun(projectId,p.instruction,{autonomy:'manual',pinnedModel:p.model}));});
  for(const action of ['cancel','pause','resume','retry'] as const)add(`tasks.${action}`,idArg,async p=>{const r=await call(`task.${action}`,p);return action==='retry'?map.task(r):taskById(p.id);});
  add('tasks.events',z.object({id,limit}),p=>queryEvents({runId:p.id,limit:p.limit??200}).map(e=>({id:e.id,taskId:p.id,ts:map.iso(e.ts),kind:e.level==='error'?'error':'status',message:e.message,data:e.data})));
  add('permissions.pending',obj,()=>listApprovals().map(map.permission));
  add('permissions.respond',z.object({id,decision:z.enum(['allow_once','allow_task','deny'])}),p=>{if(p.decision==='allow_task')throw new ZvyraError('NOT_IMPLEMENTED','Only single-action approval is supported');previousApprovals.delete(p.id);if(!resolveApproval(p.id,p.decision==='allow_once'))throw new ZvyraError('NOT_FOUND','Approval expired');emit({type:'permission.resolved',payload:p});});
  add('permissions.policies',obj,()=>(['read_files','write_files','delete_files','run_commands','computer_input','screen_capture'] as const).map(category=>({category,policy:category==='read_files'?'allow':'ask',allowedPolicies:[]})));
  add('swarm.connection',obj,connection);
  add('swarm.configure',z.object({baseUrl:z.string().max(200),apiKey:z.string().max(4096).optional()}),async p=>{const provider=p.baseUrl.replace(/^swarm:\/\/embedded\//,'');if(!BYOK_PROVIDER_IDS.includes(provider as any))throw new ZvyraError('INVALID_ARGS','Use swarm://embedded/openrouter (or google, groq, mistral, huggingface, nvidia). This SWARM uses in-process adapters, not an HTTP gateway.');if(p.apiKey!==undefined){await call('routing.credential',{provider,key:p.apiKey||null});write('providerTest.'+provider,null);}write('provider',`swarm://embedded/${provider}`);const c=connection();emit({type:'swarm.connection',payload:c});return c;});
  add('swarm.test',obj,async()=>{const provider=read('provider','swarm://embedded/openrouter').split('/').at(-1);const result=await call('routing.test',{provider});write('providerTest.'+provider,{status:result.status,checkedAt:Date.now()});if(result.status==='connected')await call('routing.discover',{provider});const c={...connection(),status:result.status==='connected'?'connected':'error',lastCheckedAt:map.iso(Date.now()),latencyMs:result.latencyMs??undefined,error:result.status==='connected'?undefined:result.message??result.status} as UI.SwarmConnection;emit({type:'swarm.connection',payload:c});return c;});
  add('models.list',z.object({refresh:z.boolean().optional()}),async p=>{if(p.refresh)await call('routing.discover');return listModels().map(m=>({id:m.id,ownedBy:m.providerId,available:usable(m),supportsVision:m.capabilities.includes('vision'),contextWindow:m.contextLength}));});
  add('routing.get',obj,()=>{const s=getSettings();return {mode:s.ai.pinnedModel?'manual':'auto',roles:{...DEFAULT_ROUTING.roles,...read('routingRoles',{}),general:s.ai.pinnedModel},fallbacks:s.routing.fallbacks,timeoutMs:s.routing.requestTimeoutSec*1000,maxRetries:s.routing.maxFallbacks};});
  add('routing.set',z.object({mode:z.enum(['auto','manual']).optional(),roles:z.object({conversation:id.nullable(),coding:id.nullable(),research:id.nullable(),computer:id.nullable(),general:id.nullable(),voice:id.nullable()}).partial().optional(),fallbacks:z.array(id).max(12).optional(),timeoutMs:z.number().int().min(10000).max(600000).optional(),maxRetries:z.number().int().min(0).max(12).optional()}).strict(),async p=>{for(const model of Object.values(p.roles??{}))ensureModel(model as string|null);const roles={...DEFAULT_ROUTING.roles,...read('routingRoles',{}),...p.roles};await call('routing.configure',{ai:{pinnedModel:p.mode==='auto'?null:roles.general,profile:'custom'},routing:{...(p.fallbacks?{fallbacks:p.fallbacks}:{}),...(p.timeoutMs?{requestTimeoutSec:Math.ceil(p.timeoutMs/1000)}:{}),...(p.maxRetries!==undefined?{maxFallbacks:p.maxRetries}:{})},modelPreference:{coder:roles.coding,researcher:roles.research,vision:roles.computer,manager:roles.conversation}});write('routingRoles',roles);return handlers['routing.get'].run({}) as UI.RoutingConfig;});
  add('agents.list',obj,agents);
  add('agents.runtime',obj,()=>({mode:getSettings().behavior.parallel?'parallel':'sequential',maxConcurrentTasks:getSettings().agents.maxConcurrent,runningTasks:listActiveRuns().flatMap(r=>runSnapshot(r.id)?.tasks??[]).filter(t=>t.status==='running').length,queuedTasks:listActiveRuns().flatMap(r=>runSnapshot(r.id)?.tasks??[]).filter(t=>['waiting','ready'].includes(t.status)).length}));
  for(const method of ['agents.setEnabled','agents.setModel'] as const)add(method,z.object({id,enabled:z.boolean().optional(),model:id.nullable().optional()}),p=>{if(!Object.hasOwn(ROLES,p.id))throw new ZvyraError('NOT_FOUND','Agent not found');ensureModel(p.model);updateSettings({agents:method==='agents.setEnabled'?{enabled:{[p.id]:z.boolean().parse(p.enabled)}}:{modelPreference:{[p.id]:p.model??null}}});const agent=agents().find(a=>a.id===p.id)!;emit({type:'agents.update',payload:agent});return agent;});
  add('agents.stop',idArg,p=>{if(!Object.hasOwn(ROLES,p.id))throw new ZvyraError('NOT_FOUND','Agent not found');for(const r of listActiveRuns())controlAgent(r.id,p.id as AgentRole,'stop');return agents().find(a=>a.id===p.id)!;});
  const computer=():UI.ComputerStatus=>({enabled:getSettings().computer.native,available:process.platform==='win32'||process.platform==='darwin',adapter:'Windows UI Automation / native input / SWARM',phase:pcControl.controlling?'executing':'idle',capabilities:{screenCapture:true,mouse:true,keyboard:true,windowInfo:true,appLaunch:true}});
  add('computer.status',obj,computer);add('computer.setEnabled',z.object({enabled:z.boolean()}),async p=>{await call('computer.permission',p);emit({type:'computer.status',payload:computer()});return computer();});
  add('computer.stop',obj,async()=>{await call('computer.permission',{enabled:false});cancelAll();stopAllChats();return computer();});
  add('computer.capture',obj,async()=>{const id=randomUUID(),r=await call('computer.execute',{id,action:{action:'screenshot'}});return {id,ts:map.iso(Date.now()),dataUrl:r.image,width:r.width,height:r.height};});
  add('projects.list',obj,()=>listProjects().map(map.project));
  add('projects.active',obj,()=>{const p=getProject(read('activeProject',''));return p?map.project(p):null;});
  add('projects.pickFolder',obj,async()=>{const r=await dialog.showOpenDialog({properties:['openDirectory','createDirectory']});if(r.canceled)return null;const folder=fs.realpathSync(r.filePaths[0]);selectedFolders.add(folder);return folder;});
  add('projects.create',z.object({name:z.string().min(1).max(100),path:z.string().max(2000),createFolder:z.boolean().optional()}),p=>{if(p.path&&!selectedFolders.has(p.path))throw new ZvyraError('PERMISSION_DENIED','Select the project folder with the native picker first');const project=createProject({name:p.name,...(p.path?{path:p.path}:{})});emit({type:'project.upsert',payload:map.project(project)});return map.project(project);});
  add('projects.setActive',z.object({id:id.nullable()}),p=>{if(p.id&&!getProject(p.id))throw new ZvyraError('NOT_FOUND','Project not found');write('activeProject',p.id);emit({type:'project.active',payload:p});return p.id?map.project(getProject(p.id)!):null;});
  for(const method of ['projects.open','projects.close'] as const)add(method,idArg,p=>map.project(updateProject(p.id,{archived:method==='projects.close',lastOpenedAt:Date.now()})));
  add('projects.rename',z.object({id,name:z.string().min(1).max(100)}),p=>map.project(updateProject(p.id,{name:p.name})));
  add('projects.setFavorite',z.object({id,favorite:z.boolean()}),p=>map.project(updateProject(p.id,{favorite:p.favorite})));
  add('projects.updateContext',z.object({id,context:z.string().max(10000)}),p=>{const project=getProject(p.id);if(!project)throw new ZvyraError('NOT_FOUND','Project not found');project.memory.summary=p.context;return map.project(saveProject(project));});
  add('activity.list',z.object({query:z.string().max(500).optional(),types:z.array(z.string()).optional(),limit,before:z.string().datetime().optional()}),p=>queryEvents({limit:p.limit??200,before:p.before?Date.parse(p.before):undefined}).map(map.activity).filter(e=>(!p.query||e.title.toLowerCase().includes(p.query.toLowerCase()))&&(!p.types||p.types.includes(e.type))));
  add('activity.clear',obj,()=>{db().prepare('DELETE FROM events').run();});
  add('memory.list',z.object({query:z.string().max(500).optional(),kind:memorySchema.shape.kind.optional(),projectId:id.optional()}),p=>backend.service.preferences().memoryEnabled?backend.service.store.list<UI.MemoryItem>('uiMemory').filter(m=>(!p.kind||m.kind===p.kind)&&(!p.projectId||m.projectId===p.projectId)&&(!p.query||(m.title+' '+m.content).toLowerCase().includes(p.query.toLowerCase()))):[]);
  add('memory.create',memorySchema,p=>{if(!backend.service.preferences().memoryEnabled)throw new ZvyraError('PERMISSION_DENIED','Saved memory is disabled');return backend.service.store.put<UI.MemoryItem>('uiMemory',{...p,id:randomUUID(),source:'user',createdAt:map.iso(Date.now()),updatedAt:map.iso(Date.now())});});
  add('memory.update',memorySchema.partial().extend({id}),p=>{const m=backend.service.store.list<UI.MemoryItem>('uiMemory').find(m=>m.id===p.id);if(!m)throw new ZvyraError('NOT_FOUND','Memory not found');return backend.service.store.put('uiMemory',{...m,...p,updatedAt:map.iso(Date.now())});});
  add('memory.delete',idArg,p=>{backend.service.store.remove('uiMemory',p.id);});
  add('memory.clear',z.object({kind:memorySchema.shape.kind.optional()}),p=>{const items=backend.service.store.list<UI.MemoryItem>('uiMemory').filter(m=>!p.kind||m.kind===p.kind);for(const m of items)backend.service.store.remove('uiMemory',m.id);return {removed:items.length};});
  add('memory.settings',obj,()=>({enabled:backend.service.preferences().memoryEnabled,agentMaySave:'never',includeInContext:false,retentionDays:null}));
  add('memory.setSettings',z.object({enabled:z.boolean().optional(),agentMaySave:z.literal('never').optional(),includeInContext:z.literal(false).optional(),retentionDays:z.null().optional()}),async p=>{if(p.enabled!==undefined)await call('preferences.update',{memoryEnabled:p.enabled});return handlers['memory.settings'].run({}) as UI.MemorySettings;});
  add('automations.list',obj,()=>backend.service.store.list<Automation>('automation').map(automation));
  add('automations.scheduler',obj,()=>({running:true,note:'One-time schedules run only while ZVYRA is open. Missed schedules run after restart; uncertain dispatches require review.'}));
  add('automations.create',z.object({name:z.string().min(1).max(100),instruction:text,schedule:z.object({type:z.literal('once'),at:z.string().datetime()}),enabled:z.literal(true),agentId:z.never().optional(),projectId:id.optional()}),async p=>{const projectId=p.projectId??createProject({name:p.name}).id;const a=await call('automation.create',{projectId,instruction:p.instruction,at:Date.parse(p.schedule.at)});write(`automationName.${a.id}`,p.name);write(`automationCreated.${a.id}`,map.iso(Date.now()));const result=automation(a);emit({type:'automation.upsert',payload:result});return result;});
  add('automations.delete',idArg,p=>{const a=backend.service.store.list<Automation>('automation').find(a=>a.id===p.id);if(a?.state==='dispatching')throw new ZvyraError('UNAVAILABLE','Dispatch in progress');backend.service.store.remove('automation',p.id);emit({type:'automation.removed',payload:p});});
  add('automations.runs',z.object({id,limit}),p=>{const a=backend.service.store.list<Automation>('automation').find(a=>a.id===p.id);if(!a?.runId)return [];const t=taskById(a.runId);return [{id:a.runId,automationId:a.id,taskId:a.runId,startedAt:t.createdAt,finishedAt:t.finishedAt,status:t.status,summary:t.summary}];});
  add('notifications.list',z.object({limit,unreadOnly:z.boolean().optional()}),p=>listNotifications().filter(n=>!p.unreadOnly||!n.read).slice(0,p.limit??200).map(map.notification));
  add('notifications.markRead',z.object({id:id.optional()}),p=>{for(const n of listNotifications())if(!p.id||n.id===p.id)db().put('notifications',n.id,{...n,read:true},{ts:n.ts});});
  add('notifications.clear',obj,()=>{clearNotifications();});
  add('notifications.policy',obj,()=>{const p=backend.service.preferences();return {...DEFAULT_NOTIFICATION_POLICY,doNotDisturb:p.doNotDisturb,quietHours:{enabled:p.quietHours,start:`${String(p.quietStart).padStart(2,'0')}:00`,end:`${String(p.quietEnd).padStart(2,'0')}:00`,allowCritical:false}};});
  add('notifications.setPolicy',z.object({doNotDisturb:z.boolean().optional(),quietHours:z.object({enabled:z.boolean(),start:z.string().regex(/^([01]\d|2[0-3]):00$/),end:z.string().regex(/^([01]\d|2[0-3]):00$/),allowCritical:z.literal(false).optional()}).optional()}).strict(),async p=>{await call('preferences.update',{...(p.doNotDisturb!==undefined?{doNotDisturb:p.doNotDisturb}:{}),...(p.quietHours?{quietHours:p.quietHours.enabled,quietStart:Number(p.quietHours.start.slice(0,2)),quietEnd:Number(p.quietHours.end.slice(0,2))}:{})});return handlers['notifications.policy'].run({}) as UI.NotificationPolicy;});
  add('notifications.test',obj,()=>{notify('info','info','Notification test','ZVYRA notification pipeline is working');return map.notification(listNotifications()[0]);});
  add('whatsappCalls.state',obj,()=>({defaultContact:'',autoCallEnabled:false,minPriority:'high'}));
  add('whatsappCalls.isActive',obj,()=>false);
  return {
    async invoke<K extends MethodName>(method:K,args:MethodArgs<K>):Promise<MethodResult<K>> {
      if(!Object.hasOwn(handlers,method))throw new ZvyraError(method.startsWith('whatsappCalls.')?'NOT_CONFIGURED':'NOT_IMPLEMENTED',`Not available in this backend: ${method}`);
      try {const input=handlers[method].schema.parse(args??{});return await handlers[method].run(input) as MethodResult<K>;}
      catch(e){if(e instanceof ZvyraError)throw e;if(e instanceof z.ZodError)throw new ZvyraError('INVALID_ARGS','Request is unsupported or has invalid fields');throw new ZvyraError('BACKEND_ERROR',redact(e instanceof Error?e.message:String(e)));}
    },
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async dispose(){await backend.close();listeners.clear();},
  };
}


