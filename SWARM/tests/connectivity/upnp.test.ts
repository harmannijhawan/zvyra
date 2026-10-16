import { describe, expect, it } from 'vitest';
import {
  parseSsdpResponse, parseDeviceDescription, selectWanService, resolveControlUrl, buildSoapEnvelope, parseSoapResponse, parseSoapFault,
  discoverGateway, getExternalIPAddress, addPortMapping, deletePortMapping, getSpecificPortMapping, renewPortMapping,
  UpnpError, buildMSearch, type UpnpHttp, type UpnpGateway,
} from '../../electron/remote/connectivity/upnp';

const SSDP = [
  'HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=120', 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'USN: uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'Server: Linux/3.x UPnP/1.1 MiniUPnPd/2.1',
  'Location: http://192.168.1.1:5000/rootDesc.xml', '', '',
].join('\r\n');

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>http://192.168.1.1:5000/</URLBase>
<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>Home &amp; Router</friendlyName>
<manufacturer>Acme</manufacturer><modelName>X1</modelName>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service></serviceList>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList><device>
<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ctl/PPP</controlURL><SCPDURL>/ppp.xml</SCPDURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL><SCPDURL>/ip.xml</SCPDURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`;

const GW: UpnpGateway = { location: 'http://192.168.1.1:5000/rootDesc.xml', controlUrl: 'http://192.168.1.1:5000/ctl/IPConn', serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', localAddress: '192.168.1.20', gatewayIp: '192.168.1.1' };

const ok = (inner: string, action: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:x">${inner}</u:${action}Response></s:Body></s:Envelope>`;
const fault = (code: number) => `<s:Envelope xmlns:s="x"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>err</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

describe('SSDP', () => {
  it('parses a response', () => {
    const r = parseSsdpResponse(SSDP)!;
    expect(r.location).toBe('http://192.168.1.1:5000/rootDesc.xml');
    expect(r.server).toContain('MiniUPnPd');
  });
  it('ignores non-200 and location-less answers', () => {
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\nLOCATION: http://x\r\n\r\n')).toBeNull();
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: x\r\n\r\n')).toBeNull();
  });
  it('builds an M-SEARCH', () => {
    const m = buildMSearch('ssdp:all');
    expect(m).toContain('M-SEARCH * HTTP/1.1');
    expect(m).toContain('MAN: "ssdp:discover"');
    expect(m.endsWith('\r\n\r\n')).toBe(true);
  });
});

describe('device description', () => {
  it('lists services, decodes entities, prefers WANIPConnection', () => {
    const d = parseDeviceDescription(DESC);
    expect(d.friendlyName).toBe('Home & Router');
    expect(d.services.length).toBe(3);
    const svc = selectWanService(d.services)!;
    expect(svc.serviceType).toContain('WANIPConnection');
    expect(resolveControlUrl(svc.controlUrl, 'http://192.168.1.1:5000/rootDesc.xml', d.urlBase)).toBe('http://192.168.1.1:5000/ctl/IPConn');
  });
  it('returns null without a WAN service', () => {
    expect(selectWanService(parseDeviceDescription('<root></root>').services)).toBeNull();
  });
});

describe('SOAP', () => {
  it('builds an envelope with escaped args', () => {
    const x = buildSoapEnvelope('urn:schemas-upnp-org:service:WANIPConnection:1', 'AddPortMapping', [['NewPortMappingDescription', 'A&B']]);
    expect(x).toContain('<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">');
    expect(x).toContain('<NewPortMappingDescription>A&amp;B</NewPortMappingDescription>');
  });
  it('parses responses and faults', () => {
    expect(parseSoapResponse(ok('<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>', 'GetExternalIPAddress')).NewExternalIPAddress).toBe('203.0.113.7');
    expect(parseSoapFault(fault(718))).toEqual({ code: 718, description: 'err' });
    expect(parseSoapFault(ok('', 'X'))).toBeNull();
  });
});

function fakeHttp(handler: (url: string, body?: string, headers?: Record<string, string>) => { status: number; body: string }): UpnpHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (u) => { calls.push(`GET ${u}`); return handler(u); },
    post: async (u, h, b) => { calls.push(`POST ${h.SOAPAction}`); return handler(u, b, h); },
  };
}

describe('gateway discovery + actions (mock transport)', () => {
  it('discovers via description and uses the right control URL', async () => {
    const http = fakeHttp(() => ({ status: 200, body: DESC }));
    const gw = await discoverGateway({ http, search: async () => [{ ...parseSsdpResponse(SSDP)!, localAddress: '192.168.1.20', remoteAddress: '192.168.1.1' }] });
    expect(gw.controlUrl).toBe('http://192.168.1.1:5000/ctl/IPConn');
    expect(gw.localAddress).toBe('192.168.1.20');
  });
  it('fails clearly when nothing answers', async () => {
    await expect(discoverGateway({ search: async () => [] })).rejects.toMatchObject({ kind: 'no_gateway' });
  });
  it('refuses a forged public/loopback location', async () => {
    const http = fakeHttp(() => ({ status: 200, body: DESC }));
    for (const loc of ['http://8.8.8.8/d.xml', 'http://127.0.0.1/d.xml']) {
      await expect(discoverGateway({ http, search: async () => [{ location: loc, localAddress: '192.168.1.20', remoteAddress: '1.1.1.1' }] })).rejects.toMatchObject({ kind: 'unsafe' });
    }
    expect(http.calls).toEqual([]);
  });
  it('GetExternalIPAddress / Add / Delete / GetSpecific', async () => {
    const http = fakeHttp((_u, body, h) => {
      const a = h!.SOAPAction;
      if (a.includes('GetExternalIPAddress')) return { status: 200, body: ok('<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>', 'GetExternalIPAddress') };
      if (a.includes('AddPortMapping')) {
        expect(body).toContain('<NewInternalClient>192.168.1.20</NewInternalClient>');
        expect(body).toContain('<NewProtocol>TCP</NewProtocol>');
        expect(body).toContain('<NewLeaseDuration>3600</NewLeaseDuration>');
        expect(body).toContain('<NewPortMappingDescription>SWARM</NewPortMappingDescription>');
        return { status: 200, body: ok('', 'AddPortMapping') };
      }
      if (a.includes('GetSpecificPortMappingEntry')) return { status: 500, body: fault(714) };
      return { status: 200, body: ok('', 'DeletePortMapping') };
    });
    expect(await getExternalIPAddress(GW, http)).toBe('203.0.113.7');
    await addPortMapping(GW, { externalPort: 47821, internalPort: 47821 }, http);
    await deletePortMapping(GW, 47821, 'TCP', http);
    expect(await getSpecificPortMapping(GW, 47821, 'TCP', http)).toBeNull();
    expect(http.calls.some((c) => c.includes('#DeletePortMapping'))).toBe(true);
  });
  it('surfaces SOAP error codes and falls back to permanent lease on 725', async () => {
    let leases: string[] = [];
    const http = fakeHttp((_u, body) => {
      const lease = /<NewLeaseDuration>(\d+)</.exec(body ?? '')![1];
      leases.push(lease);
      return lease === '0' ? { status: 200, body: ok('', 'AddPortMapping') } : { status: 500, body: fault(725) };
    });
    await expect(addPortMapping(GW, { externalPort: 1, internalPort: 1 }, http)).rejects.toMatchObject({ kind: 'soap', code: 725 });
    leases = [];
    expect(await renewPortMapping(GW, { externalPort: 1, internalPort: 1 }, http)).toBe(0);
    expect(leases).toEqual(['3600', '0']);
  });
  it('reports existing mapping details', async () => {
    const http = fakeHttp(() => ({ status: 200, body: ok('<NewInternalPort>47821</NewInternalPort><NewInternalClient>192.168.1.20</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>SWARM</NewPortMappingDescription><NewLeaseDuration>3000</NewLeaseDuration>', 'GetSpecificPortMappingEntry') }));
    expect(await getSpecificPortMapping(GW, 47821, 'TCP', http)).toEqual({ internalClient: '192.168.1.20', internalPort: 47821, enabled: true, description: 'SWARM', leaseSeconds: 3000 });
  });
  it('UpnpError is an Error with kind', () => {
    const e = new UpnpError('timeout', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('timeout');
  });
});