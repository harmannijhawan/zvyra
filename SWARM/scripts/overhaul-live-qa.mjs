// Real free-provider workflow acceptance. Does not substitute fixture model responses.
import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(), dir=path.join(root,'.swarm-test','overhaul-live-'+Date.now());
fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'swarm.db'));
db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const gradle=path.join(process.env.USERPROFILE,'.gradle','wrapper','dists','gradle-9.3.1-bin','23ovyewtku6u96viwx3xl3oks','gradle-9.3.1','bin');
const java='C:\\Program Files\\Android\\Android Studio\\jbr';
const sdk=path.join(process.env.LOCALAPPDATA,'Android','Sdk');
const settings={providers:{enabled:Object.fromEntries(['openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama','nvidia'].map(id=>[id,id==='nvidia']))},workspace:{root:path.join(dir,'projects')},routing:{healthCheckOnStartup:false,discoveryIntervalMin:0,firstTokenTimeoutSec:20,requestTimeoutSec:90,maxFallbacks:3},execution:{packageManager:'npm'},behavior:{autonomy:'autonomous',maxRepairCycles:2},research:{defaultOn:false},computer:{native:true},agents:{enabled:{reviewer:false}},experimental:{visionQA:false},browser:{headless:true}};
for(const[k,v]of Object.entries({onboarded:'1',settings:JSON.stringify(settings)}))db.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);
db.close();
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--smoke'],env:{...process.env,SWARM_USER_DATA:dir,JAVA_HOME:java,ANDROID_HOME:sdk,Path:java+'\\bin;'+gradle+';'+path.join(sdk,'platform-tools')+';'+process.env.Path}});
const win=await app.firstWindow(), report={dir,builds:[],errors:[]};
win.on('pageerror',e=>report.errors.push(e.message));
const inv=(channel,...args)=>win.evaluate(({channel,args})=>window.swarm.invoke(channel,...args),{channel,args});
const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
const objectives=[
 'Build a responsive static website with index.html only: a heading and a button that changes its label when clicked. No dependencies.',
 'Create a Node.js CLI tool that adds two numbers from arguments. Include --help, invalid input errors, a bin entry, and automated tests. No dependencies.',
 'Build a minimal native Windows desktop calculator with .NET WinForms. Preserve Windows target. Include a .csproj, automated arithmetic tests if possible, build and packaging instructions.',
 'Create a minimal native Android calculator using Java and Android Activity. No external app dependencies. Use installed Android Gradle plugin 9.1.1, Gradle 9.3.1, compileSdk block version = release(36) { minorApiLevel = 1 }, minSdk26, targetSdk36. Provide a proper launchable Activity and tests.'
];
try {
 await win.locator('#chat-input').waitFor();await inv('models:discover','nvidia');
 for(const objective of objectives){
   const p=await inv('projects:create',{objective}), run=await inv('runs:start',p.id,objective,{webResearch:false,autonomy:'autonomous'});
   const started=performance.now(), until=Date.now()+420000;let snapshot, chats=false;
   console.log('START '+run.target+' '+run.id);
   for(;;){
     snapshot=await inv('runs:snapshot',run.id);
     // Approval is restricted to native observations within this QA run.
     for(const approval of await inv('approvals:list'))if(approval.runId===run.id && approval.kind==='computer')await inv('approvals:resolve',approval.id,true);
     if(!chats && snapshot.tasks.some(t=>t.role==='coder' && t.status==='running')){
       chats=true;const before=snapshot.run.stats.modelCalls;
       for(const agentRole of ['coder','tester'])await inv('run:chat:agent:send',{runId:run.id,agentRole,text:'How is your progress?'});
       await inv('run:chat:send',{runId:run.id,text:'How is my build doing?'});
       await win.getByRole('button',{name:'Chat',exact:true}).click();
       await win.reload();await win.locator('#chat-input').waitFor();
       const restored=await inv('runs:snapshot',run.id);if(restored.run.id!==run.id)throw Error('Run identity changed on navigation');
       report.navigation={runId:run.id,restored:true,chatStatusUsedState:true,before};save();
     }
     if(snapshot.run.status!=='running')break;
     if(Date.now()>until){await inv('runs:cancel',run.id);throw Error('Timed out: '+run.target);}
     await new Promise(r=>setTimeout(r,500));
   }
   const events=await inv('runs:events',{runId:run.id,limit:2000});
   const timing=await inv('runs:performance',run.id);
   const entry={target:run.target,status:snapshot.run.status,durationMs:performance.now()-started,summary:snapshot.run.summary,gates:snapshot.run.gates,stats:snapshot.run.stats,tasks:snapshot.tasks,messages:snapshot.messages,timing,overlap:snapshot.tasks.some((a,i)=>snapshot.tasks.some((b,j)=>i!==j&&a.startedAt&&b.startedAt&&a.endedAt&&b.endedAt&&a.startedAt<b.endedAt&&b.startedAt<a.endedAt)),path:p.path};
   report.builds.push(entry);save();console.log('END '+run.target+' '+snapshot.run.status+' calls='+snapshot.run.stats.modelCalls);
   if(run.target==='web' && !snapshot.run.gates.some(g=>g.id==='browser'&&g.status==='passed'))console.log('WEB CHECK DID NOT PASS');
 }
}catch(e){report.failure=String(e);process.exitCode=1;console.error(String(e));}
finally{save();await app.close();console.log('REPORT '+path.join(dir,'report.json'));}
