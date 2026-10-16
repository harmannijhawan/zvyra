import { BrowserWindow, Notification } from 'electron';
import type { AppNotification, LogLevel } from '../../shared/types';
import { db } from './db';
import { bus, emit } from './bus';
import { getSettings } from './settings';
import { uid } from './util';

export type NotifyKind = 'complete' | 'fail' | 'approval' | 'browser_fail' | 'blocked' | 'fallback' | 'attention' | 'info';

const kindToSetting: Record<NotifyKind, keyof ReturnType<typeof getSettings>['notifications'] | null> = {
  complete: 'onComplete', fail: 'onFail', approval: 'onApproval', browser_fail: 'onBrowserFail',
  blocked: 'onBlocked', fallback: 'onFallback', attention: 'onBlocked', info: null,
};

export function notify(kind: NotifyKind, level: LogLevel, title: string, body: string, scope: { projectId?: string | null; runId?: string | null } = {}) {
  const s = getSettings().notifications;
  if (!s.enabled) return;
  const key = kindToSetting[kind];
  if (key && !s[key]) return;
  const n: AppNotification = { id: uid('nt_'), ts: Date.now(), level, title, body, projectId: scope.projectId ?? null, runId: scope.runId ?? null, read: false, kind };
  db().put('notifications', n.id, n, { ts: n.ts });
  bus.send('notification', n);
  emit('NOTIFICATION', title, scope, level, { body, kind });
  const win = BrowserWindow.getAllWindows()[0];
  if (s.desktop && Notification.isSupported() && (!win || !win.isFocused())) {
    try { new Notification({ title: `SWARM · ${title}`, body, silent: true }).show(); } catch { /* ignore */ }
  }
}

export function listNotifications(): AppNotification[] {
  return db().list<AppNotification>('notifications', '', [], 'ts DESC', 200);
}

export function markNotificationsRead() {
  for (const n of listNotifications()) if (!n.read) db().put('notifications', n.id, { ...n, read: true }, { ts: n.ts });
}

export function clearNotifications() { db().delete('notifications', '1 = 1', []); }
