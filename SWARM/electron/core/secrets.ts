// API keys never leave the main process. They are encrypted with the OS keychain
// (Electron safeStorage / DPAPI on Windows) before being written to SQLite.
import { safeStorage } from 'electron';
import { db } from './db';
import { registerSecret } from './util';

const ENV_KEYS: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NGC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
};

export function setSecret(id: string, value: string | null) {
  if(!id.startsWith('account.')) {const disabled=JSON.parse(db().kvGet('account.disabledProviders')||'[]') as string[];db().kvSet('account.disabledProviders',JSON.stringify(disabled.filter(p=>p!==id)));}
  if (!value) { db().prepare('DELETE FROM secrets WHERE id = ?').run(id); return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable. No credential was saved.');
  const enc = safeStorage.encryptString(value);
  db().prepare('INSERT INTO secrets(id, value) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(id, enc);
  registerSecret(value);
}

export function getStoredSecret(id: string): string | null {
  const row = db().prepare('SELECT value FROM secrets WHERE id = ?').get(id) as { value: Uint8Array } | undefined;
  if (!row) return null;
  const buf = Buffer.from(row.value);
  const asText = buf.toString('utf8');
  if (asText.startsWith('plain:')) {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const value = asText.slice(6); setSecret(id, value); return value;
  }
  try { return safeStorage.decryptString(buf); } catch { return null; }
}

export function getSecret(id: string, allowEnv: boolean): { value: string; source: 'settings' | 'env' } | null {
  const stored = getStoredSecret(id);
  if (stored) { registerSecret(stored); return { value: stored, source: 'settings' }; }
  if (allowEnv && !(JSON.parse(db().kvGet('account.disabledProviders')||'[]') as string[]).includes(id)) {
    for (const k of ENV_KEYS[id] ?? []) {
      const v = process.env[k];
      if (v) { registerSecret(v); return { value: v, source: 'env' }; }
    }
  }
  return null;
}

export const mask = (v: string | null | undefined) => (v ? '••••' + v.slice(-4) : null);
