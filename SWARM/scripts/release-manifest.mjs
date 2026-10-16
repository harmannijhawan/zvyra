import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Candidate metadata is deliberately separate from published download metadata.
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dirty=!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
const artifacts=[];
for(const [platform,file,identity] of [
  ['windows',`release/SWARM-AI-Setup-${version}.exe`,'ai.swarm.desktop'],
  ['android','app/build/outputs/apk/debug/app-debug.apk','com.swarm.ai'],
]) {
  const bytes=readFileSync(file);if(!bytes.length)throw new Error('Empty artifact: '+file);
  artifacts.push({platform,version,identity,path:resolve(file),size:statSync(file).size,sha256:createHash('sha256').update(bytes).digest('hex'),url:null,published:false,signing:platform==='android'?'debug-only':'verify-authenticode-separately'});
}
mkdirSync('release',{recursive:true});
writeFileSync(`release/manifest-${version}.candidate.json`,JSON.stringify({version,buildCommit:commit,workingTreeDirty:dirty,releaseDate:new Date().toISOString(),status:'candidate-not-published',artifacts},null,2)+'\n');
console.log(JSON.stringify(artifacts,null,2));
