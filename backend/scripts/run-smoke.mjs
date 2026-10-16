import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),['scripts/smoke.cjs',...process.argv.slice(2)],{cwd:process.cwd(),env,windowsHide:true,stdio:'inherit'});
const timer=setTimeout(()=>child.kill(),60000);
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
child.on('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;});
