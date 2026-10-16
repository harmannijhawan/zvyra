/**
 * IPv4 address-class helpers and the "is the router's WAN address publicly reachable" classifier.
 *
 * Internal diagnostic only: it lets the connectivity manager skip a mapped endpoint that
 * cannot accept inbound connections from the internet. Nothing here is user-facing.
 */

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** RFC 1918 private ranges. */
export function isRfc1918(ip: string): boolean {
  return inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16);
}

/** RFC 6598 shared address space 100.64.0.0/10. */
export function isSharedAddressSpace(ip: string): boolean {
  return inCidr(ip, '100.64.0.0', 10);
}

export function isLinkLocalV4(ip: string): boolean {
  return inCidr(ip, '169.254.0.0', 16);
}

export function isLoopbackV4(ip: string): boolean {
  return inCidr(ip, '127.0.0.0', 8);
}

/** Anything that is not a routable, publicly assigned IPv4 unicast address. */
export function isNonPublicIPv4(ip: string): boolean {
  if (ipv4ToInt(ip) === null) return true;
  return (
    isRfc1918(ip) ||
    isSharedAddressSpace(ip) ||
    isLinkLocalV4(ip) ||
    isLoopbackV4(ip) ||
    inCidr(ip, '0.0.0.0', 8) ||
    inCidr(ip, '192.0.0.0', 24) ||
    inCidr(ip, '224.0.0.0', 3) // multicast + reserved + broadcast
  );
}

export type PublicAddressVerdict = 'yes' | 'no' | 'unknown';

export interface WanClassification {
  /**
   * 'yes'     -> router WAN address is a public address and matches what an outside observer sees
   * 'no'      -> a mapping on this router would NOT be reachable from the internet
   * 'unknown' -> not enough information
   */
  publicAddress: PublicAddressVerdict;
  reason: string;
}

/**
 * @param routerWanIp WAN/external IPv4 reported by the router (UPnP GetExternalIPAddress or NAT-PMP), if any
 * @param stunPublicIp IPv4 observed by an outside STUN server, if any
 */
export function classifyWan(input: { routerWanIp?: string | null; stunPublicIp?: string | null }): WanClassification {
  const router = input.routerWanIp?.trim() || null;
  const stun = input.stunPublicIp?.trim() || null;

  if (router && ipv4ToInt(router) !== null && router !== '0.0.0.0') {
    if (isNonPublicIPv4(router)) {
      return { publicAddress: 'no', reason: `router WAN address ${router} is not a public address` };
    }
    if (stun) {
      if (stun === router) return { publicAddress: 'yes', reason: `router WAN address ${router} matches the address seen by STUN` };
      return { publicAddress: 'no', reason: `router WAN address ${router} differs from the address seen by STUN (${stun})` };
    }
    return { publicAddress: 'unknown', reason: `router WAN address ${router} looks public but STUN gave no address to compare` };
  }
  if (router === '0.0.0.0') {
    return { publicAddress: 'no', reason: 'router reports no WAN address (0.0.0.0)' };
  }
  if (stun) {
    return { publicAddress: 'unknown', reason: 'router did not report a WAN address (no UPnP/NAT-PMP), cannot compare with STUN' };
  }
  return { publicAddress: 'unknown', reason: 'no router WAN address and no STUN result' };
}