// Real emulator -> signed TLS/WebSocket -> desktop capture. Pairing tokens stay ephemeral.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const directory = path.join(root, '.swarm-test', `mobile-remote-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const adb = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const command = args => execFileSync(adb, ['-s', 'emulator-5554', ...args], { encoding: 'utf8', timeout: 120000 });
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root, '--remote-diagnostic-host', '--no-model-check'], env: { ...process.env, SWARM_USER_DATA: directory, SWARM_DIAGNOSTIC_SOURCE_DB: path.join(process.env.APPDATA, 'swarm/swarm.db') } });
try {
  await app.firstWindow();
  const qr = JSON.parse(fs.readFileSync(path.join(root, '_perf/v3-diagnostic-pairing.json'), 'utf8'));
  const port = Number(qr.hosts[0].split(':').at(-1));
  command(['reverse', `tcp:${port}`, `tcp:${port}`]);
  qr.hosts = [`localhost:${port}`];
  command(['install', '-r', path.join(root, 'app/build/outputs/apk/debug/app-debug.apk')]);
  command(['install', '-r', path.join(root, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')]);
  const output = command(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'com.swarm.ai.RemotePipelineInstrumentedTest#storedPairingDesktop', '-e', 'pairingBase64', Buffer.from(JSON.stringify(qr)).toString('base64'), 'com.swarm.ai.test/androidx.test.runner.AndroidJUnitRunner']);
  fs.writeFileSync(path.join(directory, 'instrumentation.txt'), output);
  console.log(output);
  if (!output.includes('OK (1 test)')) throw new Error('Real remote pipeline instrumentation failed');
  console.log(command(['pull', '/sdcard/Android/data/com.swarm.ai/files/remote-pipeline.json', path.join(directory, 'remote-pipeline.json')]));
  const ui = command(['shell', 'am', 'instrument', '-w', '-r', '-e', 'class', 'com.swarm.ai.CompanionInstrumentedTest', 'com.swarm.ai.test/androidx.test.runner.AndroidJUnitRunner']);
  fs.writeFileSync(path.join(directory, 'ui-instrumentation.txt'), ui); console.log(ui);
  if (!ui.includes('OK (')) throw new Error('Mobile workspace UI instrumentation failed');
  command(['pull', '/sdcard/Android/data/com.swarm.ai/files/ui-rebuild', directory]);
  console.log('REPORT_DIRECTORY', directory);
} finally { await app.close(); }
