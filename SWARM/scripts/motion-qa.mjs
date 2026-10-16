// Real Electron renderer + IPC, isolated persisted fixture and controlled state events.
import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><h1>Preview acceptance</h1><button onclick="this.textContent=\'Verified\'">Try preview</button></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const root=process.cwd(), dir=path.join(root,'.swarm-test','motion-'+Date.now());
fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'swarm.db'));
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings={providers:{useEnvKeys:false,enabled:Object.fromEntries(['nvidia','openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama'].map(p=>[p,false]))},routing:{healthCheckOnStartup:false,discoveryIntervalMin:0},workspace:{root:path.join(dir,'projects')},appearance:{theme:'light'}};
for(const [k,v] of Object.entries({onboarded:'1',settings:JSON.stringify(settings)}))db.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);
db.close();
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--smoke'],env:{...process.env,SWARM_USER_DATA:dir}});
const win=await app.firstWindow(), report={dir,checks:[],errors:[]};
win.on('pageerror',e=>report.errors.push(e.message));
const inv=(channel,...args)=>win.evaluate(({channel,args})=>window.swarm.invoke(channel,...args),{channel,args});
const emit=(channel,payload)=>app.evaluate(({BrowserWindow},{channel,payload})=>BrowserWindow.getAllWindows()[0].webContents.send(channel,payload),{channel,payload});
const check=(label,value)=>{assert.ok(value,label);report.checks.push(label);console.log('PASS',label);};
const shot=name=>win.screenshot({path:path.join(dir,name+'.png')});
try {
 await win.locator('#chat-input').waitFor();
 check('central motion tokens loaded',await win.evaluate(()=>['220ms','.22s','0.22s'].includes(getComputedStyle(document.documentElement).getPropertyValue('--motion-normal').trim())));
 await win.waitForTimeout(700);
 check('idle Chat has no running animations',await win.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length===0));
 await shot('chat');
 for(const name of ['Models','Settings']) { await win.getByRole('button',{name,exact:true}).first().click();await win.waitForTimeout(400);check(name+' renders', (await win.locator('main').innerText()).length>50);await shot(name.toLowerCase()); }
 await win.getByRole('button',{name:'Build',exact:true}).click();
 const project=await inv('projects:create',{name:'Motion acceptance',objective:'Motion acceptance fixture'});
 const run={id:'motion-run',projectId:project.id,objective:'Motion acceptance fixture',target:'web',status:'paused',startedAt:Date.now(),endedAt:null,summary:'',brief:null,gates:[],previewUrl:null,repairCycles:0,options:{webResearch:false,autonomy:'assisted',attachments:[],pinnedModel:null},stats:{tasks:4,completed:1,failed:0,modelCalls:0,fallbacks:0,tokens:0,files:0,commands:0,sources:0}};
 const tasks=['manager','designer','coder','tester'].map((role,i)=>({id:'motion-task-'+i,runId:run.id,key:role,title:role+' task',description:'Acceptance fixture',role,kind:'code',status:i===0?'completed':'pending',deps:i?['motion-task-'+(i-1)]:[],attempt:0,scope:[],output:'',error:null,modelId:null,startedAt:null,endedAt:null,createdAt:Date.now()+i,filesTouched:[],tokens:0}));
 const seed=new DatabaseSync(path.join(dir,'swarm.db'));
 seed.prepare('INSERT INTO runs(id,project_id,started_at,data) VALUES(?,?,?,?)').run(run.id,project.id,run.startedAt,JSON.stringify(run));
 for(const t of tasks)seed.prepare('INSERT INTO tasks(id,run_id,created_at,data) VALUES(?,?,?,?)').run(t.id,run.id,t.createdAt,JSON.stringify(t));
 seed.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project,lastRunId:run.id}),project.id);seed.close();
 await win.reload();await win.locator('#chat-input').waitFor();await win.getByRole('button',{name:'Build',exact:true}).click();
 await win.getByRole('button',{name:'Projects',exact:true}).first().click();
 await win.getByRole('button',{name:'Open in Build',exact:true}).first().click();
 await win.locator('.workforce-node').first().waitFor();
 check('graph loads all four agents',await win.locator('.workforce-node').count()===4);
 const event=(type,data,agent='coder')=>({id:crypto.randomUUID(),ts:Date.now(),projectId:project.id,runId:run.id,type,level:'info',agent,message:type,data});
 await emit('run:updated',{...run,status:'running'});
 await emit('events',[event('AGENT_STATUS',{agent:{role:'coder',status:'working',taskTitle:'Coder task'} }),event('TASK_UPDATED',{task:{...tasks[2],status:'running'}}),event('AGENT_MESSAGE',{message:{id:'signal-1',runId:run.id,ts:Date.now(),from:'manager',to:'coder',content:'Implement the update'}})]);
 await win.waitForTimeout(100);
 check('running node has live state',await win.locator('.workforce-node[data-motion-state="working"]').count()>=1);
 check('communication signal exists',await win.locator('.graph-signal').count()>0);
 await shot('graph-working');
 for(const role of ['Designer','Coder','Tester','Manager']) {await win.getByRole('button',{name:new RegExp('^'+role+':')}).click();check(role+' conversation selected',await win.getByRole('button',{name:'Select agent conversation'}).innerText().then(s=>s.includes(role)));}
 await emit('events',[event('AGENT_STATUS',{agent:{role:'coder',status:'failed'}})]);
 await win.locator('.workforce-node[data-motion-state="failed"]').waitFor();
 await emit('events',[event('AGENT_STATUS',{agent:{role:'coder',status:'working'}}),event('GRAPH_UPDATED',{})]);
 await emit('events',[event('AGENT_STATUS',{agent:{role:'coder',status:'completed'}}),event('TASK_COMPLETED',{task:{...tasks[2],status:'completed'}})]);
 await win.locator('.workforce-node[data-motion-state="completed"]').first().waitFor();
 check('failure recovery and completion render',true);
 await win.locator('.build-activity-tabs').getByRole('tab',{name:/^Tasks/}).click();
 check('task list renders',await win.locator('.build-task-list button').count()===4);
 await emit('run:updated',{...run,status:'running',previewUrl:`http://127.0.0.1:${server.address().port}`});
 await win.locator('.build-activity-tabs').getByRole('tab',{name:'Preview',exact:true}).click();
 await win.locator('webview').waitFor();
 await win.waitForFunction(()=>{const w=document.querySelector('webview');try{return w && !w.isLoading();}catch{return false;}});
 check('web preview remains interactive',await win.evaluate(async()=>document.querySelector('webview').executeJavaScript("document.querySelector('button').click();document.querySelector('button').textContent==='Verified'")));
 await shot('web-preview');
 await win.emulateMedia({reducedMotion:'reduce'});
 await win.getByRole('button',{name:/^Coder:/}).click();await win.waitForTimeout(80);
 check('reduced motion removes animations',await win.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length===0));
 await win.emulateMedia({reducedMotion:'no-preference'});
 await emit('run:updated',{...run,status:'completed'});
 await win.waitForTimeout(2000);await shot('graph-completed');
 check('completed graph settles',await win.evaluate(()=>document.querySelector('.agent-graph-shell').getAnimations({subtree:true}).filter(a=>a.playState==='running').length===0));
 for(let i=0;i<8;i++){await win.getByRole('button',{name:'Chat',exact:true}).click();await win.getByRole('button',{name:'Build',exact:true}).click();}
 await win.waitForTimeout(700);
 check('rapid navigation preserves graph',await win.locator('.workforce-node').count()===4);
 report.metrics=await app.evaluate(({app})=>app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu.percentCPUUsage,memoryKB:p.memory.workingSetSize})));
 check('no renderer exceptions',report.errors.length===0);
} catch(e){report.failure=String(e);process.exitCode=1;console.error(e);await shot('failure');}
finally {fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));await app.close();server.closeAllConnections();server.close();console.log('REPORT',dir);}
