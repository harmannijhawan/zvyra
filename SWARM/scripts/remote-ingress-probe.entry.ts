// Controlled network diagnostic using the production HTTPS / ECDSA / WebSocket server.
// A throwaway pairing is kept only in memory and temporary storage. No desktop input is sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateCert } from '../electron/remote/cert';
import { DeviceStore } from '../electron/remote/devices';
import { PairingManager } from '../electron/remote/pairing';
import { Gateway } from '../electron/remote/gateway';
import { RemoteServer } from '../electron/remote/server';
import { ConnectivityManager } from '../electron/remote/connectivity';
import { FakePhone } from '../tests/helpers/remoteClient';

async function main() {
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-ingress-'));
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] ?? 47821);
const external = process.argv.includes('--external');
const output = path.resolve('_perf', 'workspace-ingress-report.json');
const report: Record<string, any> = { at: new Date().toISOString(), port, origin: 'PC', cellularVerified: false, externalRequested: external };
const tls = await loadOrCreateCert(path.join(directory, 'tls.json'));
const pairing = new PairingManager();
const connectivity = new ConnectivityManager({ mapPorts: false });
const server = new RemoteServer({ tls, port, pcName: os.hostname(), devices: new DeviceStore(path.join(directory, 'devices.json')), pairing,
  // Agent state is irrelevant to this network diagnostic; the real transport / auth code is unchanged.
  gateway: new Gateway(async () => [], { pcName: os.hostname(), appVersion: 'network-diagnostic' }), confirmPair: async () => true,
  getHosts: async () => connectivity.getCandidateEndpoints(port) });
try {
  await server.start();
  await connectivity.start(port);
  report.connectivity = connectivity.getStatus();
  report.hosts = await connectivity.getCandidateEndpoints(port);
  const phone = new FakePhone(port, tls.fingerprint);
  const pair = await phone.request('POST', '/v1/pair', { body: phone.pairBody(pairing.generate().token) });
  if (pair.status !== 200) throw new Error(`Diagnostic pairing failed: HTTP ${pair.status}`);
  phone.secret = pair.json.deviceSecret;
  report.routes = [];
  for (const host of ['::1', ...report.connectivity.lan, ...report.connectivity.ipv6.addresses]) {
    phone.host = host;
    const status = await phone.request('GET', '/v1/status', { signed: true });
    const diagnostics = await phone.request('GET', '/v1/diagnostics', { signed: true });
    const websocket = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = phone.ws();
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket timeout')); }, 5000);
      socket.on('error', reject);
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'hello') { clearTimeout(timeout); socket.close(); resolve({ hello: true, authenticated: true, certificatePinned: true }); }
      });
    });
    report.routes.push({ host, tcpTlsAndAuthentication: status.status === 200, websocket, listener: diagnostics.json.listener, origin: 'same PC' });
  }
  if (external && report.connectivity.ipv6.addresses.length) {
    const nodes = ['de1.node.check-host.net', 'ir2.node.check-host.net', 'us1.node.check-host.net'];
    const host = report.connectivity.ipv6.addresses[0];
    // The third-party API rejects IPv6 literal URL syntax. AAAA-only names test IPv6 capability.
    const targets = { pc: `${host.replaceAll(':', '-')}.sslip.io:${port}`, ipv6Control: 'ipv6.google.com:443', ipv4Control: '1.1.1.1:443' };
    const requests = await Promise.all(Object.entries(targets).map(async ([kind, target]) => {
      const url = new URL('https://check-host.net/check-tcp');
      url.searchParams.set('host', target); nodes.forEach(node => url.searchParams.append('node', node));
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`External probe returned HTTP ${response.status}`);
      return { kind, target, ...(await response.json() as Record<string, any>) };
    }));
    await new Promise(resolve => setTimeout(resolve, 18000));
    report.external = await Promise.all(requests.map(async request => ({ ...request, result: request.request_id ? await (await fetch(`https://check-host.net/check-result/${request.request_id}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })).json() : undefined })));
    const positive = report.external.find((result: any) => result.kind === 'ipv6Control');
    const capable = Object.entries(positive?.result ?? {}).filter(([, result]) => Array.isArray(result) && result.some((item: any) => item?.time !== undefined && !item.error)).map(([node]) => node);
    report.externalIpv6CapableNodes = capable;
    report.externalConclusion = capable.length ? 'Only results from IPv6-positive control nodes are valid ingress evidence; a TCP timeout does not identify router versus ISP filtering.' : 'INCONCLUSIVE: external nodes failed the IPv6-positive control. Their PC timeouts cannot verify or disprove public IPv6 ingress.';
  }
  report.localStackVerified = report.routes.every((route: any) => route.tcpTlsAndAuthentication && route.websocket.hello);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await server.stop(); await connectivity.stop();
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, localStackVerified: report.localStackVerified, externalConclusion: report.externalConclusion, error: report.error }));
}
}
void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
