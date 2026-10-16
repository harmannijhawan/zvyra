// Real OS applications through the production Preview Manager and IPC boundary.
import { _electron as electron } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const root = process.cwd(), dir = path.join(root, '.swarm-test', 'overhaul-preview-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const native = path.join(dir, 'windows'), cli = path.join(dir, 'cli');
fs.mkdirSync(native); fs.mkdirSync(cli);
fs.writeFileSync(path.join(native, 'Fixture.cs'), 'using System; using System.Windows.Forms; class Fixture { [STAThread] static void Main() { var f=new Form(); f.Text="SWARM production preview QA"; f.Width=450; f.Height=280; var b=new Button {Text="Actual compiled executable",Width=300}; b.Click += (s,e) => b.Text="Interaction verified"; f.Controls.Add(b); Application.Run(f); } }');
await execute(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/out:' + path.join(native, 'Fixture.exe'), path.join(native, 'Fixture.cs')], { windowsHide: true });
fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: 'preview-cli', scripts: { start: 'node app.cjs' } }));
fs.writeFileSync(path.join(cli, 'app.cjs'), "process.stdout.write('Name: ');process.stdin.on('data',d=>{process.stdout.write('Hello '+d);process.stderr.write('diagnostic\\n');});");
const setup = new DatabaseSync(path.join(dir, 'swarm.db'));
setup.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
setup.prepare('INSERT INTO kv VALUES (?,?)').run('onboarded', '1');
setup.prepare('INSERT INTO kv VALUES (?,?)').run('settings', JSON.stringify({ providers: { useEnvKeys: false, enabled: Object.fromEntries(['nvidia','openrouter','groq','google','cloudflare','huggingface','cerebras','mistral','ollama'].map(p => [p,false])) }, routing: { healthCheckOnStartup: false, discoveryIntervalMin: 0 }, computer: { native: true }, workspace: { root: path.join(dir, 'projects') } }));
setup.close();
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--smoke'], env: { ...process.env, SWARM_USER_DATA: dir } });
const win = await app.firstWindow();
const inv = (channel, ...args) => win.evaluate(({channel,args}) => window.swarm.invoke(channel,...args), {channel,args});
const report = { dir, platforms: [], errors: [] };
win.on('pageerror', e => report.errors.push(e.message));
const wait = async (fn, timeout = 15000) => { const until = Date.now()+timeout; for (;;) { const value = await fn(); if (value) return value; if (Date.now()>until) throw Error('Condition timed out'); await new Promise(r=>setTimeout(r,100)); } };
try {
  await win.locator('#chat-input').waitFor();
  for (const [target, folder] of [['cli',cli],['windows',native],['android',path.join(root,'.swarm-test','overhaul-android')]]) {
    const p = await inv('projects:create', { name: target + ' actual preview QA', path: folder });
    const run = { id: 'preview-' + target, projectId: p.id, objective: 'Verify actual '+target+' preview', target, status: 'completed', startedAt: 0, endedAt: Date.now(), summary: 'Preview fixture', brief: null, gates: [], previewUrl: null, repairCycles: 0, options: { webResearch: false, autonomy: 'autonomous', attachments: [], pinnedModel: null }, stats: { tasks:0,completed:0,failed:0,modelCalls:0,fallbacks:0,tokens:0,files:0,commands:0,sources:0 } };
    const db = new DatabaseSync(path.join(dir,'swarm.db'));
    db.prepare('INSERT INTO runs (id,project_id,started_at,data) VALUES (?,?,?,?)').run(run.id,p.id,0,JSON.stringify(run)); db.close();
    const info = await inv('runtime:launch',run.id);
    assert.equal(info.type,target); assert.equal(info.state,'running');
    const evidence = { target, info, screenshot: false };
    if (target==='cli') {
      assert.equal(await inv('runtime:input',info.id,'Alice\n'),true);
      await wait(async()=> (await inv('runtime:getLogs',info.id)).stdout.includes('Hello Alice'));
      assert.match((await inv('runtime:getLogs',info.id)).stderr,/diagnostic/);
    } else {
      const image = await wait(async()=> { try { return await inv('runtime:screenshot',info.id); } catch { return null; } });
      assert.match(image,/^data:image\/png;base64,/);
      fs.writeFileSync(path.join(dir,target+'.png'),Buffer.from(image.split(',')[1],'base64'));
      evidence.screenshot=true;
      if (target==='android') {
        const adb = path.join(process.env.LOCALAPPDATA,'Android','Sdk','platform-tools','adb.exe');
        const hierarchy = async () => {
          await execute(adb,['shell','uiautomator','dump','/sdcard/swarm-qa.xml'],{windowsHide:true});
          return (await execute(adb,['shell','cat','/sdcard/swarm-qa.xml'],{windowsHide:true})).stdout;
        };
        // Process launch/screenshot availability precede Android's first interactive frame.
        await wait(async () => (await hierarchy()).includes('SWARM REAL ANDROID PREVIEW'));
        await inv('runtime:tap',info.id,500,700);
        const stdout = await wait(async () => { const xml = await hierarchy(); return xml.includes('Tap verified') ? xml : null; });
        assert.match(stdout,/Tap verified/); evidence.interaction=true;
      }
    }
    const oldPid=info.pid;
    await inv('runtime:stop',info.id);
    assert.equal((await inv('runtime:getInfo',run.id)).state,'stopped');
    await inv('runtime:restart',info.id);
    const restarted=await inv('runtime:getInfo',run.id);
    assert.equal(restarted.state,'running');
    if(oldPid)assert.notEqual(restarted.pid,oldPid);
    await inv('runtime:stop',info.id);
    report.platforms.push(evidence); console.log(JSON.stringify({target,passed:true,screenshot:evidence.screenshot}));
  }
  assert.equal(report.errors.length,0);
} catch(e) { report.failure=String(e); process.exitCode=1; console.error(String(e)); }
finally { fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)); await app.close(); console.log('REPORT '+path.join(dir,'report.json')); }
