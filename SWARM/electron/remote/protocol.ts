// SWARM Remote Protocol v1 - shared constants and pure crypto helpers.
// Spec: docs/REMOTE_PROTOCOL.md. This file has no Electron dependency so it can be unit-tested.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47821;
export const PAIR_TOKEN_TTL_MS = 120_000;
export const PAIR_MAX_FAILED = 5;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_SKEW_MS = 60_000;
export const NONCE_TTL_MS = 5 * 60_000;
export const WS_PATH = '/v1/ws';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const randomB64Url = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison (length is not secret here: both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Canonical string a phone signs for every request (REST and WebSocket upgrade). */
export function canonicalRequest(method: string, target: string, timestamp: string, nonce: string, deviceId: string, body: Buffer | string): string {
  return ['SWARM-REQ-1', method.toUpperCase(), target, timestamp, nonce, deviceId, sha256Hex(body)].join('\n');
}

/** Canonical string signed at pairing to prove possession of the device key. */
export function canonicalPair(token: string, deviceId: string, publicKeyB64: string): string {
  return ['SWARM-PAIR-1', token, deviceId, publicKeyB64].join('\n');
}

/** 6-digit confirmation code both the phone and the PC can compute and compare by eye. */
export function pairCode(token: string, deviceId: string, publicKeyB64: string): string {
  const h = createHash('sha256').update(['SWARM-CODE-1', token, deviceId, publicKeyB64].join('\n')).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Parse an X.509 SPKI DER public key (base64) and require ECDSA P-256. Returns null if unacceptable. */
export function parsePublicKey(b64: string): KeyObject | null {
  try {
    if (typeof b64 !== 'string' || b64.length < 80 || b64.length > 400) return null;
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return key;
  } catch { return null; }
}

/** Verify a base64url DER ECDSA-SHA256 signature. */
export function verifySignature(publicKeyB64: string, message: string, signatureB64Url: string): boolean {
  try {
    const key = parsePublicKey(publicKeyB64);
    if (!key || typeof signatureB64Url !== 'string' || signatureB64Url.length > 200) return false;
    return cryptoVerify('sha256', Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64Url, 'base64url'));
  } catch { return false; }
}

export type AgentStatusRemote = 'idle' | 'running' | 'stopped' | 'error' | 'waiting';
export interface RemoteAgent { id: string; name: string; status: AgentStatusRemote; task: string | null; updatedAt: string }

/** Approval kinds that need an explicit `confirm: true` from the phone before they can be approved. */
export const HIGH_RISK_APPROVALS = new Set(['computer', 'fs_delete', 'install']);

/** Strict allow-list of existing IPC channels the phone may invoke generically. Everything else is refused. */
export const REMOTE_CHANNEL_ALLOWLIST = new Set([
  'projects:list', 'runs:active', 'runs:list', 'runs:snapshot', 'runs:events',
  'runs:start', 'runs:cancel', 'runs:pause', 'runs:resume',
  'run:chat:send', 'run:chat:agent:send',
  'approvals:list', 'approvals:resolve',
  'projects:create', 'chat:list', 'chat:new', 'chat:get', 'chat:send', 'chat:stop',
  'run:chat:history', 'run:chat:stop',
  'workspace:snapshot', 'workspace:file',
]);
/** Never exposed, even if someone adds it to the allow-list by mistake (defense in depth). */
export const REMOTE_CHANNEL_DENYLIST = new Set([
  'terminal:run', 'projects:writeFile', 'projects:deleteFile', 'projects:renameFile', 'projects:mkdir', 'providers:setKey', 'settings:update', 'settings:reset',
  'app:openPath', 'app:exportData', 'app:clearData', 'app:openExternal', 'projects:export', 'projects:readFile', 'remote:allowOtherNetworks', 'remote:enable', 'remote:revokeDevice', 'remote:confirmPair',
]);
