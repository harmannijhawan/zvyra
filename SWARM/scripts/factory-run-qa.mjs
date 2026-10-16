import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(), label = process.argv[2] ?? 'after';
const dir = path.join(root, '.swarm-test', `factory-run-${label}-${Date.now()}`);
const project = path.join(dir, 'cli'); fs.mkdirSync(project, {recursive:true});
fs.writeFileSync(path.join(project,'package.json'), JSON.stringify({name:'factory-qa',version:'1.0.0',scripts:{test:'node test.cjs',start:'node cli.cjs'}}));
fs.writeFileSync(path.join(project,'cli.cjs'), 'console.log("Usage: factory [--help]");\nmodule.exports = 41;\n');
fs.writeFileSync(path.join(project,'test.cjs'), 'require("node:assert/strict").equal(require("./cli.cjs"),42);\n');
let calls=0, promptChars=0;
const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
  if(req.url==='/api/version')return res.end(JSON.stringify({version:'fixture'}));
  if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'qwen3-coder:30b',details:{parameter_size:'30B'}}]}));
  if(req.url!=='/api/chat'){res.statusCode=404;return res.end();}
  calls++;promptChars+=JSON.stringify(body.messages).length;
  const system=body.messages[0].content; let text;
  if(system.includes('SWARM Manager')) text=JSON.stringify({title:'CLI fix',projectType:'cli_tool',platform:'cli',summary:'Correct the CLI result from 41 to 42',requirements:['Result must be 42'],agents:['coder'],researchQueries:[],stackHint:'Node'});
  else if(system.includes('SWARM Planner')) text=JSON.stringify({tasks:[{key:'fix',title:'Fix CLI',role:'coder',description:'Correct the result',deps:[],scope:['cli.cjs'],queries:[]}]});
  else if(system.includes('SWARM Finalizer')) text='Changed the CLI result to 42. The actual command-line test and help command passed.';
  else text='<edit path="cli.cjs"><find>module.exports = 41;</find><replace>module.exports = 42;</replace></edit><done>Corrected CLI result to 42.</done>';
  res.setHeader('Content-Type','application/x-ndjson');
  res.end(JSON.stringify({message:{content:text},done:false})+'\n'+JSON.stringify({done:true,prompt_eval_count:Math.ceil(JSON.stringify(body.messages).length/4),eval_count:Math.ceil(text.length/4)})+'\n');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const db=new DatabaseSync(path.join(dir,'swarm.db'));db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
const settings={providers:{useEnvKeys:false,enabled:Object.fromEntries(['nvidia','openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama'].map(x=>[x,x==='ollama']))},advanced:{ollamaUrl:`http://127.0.0.1:${server.address().port}`},routing:{healthCheckOnStartup:false,discoveryIntervalMin:0},agents:{enabled:{reviewer:false}},behavior:{autonomy:'autonomous'},execution:{packageManager:'npm'},workspace:{root:path.join(dir,'projects')}};
for(const[k,v]of Object.entries({onboarded:'1',settings:JSON.stringify(settings)}))db.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);db.close();
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--smoke'],env:{...process.env,SWARM_USER_DATA:dir}});
const win=await app.firstWindow();const inv=(channel,...args)=>win.evaluate(({channel,args})=>window.swarm.invoke(channel,...args),{channel,args});
try {
 await win.locator('#chat-input').waitFor();await inv('models:discover','ollama');
 const p=await inv('projects:create',{name:'CLI verification fixture',path:project});
 const start=performance.now();const run=await inv('runs:start',p.id,'Build a CLI fix: change the exported result in cli.cjs from 41 to 42.',{webResearch:false,autonomy:'autonomous'});
 let snapshot;
 for(let i=0;i<120;i++){snapshot=await inv('runs:snapshot',run.id);if(snapshot.run.status!=='running')break;await new Promise(r=>setTimeout(r,500));}
 const report={label,dir,durationMs:performance.now()-start,calls,promptChars,stats:snapshot.run.stats,status:snapshot.run.status,gates:snapshot.run.gates,tasks:snapshot.tasks.map(t=>({kind:t.kind,status:t.status,error:t.error}))};
 fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 assert.equal(snapshot.run.status,'completed');assert.equal(snapshot.run.gates.find(g=>g.id==='unit')?.status,'passed');assert.equal(snapshot.run.gates.find(g=>g.id==='cli_help')?.status,'passed');
 await win.getByRole('button',{name:'Build',exact:true}).click();
 await win.getByText('CLI verification fixture',{exact:true}).first().click().catch(()=>{});
 await win.waitForTimeout(400);
 await win.screenshot({path:path.join(dir,'result.png')});
 if(label !== 'baseline') {
   for(const [width,height] of [[1280,720],[1440,900],[1920,1080],[2560,1440]]) {
     await win.setViewportSize({width,height});
     await win.screenshot({path:path.join(dir,'result-'+width+'.png')});
     await win.getByRole('button',{name:'Details',exact:true}).click();
     await win.screenshot({path:path.join(dir,'details-'+width+'.png')});
     assert.equal(await win.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
     await win.getByRole('button',{name:'Hide details',exact:true}).click();
   }
 }
}finally{await app.close();server.closeAllConnections();server.close();}
