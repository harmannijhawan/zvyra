const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zvyra-electron-smoke-'));
app.setPath('userData', directory);
app.whenReady().then(async () => {
  let backend;
  try {
    const { createUiBackend } = require('../dist/ui.cjs');
    backend = await createUiBackend({ userDataPath:directory,appVersion:'smoke',isPackaged:false,resourcesPath:directory,getFocusedWindow:()=>null,logger:{info(){},warn(){},debug(){},error(){}} });
    const info=await backend.invoke('system.info');
    await backend.invoke('voice.configureEngine',{engineId:'windows-stt',values:{language:'en-GB'}});
    const diagnostics=await backend.invoke('system.diagnostics');
    const c=await backend.invoke('chat.create',{title:'Electron persistence smoke'});
    const persisted=(await backend.invoke('chat.list',{})).some(item=>item.id===c.id);
    const calls=await backend.invoke('calls.status');
    let live;
    if(process.argv.includes('--live')) {
      await backend.invoke('swarm.configure',{baseUrl:'swarm://embedded/groq'});
      live=await backend.invoke('swarm.test');
      const reread=await backend.invoke('swarm.connection');
      live.persistedStatus=reread.status;
      if(live.status==='connected') {
        const chat=await backend.invoke('chat.create',{});
        await backend.invoke('chat.send',{conversationId:chat.id,text:'Reply with exactly: ZVYRA backend connected.'});
        const until=Date.now()+15000;
        let last;
        do { await new Promise(resolve=>setTimeout(resolve,100)); last=(await backend.invoke('chat.messages',{id:chat.id})).at(-1); } while(last.status==='streaming'&&Date.now()<until);
        live.chat={status:last.status,model:last.model,hasResponse:!!last.content,error:last.error};
        await backend.invoke('chat.stop',{conversationId:chat.id});
      }
    }
    const result={ok:info.backend==='SWARM embedded'&&persisted&&!calls.configured,info,diagnostics,persisted,dbExists:fs.existsSync(path.join(directory,'zvyra.db')),live};
    fs.writeFileSync(path.join(__dirname,'../smoke-result.json'),JSON.stringify(result,null,2));
    await backend.dispose();app.exit(result.ok?0:1);
  } catch(error) {
    fs.writeFileSync(path.join(__dirname,'../smoke-result.json'),JSON.stringify({ok:false,error:String(error),stack:error.stack},null,2));
    await backend?.dispose?.();app.exit(1);
  }
});
