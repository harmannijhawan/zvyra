import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Upload immutable, versioned downloads; switch website configuration separately.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const envFile = process.argv[2];
if (!envFile) throw new Error('Provide the production environment file path.');
const token = parseEnv(readFileSync(envFile, 'utf8')).BLOB_READ_WRITE_TOKEN;
if (!token || token === '[SENSITIVE]') throw new Error('Blob upload credentials unavailable.');
const { put } = await import(pathToFileURL(join(process.env.APPDATA, 'npm/node_modules/vercel/node_modules/@vercel/blob/dist/index.js')).href);
const artifacts = [];
for (const [platform, file, name, signing] of [
  ['windows', `release/SWARM-AI-Setup-${version}.exe`, 'SWARM-AI-Setup.exe', 'unsigned'],
  ['android', 'app/build/outputs/apk/debug/app-debug.apk', 'SWARM-AI.apk', 'android-debug'],
]) {
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await put(`downloads/v${version}/${name}`, createReadStream(file), {
    token, access: 'public', addRandomSuffix: false, allowOverwrite: false, multipart: true,
    contentType: platform === 'android' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
  });
  const response = await fetch(result.url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${platform}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; }
  if (size !== bytes.length || hash.digest('hex') !== sha256) throw new Error(`Download mismatch: ${platform}`);
  artifacts.push({ platform, version, file, url: result.url, size, sha256, signing });
  console.log(`${platform}: uploaded and public SHA-256 verified (${size} bytes)`);
  writeFileSync(`release/downloads-${version}.json`, JSON.stringify({ version, artifacts }, null, 2) + '\n');
}
