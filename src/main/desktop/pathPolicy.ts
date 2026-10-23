/**
 * OWNER: Kiro. Where ZVYRA's agent may read and write (pure, unit-tested).
 *
 * The user decides where work happens: any drive, any folder, paths with
 * spaces. There is no project allowlist. What stays off-limits is what the
 * operating system itself protects or what belongs to someone else:
 *  - Windows, Program Files, ProgramData and other system folders (writes),
 *  - other people's profiles under C:\Users (reads and writes),
 *  - the root of a drive and the user's whole profile folder as a write target.
 * Real access errors (permissions, read-only media, locked files) are reported
 * by `explainFsError` instead of being guessed.
 */
import { win32 } from 'node:path'

export interface PathContext {
  home: string
  env: Record<string, string | undefined>
}

const n = (p: string) => win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
const inside = (root: string, p: string) => {
  const r = n(root)
  const t = n(p)
  return t === r || t.startsWith(r.endsWith('\\') ? r : `${r}\\`)
}

function systemRoots(ctx: PathContext): string[] {
  const e = ctx.env
  const drive = (e['SystemDrive'] ?? 'C:') + '\\'
  return [
    e['SystemRoot'] ?? e['windir'] ?? win32.join(drive, 'Windows'),
    e['ProgramFiles'] ?? win32.join(drive, 'Program Files'),
    e['ProgramFiles(x86)'] ?? win32.join(drive, 'Program Files (x86)'),
    e['ProgramW6432'] ?? '',
    e['ProgramData'] ?? win32.join(drive, 'ProgramData'),
    win32.join(drive, 'System Volume Information'),
    win32.join(drive, '$Recycle.Bin'),
    win32.join(drive, 'Recovery'),
    win32.join(drive, 'Boot')
  ].filter(Boolean)
}

/** Null when allowed; otherwise a one-sentence reason. `p` must be absolute. */
export function pathBlockReason(p: string, mode: 'read' | 'write', ctx: PathContext): string | null {
  if (!win32.isAbsolute(p)) return `“${p}” is not an absolute path.`
  if (/^\\\\[?.]\\/.test(p)) return 'Device paths (\\\\?\\, \\\\.\\) are not allowed.'
  const usersDir = win32.dirname(ctx.home)
  const pub = win32.join(usersDir, 'Public')
  // Another person's profile on this PC.
  if (inside(usersDir, p) && !inside(ctx.home, p) && !inside(pub, p) && n(p) !== n(usersDir)) {
    return `“${p}” is inside another user’s profile, which ZVYRA does not access.`
  }
  if (mode === 'write') {
    for (const r of systemRoots(ctx)) if (inside(r, p)) return `“${p}” is a protected Windows system folder (${r}). Choose a folder you own.`
    const root = win32.parse(p).root
    if (n(p) === n(root)) return `Refusing to write to the root of drive ${root} directly; use a folder on it.`
    if (n(p) === n(ctx.home) || n(p) === n(usersDir)) return 'Refusing to replace your whole profile folder; use a folder inside it.'
  }
  return null
}

export function assertPathAllowed(p: string, mode: 'read' | 'write', ctx: PathContext): string {
  const why = pathBlockReason(p, mode, ctx)
  if (why) throw new Error(why)
  return p
}

/** Turns a Node filesystem error into the real cause and the shortest safe fix. */
export function explainFsError(err: unknown, p: string): string {
  const e = err as NodeJS.ErrnoException
  switch (e?.code) {
    case 'ENOENT':
      return `Nothing exists at “${p}” (or a parent folder is missing).`
    case 'EACCES':
    case 'EPERM':
      return `Windows denied access to “${p}”. It may be read-only, owned by another account, protected by Controlled Folder Access (Windows Security → Ransomware protection → allow ZVYRA), or need administrator rights. ZVYRA did not change it.`
    case 'EBUSY':
      return `“${p}” is locked by another program (close the app that has it open and try again).`
    case 'EROFS':
      return `“${p}” is on a read-only drive.`
    case 'ENOSPC':
      return `The drive holding “${p}” is full.`
    case 'ENAMETOOLONG':
      return `The path “${p.slice(0, 80)}…” is too long for Windows (enable long paths or use a shorter folder).`
    case 'EISDIR':
      return `“${p}” is a folder, not a file.`
    case 'ENOTDIR':
      return `A part of “${p}” is a file, not a folder.`
    default:
      return `${e?.message ?? String(err)} (${p})`
  }
}
