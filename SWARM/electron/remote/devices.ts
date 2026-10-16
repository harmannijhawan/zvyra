// Paired-device store. Only a salted SHA-256 hash of each device secret is persisted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomB64Url } from './protocol';

export interface StoredDevice {
  id: string;
  name: string;
  /** base64 X.509 SPKI DER of the phone's ECDSA P-256 public key */
  publicKey: string;
  salt: string;
  hash: string;
  pairedAt: number;
  lastSeen: number | null;
}
export type PublicDevice = Pick<StoredDevice, 'id' | 'name' | 'pairedAt' | 'lastSeen'>;

export const hashSecret = (secret: string, salt: string): Buffer => createHash('sha256').update(salt).update('\0').update(secret).digest();

const DUMMY_SALT = randomBytes(16).toString('base64url');

export class DeviceStore {
  private devices: StoredDevice[] = [];
  private lastSave = 0;
  private revokeListeners = new Set<(id: string) => void>();

  /** `file` null = in-memory only (tests). */
  constructor(private file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredDevice[];
        if (Array.isArray(raw)) this.devices = raw.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string');
      } catch { /* corrupt file: start empty (all phones must re-pair) */ }
    }
  }

  private save(force = true) {
    if (!this.file) return;
    const now = Date.now();
    if (!force && now - this.lastSave < 30_000) return;
    this.lastSave = now;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
  }

  has(id: string) { return this.devices.some((d) => d.id === id); }

  /** Registers a device and returns the plaintext secret (shown to the phone once, never stored). */
  add(input: { id: string; name: string; publicKey: string }): { device: PublicDevice; secret: string } {
    if (this.has(input.id)) throw new Error('device_exists');
    const secret = randomB64Url(32);
    const salt = randomB64Url(16);
    const d: StoredDevice = {
      id: input.id, name: input.name.slice(0, 80), publicKey: input.publicKey, salt,
      hash: hashSecret(secret, salt).toString('hex'), pairedAt: Date.now(), lastSeen: null,
    };
    this.devices.push(d);
    this.save();
    return { device: pub(d), secret };
  }

  /** Constant-time secret check. Returns the stored device (incl. public key) or null. */
  verify(id: string, secret: string): StoredDevice | null {
    const d = this.devices.find((x) => x.id === id) ?? null;
    const salt = d?.salt ?? DUMMY_SALT; // always do the hashing work so unknown ids are not distinguishable by timing
    const got = hashSecret(typeof secret === 'string' ? secret : '', salt);
    const want = d ? Buffer.from(d.hash, 'hex') : Buffer.alloc(32);
    const ok = got.length === want.length && timingSafeEqual(got, want);
    return d && ok ? d : null;
  }

  touch(id: string) {
    const d = this.devices.find((x) => x.id === id);
    if (d) { d.lastSeen = Date.now(); this.save(false); }
  }

  list(): PublicDevice[] { return this.devices.map(pub); }

  revoke(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === n) return false;
    this.save();
    for (const fn of this.revokeListeners) fn(id);
    return true;
  }

  onRevoke(fn: (id: string) => void) { this.revokeListeners.add(fn); return () => this.revokeListeners.delete(fn); }
}

function pub(d: StoredDevice): PublicDevice { return { id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen }; }