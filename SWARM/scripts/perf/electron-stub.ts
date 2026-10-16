// Stand-in for the `electron` module so main-process code runs under plain Node in perf benches.
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = { getAllWindows: () => [] as unknown[] };
export class Notification { static isSupported() { return false; } }
export const app = { getPath: () => '.', getVersion: () => '0.0.0', isPackaged: false };
export const shell = { openExternal: async () => undefined };
export default { safeStorage, BrowserWindow, Notification, app, shell };
