import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../swarm-web-publish/package.json',import.meta.url));
const {unzipSync}=require('fflate');
const names=['OPENAI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','NVIDIA_API_KEY','CLERK_SECRET_KEY','SWARM_ENCRYPTION_KEY','SWARM_ANDROID_STORE_PASSWORD','SWARM_ANDROID_KEY_PASSWORD'];
const secrets=names.filter(n=>process.env[n]?.length>=8).map(n=>[n,Buffer.from(process.env[n])]);
let scanned=0;
function scan(file,bytes){scanned++;for(const [name,value]of secrets)if(Buffer.from(bytes).includes(value))throw new Error('Secret value detected in '+file+' ('+name+'); value withheld.');}
function tree(dir){for(const name of readdirSync(dir)){const file=join(dir,name);if(statSync(file).isDirectory())tree(file);else scan(file,readFileSync(file));}}
tree('dist');tree('swarm-web-publish/.next/static');
scan('app.asar',readFileSync('release/win-unpacked/resources/app.asar'));
const apk=unzipSync(new Uint8Array(readFileSync('app/build/outputs/apk/debug/app-debug.apk')),{filter:entry=>/\.(dex|js|json|html|xml|txt|properties)$/.test(entry.name)});
for(const [name,bytes]of Object.entries(apk))scan('apk:'+name,bytes);
console.log(`Scanned ${scanned} bundled files/entries for ${secrets.length} configured secret values; no matches. This is a targeted scan, not a proof of absence of all possible secrets.`);
