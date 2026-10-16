#!/usr/bin/env node
// Diagnostic probe for electron/remote/connectivity. Bundles the module with esbuild into a temp
// file and runs it. By default NOTHING is mapped (read-only: SSDP search, UPnP/NAT-PMP address
// queries, STUN). With --map it opens a throw-away TCP listener, asks the router to forward it,
// verifies the mapping, then deletes the mapping and verifies the deletion.
//
//   node scripts/connectivity-probe.mjs [--map] [--port N] [--json]
import { build } from 'esbuild';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const map = args.includes('--map');
const portArg = args.indexOf('--port');
const fixedPort = portArg >= 0 ? Number(args[portArg + 1]) : 0;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-conn-'));
const outfile = path.join(tmp, 'connectivity.cjs');
await build({
  entryPoints: [path.join(root, 'electron/remote/connectivity/index.ts')],
  outfile, bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'error',
});
const mod = (await import(pathToFileURL(outfile).href)).default ?? (await import(pathToFileURL(outfile).href));
const { ConnectivityManager, startTestListener, selfTestPort, upnpClient } = mod;

const out = { mode: map ? 'map' : 'diagnostic' };
let listener = null;
let manager = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { await manager?.stop(); } catch (e) { out.stopError = String(e); }
  try { await listener?.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('SIGINT', () => cleanup().finally(() => process.exit(130)));

try {
  let port = 47821;
  if (map) {
    listener = await startTestListener(fixedPort, '0.0.0.0');
    port = listener.port;
    out.testListenerPort = port;
  } else if (fixedPort) port = fixedPort;

  manager = new ConnectivityManager({ mapPorts: map });
  const t0 = Date.now();
  await manager.start(port);
  out.probeMs = Date.now() - t0;
  out.status = manager.getStatus();
  out.candidateEndpoints = await manager.getCandidateEndpoints(port);

  if (map) {
    out.verifyWhileMapped = await manager.verifyMappings();
    const st = out.status;
    const m = [st.upnp, st.natpmp].find((x) => x.mapped);
    if (m?.externalIp) {
      // informational only: many routers do not loop back to their own public address
      out.hairpinSelfTest = await selfTestPort({ host: m.externalIp, port: m.externalPort, timeoutMs: 3000, via: 'public' });
    }
    const upnpHeld = st.upnp.mapped ? st.upnp.externalPort : null;
    await manager.stop();
    cleaned = true; // manager stopped; still close listener below
    out.afterStop = manager.getStatus().upnp.mapped === false && manager.getStatus().natpmp.mapped === false;
    if (upnpHeld) {
      try {
        const gw = await upnpClient.discoverGateway();
        const left = await upnpClient.getSpecificPortMapping(gw, upnpHeld, 'TCP');
        out.upnpMappingAfterDelete = left === null ? 'gone (verified: no entry for the port)' : { stillPresent: left };
      } catch (e) {
        out.upnpMappingAfterDelete = `could not verify: ${e.message}`;
      }
    } else if (st.natpmp.mapped) {
      out.natpmpNote = 'NAT-PMP mapping deleted via lifetime 0 request; the protocol has no query to verify.';
    }
    await listener.close();
    listener = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} catch (e) {
  out.fatal = String(e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await cleanup();
}
console.log(JSON.stringify(out, null, 2));