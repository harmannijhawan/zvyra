import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const folder=path.join(root,'.swarm-test','two-modes-live-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const db=new DatabaseSync(path.join(folder,'swarm.db'));db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings={providers:{enabled:Object.fromEntries(['openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama','nvidia'].map(id=>[id,id==='nvidia']))},workspace:{root:path.join(folder,'projects')},routing:{healthCheckOnStartup:false,discoveryIntervalMin:0,firstTokenTimeoutSec:12,requestTimeoutSec:60,maxFallbacks:4},execution:{packageManager:'npm'},behavior:{autonomy:'autonomous',maxRepairCycles:2},research:{defaultOn:false},appearance:{theme:'light'}};
for(const [k,v]of Object.entries({onboarded:'1',settings:JSON.stringify(settings)}))db.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);db.close();
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--smoke'],env:{...process.env,SWARM_USER_DATA:folder}});
const win=await app.firstWindow();const errors=[];win.on('pageerror',e=>{errors.push(e.message);console.log('UI ERROR',e.message)});
const inv=(channel,...args)=>win.evaluate(({channel,args})=>window.swarm.invoke(channel,...args),{channel,args});
const report={folder,chat:[],build:[],errors};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
async function waitChat(){const until=Date.now()+300000;for(;;){const list=await inv('chat:list');const c=await inv('chat:get',list[0].id);if(c.turns.at(-1)?.status!=='streaming')return c;if(Date.now()>until)throw Error('Chat timed out');await new Promise(r=>setTimeout(r,500));}}
async function ask(text){await win.locator('#chat-input').fill(text);await win.getByRole('button',{name:'Send message',exact:true}).click();await win.waitForTimeout(200);const c=await waitChat();const t=c.turns.at(-1);report.chat.push({prompt:text,status:t.status,model:t.model,text:t.text.slice(0,600),error:t.error});console.log('CHAT',text,t.status,t.model??'',t.error??'');save();if(t.status!=='complete')throw Error(t.error??'Chat failed');return c;}
try{
 await win.locator('#chat-input').waitFor({timeout:30000});
 const models=await inv('models:discover','nvidia');console.log('Available models',models.models.length); await inv('models:healthCheck','nvidia'); console.log('Health check finished');
 if(!process.argv.includes('--build-only')) {
 await ask('hi');if((await inv('projects:list')).length)throw Error('Greeting created a project');
 await ask('Explain React hooks in two paragraphs.');await ask('What about useEffect? Show a short code example.');
 await ask('Write a Python function to get the email field from a user dictionary. Include a short explanation.');await ask('This gives me a KeyError when the field is absent. Fix it.');
 await win.locator('input[type=file]').setInputFiles({name:'context.txt',mimeType:'text/plain',buffer:Buffer.from('The internal project codename is Marigold. Its release owner is Ada.')});await ask('What is the project codename in my attached file?');
 await ask('Compare lists and dictionaries in a Markdown table. Include headings and a numbered list.');
 await win.getByRole('button',{name:'New chat',exact:true}).click();await ask('Research the latest Android development tools. Cite sources and disclose search limitations.');
 await win.getByRole('button',{name:/^Rename /}).first().click();await win.getByRole('textbox',{name:'Chat name'}).fill('Android research');await win.getByRole('button',{name:'Save',exact:true}).click();await win.getByRole('textbox',{name:'Search chats'}).fill('Android research');
 if(await win.locator('.chat-history-title').count()!==1)throw Error('Search mismatch');await win.getByRole('textbox',{name:'Search chats'}).fill('');
 await win.screenshot({path:path.join(folder,'chat.png')});
 }
 for(const objective of [
 'Build a website: a responsive static welcome page with a heading and a button that changes its label when clicked. Use index.html only and no dependencies.',
 'Create a CLI tool in Node.js that adds two numbers from arguments. Include --help, invalid argument errors and automated tests. No dependencies.',
 'Build me a Windows calculator using a minimal native Windows implementation. Do not build a website. Report unavailable compilation or desktop validation honestly.',
 'Make an Android app: a minimal Kotlin calculator with Jetpack Compose. Do not build a website. Report unavailable SDK or emulator validation honestly.'
 ]){
   await win.getByRole('button',{name:'Build',exact:true}).click();
   // A fresh project for each acceptance scenario; start through the real IPC and open through the UI.
   await inv('runs:resolveTarget',objective);
   const p=await inv('projects:create',{objective});const r=await inv('runs:start',p.id,objective,{webResearch:false,autonomy:'autonomous'});
   console.log('BUILD START',r.target,r.id);await win.reload();await win.locator('#chat-input').waitFor();await win.getByRole('button',{name:'Build',exact:true}).click(); await win.getByRole('button',{name:p.name,exact:false}).first().click();
   const until=Date.now()+600000;let snap;
   for(;;){snap=await inv('runs:snapshot',r.id);if(snap.run.status!=='running')break;if(Date.now()>until){await inv('runs:cancel',r.id);break;}await new Promise(r=>setTimeout(r,3000));}
   report.build.push({target:r.target,status:snap.run.status,summary:snap.run.summary,gates:snap.run.gates,tasks:snap.tasks.map(t=>({role:t.role,status:t.status,error:t.error})),path:p.path});save();console.log('BUILD END',r.target,snap.run.status,snap.run.summary?.slice(0,250));
 }
 await win.screenshot({path:path.join(folder,'build.png')});
}catch(e){report.failure=String(e);console.log('FAIL',String(e));await win.screenshot({path:path.join(folder,'failure.png')}).catch(()=>{});process.exitCode=1;}finally{save();await app.close();console.log('REPORT',path.join(folder,'report.json'));}
