import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=process.cwd(),folder=path.join(root,'.swarm-test','two-modes-ui-'+Date.now());fs.mkdirSync(folder,{recursive:true});
let scenario='normal';let requests=[];let failOnce=true;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/version')return res.end(JSON.stringify({version:'test'}));
 if(req.url==='/api/tags')return res.end(JSON.stringify({models:['fixture-fast:3b','fixture-code:30b'].map(name=>({name,size:1e9,details:{parameter_size:name.includes('3b')?'3B':'30B'}}))}));
 if(req.url==='/api/show')return res.end(JSON.stringify({capabilities:['completion','vision'],model_info:{'test.context_length':32768}}));
 if(req.url!=='/api/chat'){res.statusCode=404;return res.end('{}');}
 requests.push(body);
 if(scenario==='error'||(scenario==='fallback'&&failOnce)){failOnce=false;res.statusCode=503;return res.end('fixture unavailable');}
 const last=body.messages.at(-1)?.content??'';
 let text='# A useful answer\n\nThis response uses conversation context.\n\n| Item | Value |\n| --- | --- |\n| Answer | 42 |\n\n```python\ndef answer():\n    return 42\n```\n\n- Clear explanation\n- A second point\n';
 if(last.includes('file'))text+='\nThe attached file says Marigold.\n';
 const chunks=text.match(/.{1,15}/gs);res.setHeader('Content-Type','application/x-ndjson');
 for(const chunk of chunks){if(res.destroyed)return;res.write(JSON.stringify({message:{content:chunk},done:false})+'\n');await new Promise(r=>setTimeout(r,scenario==='slow'?200:15));}
 res.end(JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:120,eval_count:70})+'\n');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const d=new DatabaseSync(path.join(folder,'swarm.db'));d.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');const settings={providers:{useEnvKeys:false,enabled:Object.fromEntries(['nvidia','openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama'].map(id=>[id,id==='ollama']))},advanced:{ollamaUrl:base},routing:{healthCheckOnStartup:false,discoveryIntervalMin:0},workspace:{root:path.join(folder,'projects')},appearance:{theme:'light'}};for(const[k,v]of Object.entries({onboarded:'1',settings:JSON.stringify(settings)}))d.prepare('INSERT INTO kv VALUES (?,?)').run(k,v);d.close();
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--smoke'],env:{...process.env,SWARM_USER_DATA:folder}});const win=await app.firstWindow();const errors=[];win.on('pageerror',e=>errors.push(e.message));const inv=(channel,...args)=>win.evaluate(({channel,args})=>window.swarm.invoke(channel,...args),{channel,args});
const checks=[];async function done(){await win.getByRole('button',{name:'Stop generation',exact:true}).waitFor({state:'hidden',timeout:30000});await win.waitForTimeout(100);}
async function send(text){await win.locator('#chat-input').fill(text);await win.getByRole('button',{name:'Send message',exact:true}).click();await win.waitForFunction(()=>document.querySelector('.chat-message:last-child .chat-stream') || document.querySelector('.chat-message:last-child .chat-error'));await done();}
try{
 await win.locator('#chat-input').waitFor();await inv('models:discover','ollama');
 await send('hi');assert.equal((await inv('projects:list')).length,0);assert.equal((await inv('runs:list')).length,0);checks.push('greeting streamed; no project/run');
 assert.equal(await win.locator('.chat-message.assistant table').count(),1);assert.equal(await win.locator('.chat-code code .hljs-keyword').count()>0,true);checks.push('GFM table, code and syntax highlighting');
 await send('What about recursion?');assert.equal(requests.at(-1).messages.some(m=>m.content==='hi'),true);checks.push('followup history');
 await win.getByRole('button',{name:'Edit',exact:true}).first().click();await win.locator('#chat-input').fill('Explain Python');await win.getByRole('button',{name:'Send message',exact:true}).click();await win.getByRole('button',{name:'Stop generation',exact:true}).waitFor();await done();assert.equal(await win.locator('.chat-message.user').count(),1);checks.push('edit and regenerate history branch');
 await win.getByRole('button',{name:'Regenerate',exact:true}).click();await win.getByRole('button',{name:'Stop generation',exact:true}).waitFor();await done();checks.push('regenerate');
 await win.getByRole('button',{name:'Continue',exact:true}).last().click();await win.getByRole('button',{name:'Stop generation',exact:true}).waitFor();await done();checks.push('continue');
 scenario='fallback';failOnce=true;await send('Fallback test');assert.match(await win.locator('.chat-actions').last().innerText(),/Fallback succeeded/);checks.push('503 fallback through registry');
 scenario='slow';await win.locator('#chat-input').fill('A long answer');await win.getByRole('button',{name:'Send message',exact:true}).click();await win.getByRole('button',{name:'Stop generation',exact:true}).click();await done();assert.match(await win.locator('.chat-message').last().innerText(),/Response stopped/);checks.push('stop');
 scenario='error';await send('Fail every model');assert.equal(await win.getByRole('button',{name:'Retry',exact:true}).count(),1);checks.push('all-model failure shows Chat error');
 scenario='normal';await win.getByRole('button',{name:'Retry',exact:true}).click();await win.getByRole('button',{name:'Stop generation',exact:true}).waitFor();await done();checks.push('retry succeeds');
 await win.locator('input[type=file]').setInputFiles({name:'file.txt',mimeType:'text/plain',buffer:Buffer.from('Marigold')});await send('Explain the file');assert.match(JSON.stringify(requests.at(-1).messages),/Marigold/);checks.push('attachment context');
 await win.getByRole('button',{name:/^Rename /}).first().click();await win.getByRole('textbox',{name:'Chat name'}).fill('Saved chat');await win.getByRole('button',{name:'Save',exact:true}).click();await win.getByRole('textbox',{name:'Search chats'}).fill('Saved');await win.locator('.chat-history-title').waitFor();assert.equal(await win.locator('.chat-history-title').count(),1);await win.getByRole('textbox',{name:'Search chats'}).fill('Marigold');await win.locator('.chat-history-title').waitFor();assert.equal(await win.locator('.chat-history-title').count(),1);await win.getByRole('textbox',{name:'Search chats'}).fill('absent');await win.locator('.chat-history-title').waitFor({state:'hidden'});assert.equal(await win.locator('.chat-history-title').count(),0);await win.getByRole('textbox',{name:'Search chats'}).fill('');checks.push('rename and search');
 await win.screenshot({path:path.join(folder,'chat.png')});
 await win.getByRole('button',{name:'Build',exact:true}).click();await win.locator('#composer-input').waitFor();assert.equal(await win.locator('#chat-input').isVisible(),false);await win.locator('#composer-input').fill('Research Nxteraa');await win.getByRole('button',{name:'Run',exact:true}).click();await win.locator('#chat-input').waitFor();assert.equal(await win.locator('#chat-input').inputValue(),'Research Nxteraa');assert.equal((await inv('projects:list')).length,0);checks.push('Build research returns to Chat without project');
 await win.getByRole('button',{name:'Build',exact:true}).click();await win.screenshot({path:path.join(folder,'build-empty.png')});await win.getByRole('button',{name:'Chat',exact:true}).click();checks.push('mode separation');
 await win.reload();await win.locator('#chat-input').waitFor();await win.locator('.chat-message').first().waitFor();checks.push('restart defaults Chat and restores conversation');
 await win.getByRole('button',{name:'New chat',exact:true}).click();await win.locator('.chat-empty').waitFor();checks.push('new chat');
 await win.getByRole('button',{name:'Delete New chat',exact:true}).click();checks.push('delete chat');
 assert.deepEqual(errors,[]);console.log('PASS',checks);fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify({checks,errors,provider:'controlled HTTP fixture; real Electron/UI/IPC/router'},null,2));
}catch(e){console.error(e);await win.screenshot({path:path.join(folder,'failure.png')});fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify({checks,errors,failure:String(e)},null,2));process.exitCode=1;}finally{await app.close();server.closeAllConnections();server.close();console.log('REPORT',folder);}
