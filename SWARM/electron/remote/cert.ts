// Self-signed TLS certificate, generated once and kept in userData. The phone pins its SHA-256 fingerprint.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generate } from 'selfsigned';

export interface TlsIdentity { key: string; cert: string; fingerprint: string }

export const fingerprintOf = (certPem: string): string => new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();

export async function loadOrCreateCert(file: string, commonName = 'SWARM Remote'): Promise<TlsIdentity> {
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { key: string; cert: string };
      const x = new X509Certificate(j.cert);
      if (j.key && new Date(x.validTo).getTime() > Date.now() + 30 * 86400_000) return { key: j.key, cert: j.cert, fingerprint: fingerprintOf(j.cert) };
    }
  } catch { /* regenerate */ }
  const notBeforeDate = new Date(Date.now() - 86400_000);
  const notAfterDate = new Date(Date.now() + 3650 * 86400_000);
  const pems = await generate([{ name: 'commonName', value: commonName }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate, notAfterDate });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key: pems.private, cert: pems.cert }), { mode: 0o600 });
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOf(pems.cert) };
}