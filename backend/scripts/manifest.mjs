import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const original=process.argv[2];
if(!original)throw new Error('Pass the original SWARM folder');
const destination=path.resolve('../SWARM');
const files=[];
function walk(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){if(item.name==='node_modules'||item.name==='dist'||item.isSymbolicLink())continue;const full=path.join(directory,item.name);if(item.isDirectory())walk(full);else if(item.isFile()&&!['SOURCE-MANIFEST.json','.gitignore'].includes(item.name)){const relative=path.relative(destination,full).replaceAll('\\','/');const source=path.join(original,relative);if(fs.existsSync(source)){const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');files.push({path:relative,sourceSha256:hash(source),integratedSha256:hash(full)});}}}}
walk(destination);
fs.writeFileSync(path.join(destination,'SOURCE-MANIFEST.json'),JSON.stringify({source:path.resolve(original),version:'1.0.6',copiedAt:new Date().toISOString(),files},null,2));
console.log(JSON.stringify({files:files.length,modified:files.filter(f=>f.sourceSha256!==f.integratedSha256).map(f=>f.path)}));
