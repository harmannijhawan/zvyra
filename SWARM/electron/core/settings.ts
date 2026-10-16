import { defaultSettings, mergeSettings, SettingsSchema, type Settings } from '../../shared/settings';
import { db } from './db';
import { bus } from './bus';

let current: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export function getSettings(): Settings {
  if (current) return current;
  const raw = db().kvGet('settings');
  if (raw) {
    const parsed = SettingsSchema.safeParse(JSON.parse(raw));
    current = parsed.success ? parsed.data : mergeSettings(defaultSettings(), JSON.parse(raw));
  } else current = defaultSettings();
  return current;
}

export function updateSettings(patch: unknown): Settings {
  const next = mergeSettings(getSettings(), patch);
  // Free mode cannot be disabled while no paid-provider billing exists in this build.
  next.ai.freeMode = true;
  current = next;
  db().kvSet('settings', JSON.stringify(next));
  bus.debug = next.logs.level === 'debug';
  bus.persist = next.privacy.storeLogs;
  for (const l of listeners) l(next);
  bus.send('settings:changed', next);
  return next;
}

export function resetSettings(section?: keyof Settings): Settings {
  const defs = defaultSettings();
  if (!section) return updateSettings(defs);
  return updateSettings({ [section]: defs[section] });
}

export function onSettings(fn: (s: Settings) => void) { listeners.add(fn); return () => listeners.delete(fn); }
