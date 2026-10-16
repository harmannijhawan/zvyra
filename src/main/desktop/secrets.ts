/**
 * OWNER: Kiro. Encrypted secrets via Electron safeStorage (Windows DPAPI).
 * Refuses to store anything when encryption is unavailable — no plaintext fallback.
 */
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { ZvyraError } from '../../shared/contract'
import { JsonDoc } from './jsonDoc'

export class SecretStore {
  private doc: JsonDoc<{ values: Record<string, string> }>

  constructor(userDataPath: string) {
    this.doc = new JsonDoc(join(userDataPath, 'desktop', 'secrets.json'), { values: {} })
  }

  has(key: string) {
    return !!this.doc.get().values[key]
  }

  get(key: string): string | null {
    const enc = this.doc.get().values[key]
    if (!enc || !safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }

  set(key: string, value: string | null) {
    const values = { ...this.doc.get().values }
    if (!value) delete values[key]
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new ZvyraError('UNAVAILABLE', 'Secure credential storage is not available on this system')
      values[key] = safeStorage.encryptString(value).toString('base64')
    }
    this.doc.set({ values })
  }

  flush() {
    return this.doc.flush()
  }
}
