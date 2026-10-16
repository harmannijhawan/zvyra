/**
 * OWNER: Kiro. Centralised risk classification for shell commands.
 *
 * Pure (no Electron / filesystem access) so it is unit-tested directly.
 * Commands are tokenised with shell-aware quoting (PowerShell or CMD), split
 * into statements on every separator (; | && || & newlines, script blocks,
 * sub-expressions, including "$( ... )" inside PowerShell strings) and each
 * statement is classified by its resolved program name and arguments, never
 * by substring matching on the raw text. File targets of write/delete
 * commands are resolved against the working folder and checked against
 * protected system locations and the user's authorised folders.
 *
 *   low      read-only / harmless: runs without asking
 *   medium   installs, project scripts, file writes, unfamiliar programs: asks
 *   high     deletes, registry, services, processes, system config: asks, never "always"
 *   critical security bypass, disk/boot tools, hidden or elevated execution: blocked
 */
import { win32 } from 'node:path'
import type { CommandShell } from '../../shared/contract'

export type CommandRisk = 'low' | 'medium' | 'high' | 'critical'

export interface CommandContext {
  /** Working folder (absolute). */
  cwd: string
  /** The user's profile folder. */
  home: string
  /** Folders ZVYRA may write to (home is implied). */
  allowedRoots: string[]
  /** Environment used to expand %VAR% / $env:VAR in paths. */
  env?: Record<string, string | undefined>
}

export interface CommandClassification {
  risk: CommandRisk
  /** Human-readable reasons, highest risk first. */
  reasons: string[]
  /** One line describing what the command does. */
  summary: string
  /** Resolved program names, in order. */
  programs: string[]
  /** Resolved file/folder targets of write or delete operations. */
  targets: string[]
}

const RANK: Record<CommandRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 }
export const riskAtMost = (r: CommandRisk, max: CommandRisk) => RANK[r] <= RANK[max]
const maxRisk = (a: CommandRisk, b: CommandRisk): CommandRisk => (RANK[a] >= RANK[b] ? a : b)

/* ================================================================ tokenizer */

export interface Token {
  text: string
  /** True when any part of the token was quoted (so it is data, not syntax). */
  quoted: boolean
}

export interface Parsed {
  statements: Token[][]
  /** Redirection targets (`> file`, `>> file`, `2> file`). */
  redirects: string[]
  /** Code found inside PowerShell "$( ... )" strings, classified separately. */
  nested: string[]
  /** Parse problems (unterminated quotes, ...). */
  problems: string[]
}

const PS_SEPARATORS = new Set([';', '|', '{', '}', '(', ')', '\n', '\r'])
const CMD_SEPARATORS = new Set(['&', '|', '(', ')', '\n', '\r'])

/** Splits a command line into statements of tokens, honouring the shell's quoting rules. */
export function tokenize(src: string, shell: CommandShell): Parsed {
  const statements: Token[][] = []
  const redirects: string[] = []
  const nested: string[] = []
  const problems: string[] = []
  const seps = shell === 'powershell' ? PS_SEPARATORS : CMD_SEPARATORS
  let current: Token[] = []
  let buf = ''
  let quoted = false
  let has = false
  let redirectNext = false

  const pushToken = () => {
    if (!has) return
    if (redirectNext) {
      redirects.push(buf)
      redirectNext = false
    } else current.push({ text: buf, quoted })
    buf = ''
    quoted = false
    has = false
  }
  const endStatement = () => {
    pushToken()
    if (current.length) statements.push(current)
    current = []
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    // ---- quotes
    if (c === "'" && shell === 'powershell') {
      const start = i
      i++
      let s = ''
      for (; i < src.length; i++) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'"
            i++
            continue
          }
          break
        }
        s += src[i]
      }
      if (i >= src.length) problems.push(`Unterminated quote at ${start}`)
      buf += s
      quoted = has = true
      continue
    }
    if (c === '"') {
      const start = i
      i++
      let s = ''
      for (; i < src.length; i++) {
        const d = src[i]
        if (shell === 'powershell' && d === '`' && i + 1 < src.length) {
          s += src[++i]
          continue
        }
        if (shell === 'powershell' && d === '$' && src[i + 1] === '(') {
          // Sub-expression inside a string runs code: capture it for separate classification.
          let depth = 0
          let j = i + 1
          for (; j < src.length; j++) {
            if (src[j] === '(') depth++
            else if (src[j] === ')' && --depth === 0) break
          }
          nested.push(src.slice(i + 2, j))
          s += '$(...)'
          i = j
          continue
        }
        if (d === '"') {
          if (shell === 'powershell' && src[i + 1] === '"') {
            s += '"'
            i++
            continue
          }
          break
        }
        s += d
      }
      if (i >= src.length) problems.push(`Unterminated quote at ${start}`)
      buf += s
      quoted = has = true
      continue
    }
    // ---- escapes outside quotes
    if (shell === 'powershell' && c === '`' && i + 1 < src.length) {
      if (src[i + 1] === '\n' || src[i + 1] === '\r') {
        // line continuation
        i++
        if (src[i] === '\r' && src[i + 1] === '\n') i++
        continue
      }
      buf += src[++i]
      has = true
      continue
    }
    if (shell === 'cmd' && c === '^' && i + 1 < src.length) {
      buf += src[++i]
      has = true
      continue
    }
    // ---- comments (PowerShell)
    if (shell === 'powershell' && c === '#' && !has) {
      while (i < src.length && src[i] !== '\n') i++
      endStatement()
      continue
    }
    if (shell === 'powershell' && c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2)
      i = end < 0 ? src.length : end + 1
      continue
    }
    // ---- redirection
    if (c === '>') {
      // "2>" / "*>" prefixes belong to the redirect, not to a token
      if (has && /^[\d*]$/.test(buf) && !quoted) {
        buf = ''
        has = false
      } else pushToken()
      if (src[i + 1] === '>') i++
      if (src[i + 1] === '&') {
        // 2>&1 style stream merge, no file involved
        i += 2
        continue
      }
      redirectNext = true
      continue
    }
    // ---- separators
    if (seps.has(c) || (shell === 'powershell' && c === '&' && src[i + 1] === '&')) {
      if (c === '&' || c === '|') if (src[i + 1] === c) i++
      endStatement()
      continue
    }
    if (shell === 'powershell' && c === '&') {
      // call operator: `& "C:\path\tool.exe" args`
      pushToken()
      continue
    }
    if (c === ' ' || c === '\t') {
      pushToken()
      continue
    }
    buf += c
    has = true
  }
  endStatement()
  if (redirectNext) problems.push('Redirection without a target')
  return { statements, redirects, nested, problems }
}

/** Collapses whitespace outside quotes so equivalent commands compare equal. */
export function normalizeCommand(src: string): string {
  let out = ''
  let q: string | null = null
  let space = false
  for (const c of src.trim()) {
    if (q) {
      out += c
      if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'") {
      if (space) out += ' '
      space = false
      q = c
      out += c
      continue
    }
    if (/\s/.test(c)) {
      space = out.length > 0
      continue
    }
    if (space) out += ' '
    space = false
    out += c
  }
  return out
}

/* ================================================================ program names */

const PS_ALIASES: Record<string, string> = {
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item', ri: 'remove-item',
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
  cat: 'get-content', type: 'get-content', gc: 'get-content',
  echo: 'write-output', write: 'write-output',
  cd: 'set-location', chdir: 'set-location', sl: 'set-location',
  pwd: 'get-location', gl: 'get-location',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item',
  mv: 'move-item', move: 'move-item', mi: 'move-item',
  ren: 'rename-item', rni: 'rename-item',
  md: 'mkdir', ni: 'new-item',
  sc: 'set-content', ac: 'add-content',
  iex: 'invoke-expression', icm: 'invoke-command',
  iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest', irm: 'invoke-restmethod',
  saps: 'start-process', start: 'start-process', ii: 'invoke-item',
  kill: 'stop-process', spps: 'stop-process', ps: 'get-process', gps: 'get-process', gsv: 'get-service',
  select: 'select-object', where: 'where-object', '?': 'where-object', '%': 'foreach-object', foreach: 'foreach-object',
  sort: 'sort-object', measure: 'measure-object', group: 'group-object', ft: 'format-table', fl: 'format-list', fw: 'format-wide',
  gm: 'get-member', gi: 'get-item', gp: 'get-itemproperty', sp: 'set-itemproperty', rp: 'remove-itemproperty',
  cls: 'clear-host', clear: 'clear-host', h: 'get-history', history: 'get-history', gal: 'get-alias', gcm: 'get-command',
  sleep: 'start-sleep', tee: 'tee-object', sal: 'set-alias', nal: 'new-alias', clc: 'clear-content', cli: 'clear-item'
}

const CMD_ALIASES: Record<string, string> = {
  erase: 'del', rmdir: 'rd', chdir: 'cd', md: 'mkdir', ren: 'rename', move: 'move', copy: 'copy'
}

/** Normalises the command word: strips quotes, folders and executable extensions, resolves aliases. */
export function programName(raw: string, shell: CommandShell): string {
  let p = raw.trim().replace(/^[.&]\s*/, '').replace(/^["']+|["']+$/g, '')
  const base = win32.basename(p).toLowerCase()
  // npm.cmd, yarn.cmd, code.cmd … are launchers of well-known tools, not user scripts.
  const shim = /^(npm|npx|pnpm|pnpx|yarn|bun|bunx|code|code-insiders|tsc|vite|next|ng|eslint|prettier|electron|electron-builder|gradlew|mvn)\.(cmd|bat|ps1)$/.exec(base)
  const isScript = !shim && /\.(ps1|bat|cmd|js|mjs|cjs|py|vbs|vbe|wsf|hta|jse?)$/i.test(base)
  p = shim ? shim[1] : isScript ? base : base.replace(/\.(exe|com)$/i, '')
  if (shell === 'powershell') return PS_ALIASES[p] ?? p
  return CMD_ALIASES[p] ?? p
}

/* ================================================================ paths */

const norm = (p: string) => win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
const inside = (root: string, target: string) => {
  const r = norm(root)
  const t = norm(target)
  return t === r || t.startsWith(r.endsWith('\\') ? r : r + '\\')
}

function protectedRoots(ctx: CommandContext): string[] {
  const env = ctx.env ?? {}
  const sys = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? 'C:\\Windows'
  const drive = win32.parse(sys).root || 'C:\\'
  return [
    sys,
    env['ProgramFiles'] ?? win32.join(drive, 'Program Files'),
    env['ProgramFiles(x86)'] ?? win32.join(drive, 'Program Files (x86)'),
    env['ProgramData'] ?? win32.join(drive, 'ProgramData'),
    win32.join(drive, 'Boot'),
    win32.join(drive, 'Recovery'),
    win32.join(drive, 'System Volume Information'),
    win32.join(drive, '$Recycle.Bin')
  ]
}

type TargetVerdict = { path: string | null; risk: CommandRisk; reason?: string }

/** Resolves a path argument and judges what touching it means. */
export function judgeTarget(raw: string, ctx: CommandContext, op: 'write' | 'delete'): TargetVerdict {
  const env = ctx.env ?? {}
  let p = raw.trim().replace(/^(?:-(?:literal)?path:)/i, '')
  if (!p) return { path: null, risk: 'low' }
  if (/^(hk(lm|cu|cr|u|cc)|hkey_[a-z_]+|registry)::?/i.test(p) || /^hk(lm|cu|cr|u|cc):/i.test(p)) {
    return { path: p, risk: /^(hklm|hkey_local_machine|hkcr|hkey_classes_root|registry::hkey_local_machine)/i.test(p) ? 'critical' : 'high', reason: `${op === 'delete' ? 'Deletes' : 'Changes'} Windows registry ${p}` }
  }
  if (/^(env|function|variable|alias|cert|wsman):/i.test(p)) {
    return /^(cert|wsman):/i.test(p) ? { path: p, risk: 'critical', reason: `Changes security store ${p}` } : { path: p, risk: 'low' }
  }
  p = p
    .replace(/^~(?=$|[\\/])/, ctx.home)
    .replace(/^\$home(?=$|[\\/])/i, ctx.home)
    .replace(/\$env:([A-Za-z_][\w()]*)/g, (m, v: string) => env[v] ?? env[v.toUpperCase()] ?? m)
    .replace(/%([^%]+)%/g, (m, v: string) => env[v] ?? env[v.toUpperCase()] ?? m)
  if (/\$[A-Za-z_{(]|%[^%\s]+%|\$\(\.\.\.\)/.test(p)) {
    return { path: p, risk: 'high', reason: `Target “${raw}” is computed at run time and can’t be checked in advance` }
  }
  const wild = /[*?]/.test(p)
  const base = wild ? p.replace(/[\\/][^\\/]*[*?][^\\/]*$/, '') || '.' : p
  const abs = win32.resolve(ctx.cwd, base)
  const parsed = win32.parse(abs)
  if (norm(abs) === norm(parsed.root)) return { path: abs, risk: 'critical', reason: `Touches the root of drive ${parsed.root}` }
  for (const r of protectedRoots(ctx)) {
    if (inside(r, abs) || inside(abs, r)) return { path: abs, risk: 'critical', reason: `Touches protected system folder ${r}` }
  }
  const usersDir = win32.dirname(ctx.home)
  if (inside(abs, ctx.home) || norm(abs) === norm(usersDir)) return { path: abs, risk: 'critical', reason: `Would ${op} your whole user profile` }
  const roots = [ctx.home, ...ctx.allowedRoots]
  if (!roots.some((r) => inside(r, abs))) {
    return { path: abs, risk: 'high', reason: `${op === 'delete' ? 'Deletes' : 'Writes'} outside your authorised folders: ${abs}` }
  }
  if (op === 'delete') {
    const top = [ctx.home, ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive'].map((d) => win32.join(ctx.home, d))]
    if (top.some((t) => norm(t) === norm(abs))) return { path: abs, risk: 'critical', reason: `Would delete your entire ${win32.basename(abs)} folder` }
    return { path: abs, risk: 'high', reason: `Deletes ${wild ? 'matching files in ' : ''}${abs}` }
  }
  return { path: abs, risk: 'medium', reason: `Writes ${abs}` }
}

/* ================================================================ statement rules */

type Verdict = { risk: CommandRisk; reason: string; targets?: string[] }

const LOW_PS = new Set([
  'get-childitem', 'get-content', 'get-location', 'set-location', 'push-location', 'pop-location', 'write-output', 'write-host', 'write-error',
  'write-warning', 'write-verbose', 'write-information', 'get-date', 'get-command', 'get-help', 'test-path', 'resolve-path', 'split-path',
  'join-path', 'get-item', 'get-itemproperty', 'select-object', 'where-object', 'foreach-object', 'sort-object', 'measure-object',
  'group-object', 'format-table', 'format-list', 'format-wide', 'out-string', 'out-host', 'out-null', 'convertto-json', 'convertfrom-json',
  'convertto-csv', 'convertfrom-csv', 'convertto-html', 'select-string', 'get-process', 'get-service', 'get-netipaddress',
  'get-netadapter', 'get-computerinfo', 'get-psdrive', 'get-volume', 'get-filehash', 'compare-object', 'get-member', 'get-variable',
  'get-random', 'get-host', 'get-uptime', 'start-sleep', 'clear-host', 'get-history', 'get-module', 'get-alias', 'test-connection',
  'resolve-dnsname', 'get-acl', 'get-culture', 'get-timezone', 'get-unique', 'get-winevent',
  'get-ciminstance', 'get-wmiobject', 'get-hotfix', 'get-package', 'get-installedmodule', 'get-executionpolicy', 'get-scheduledtask',
  'get-localuser', 'get-printer', 'measure-command', 'get-clipboard', 'set-clipboard', 'out-gridview'
])

const LOW_CMD = new Set([
  'dir', 'type', 'echo', 'cd', 'cls', 'ver', 'vol', 'where', 'whoami', 'hostname', 'ipconfig', 'ping', 'tree', 'findstr', 'find', 'more',
  'title', 'systeminfo', 'tasklist', 'pushd', 'popd', 'rem', 'timeout', 'sort', 'fc', 'comp', 'chcp', 'help', 'nslookup', 'tracert',
  'netstat', 'getmac', 'path', 'set', 'date', 'time', 'exit', 'pause', 'driverquery', 'clip'
])

/** Programs that open things for the user (files, folders, URLs). */
const OPENERS = new Set(['explorer', 'invoke-item', 'notepad', 'code', 'code-insiders', 'mspaint', 'calc', 'msedge', 'chrome', 'firefox', 'brave'])

const CRITICAL_PROGRAMS: Record<string, string> = {
  format: 'Formats a disk',
  'format-volume': 'Formats a disk volume',
  diskpart: 'Opens the disk partitioning tool',
  'clear-disk': 'Erases a disk',
  'initialize-disk': 'Re-initialises a disk',
  'remove-partition': 'Deletes a disk partition',
  'set-partition': 'Changes a disk partition',
  bcdedit: 'Changes Windows boot configuration',
  bootrec: 'Changes Windows boot records',
  vssadmin: 'Manages or deletes system restore points',
  wbadmin: 'Manages or deletes system backups',
  cipher: 'Can wipe free disk space or change file encryption',
  fsutil: 'Changes low-level file system behaviour',
  'set-mppreference': 'Changes Microsoft Defender security settings',
  'add-mppreference': 'Adds Microsoft Defender exclusions',
  'remove-mppreference': 'Changes Microsoft Defender security settings',
  'set-netfirewallprofile': 'Changes the Windows firewall',
  'disable-netfirewallrule': 'Disables a firewall rule',
  'enable-psremoting': 'Opens PowerShell remoting on this PC',
  'set-wsmanquickconfig': 'Opens remote management on this PC',
  wevtutil: 'Changes or clears Windows event logs',
  'clear-eventlog': 'Clears Windows event logs',
  auditpol: 'Changes Windows security auditing',
  'new-localuser': 'Creates a Windows user account',
  'remove-localuser': 'Deletes a Windows user account',
  'set-localuser': 'Changes a Windows user account',
  'add-localgroupmember': 'Changes Windows group membership (privileges)',
  'remove-localgroupmember': 'Changes Windows group membership (privileges)',
  secedit: 'Changes Windows security policy',
  mshta: 'Runs an HTML application (common malware technique)',
  regsvr32: 'Registers a system component (common malware technique)',
  rundll32: 'Runs code from a DLL (common malware technique)',
  'disable-computerrestore': 'Turns off system restore',
  takeown: 'Takes ownership of files (security change)',
  'manage-bde': 'Changes BitLocker encryption',
  'disable-bitlocker': 'Changes BitLocker encryption',
  'suspend-bitlocker': 'Changes BitLocker encryption'
}

const HIGH_PROGRAMS: Record<string, string> = {
  'stop-process': 'Ends running programs',
  taskkill: 'Ends running programs',
  'stop-service': 'Stops a Windows service',
  'start-service': 'Starts a Windows service',
  'restart-service': 'Restarts a Windows service',
  'set-service': 'Changes a Windows service',
  'new-service': 'Installs a Windows service',
  'remove-service': 'Removes a Windows service',
  'suspend-service': 'Pauses a Windows service',
  shutdown: 'Shuts down or restarts the PC',
  'restart-computer': 'Restarts the PC',
  'stop-computer': 'Shuts down the PC',
  logoff: 'Signs you out of Windows',
  regedit: 'Opens or imports into the registry',
  'new-itemproperty': 'Changes Windows registry values',
  'set-itemproperty': 'Changes Windows registry or file properties',
  'remove-itemproperty': 'Deletes Windows registry values',
  icacls: 'Changes file permissions',
  cacls: 'Changes file permissions',
  'set-acl': 'Changes file permissions',
  schtasks: 'Manages scheduled tasks',
  'register-scheduledtask': 'Creates a scheduled task that runs automatically',
  'unregister-scheduledtask': 'Deletes a scheduled task',
  'new-scheduledtask': 'Creates a scheduled task',
  'set-scheduledtask': 'Changes a scheduled task',
  netsh: 'Changes network or firewall configuration',
  'new-netfirewallrule': 'Adds a firewall rule',
  'set-netfirewallrule': 'Changes a firewall rule',
  'remove-netfirewallrule': 'Removes a firewall rule',
  'set-netipaddress': 'Changes network settings',
  'new-netipaddress': 'Changes network settings',
  'set-dnsclientserveraddress': 'Changes DNS settings',
  route: 'Changes network routing',
  'invoke-expression': 'Runs code built from text (can’t be checked in advance)',
  'invoke-command': 'Runs code in another PowerShell session',
  'enter-pssession': 'Opens a remote PowerShell session',
  'add-type': 'Compiles and loads new code',
  wscript: 'Runs a Windows script',
  cscript: 'Runs a Windows script',
  bitsadmin: 'Transfers files in the background',
  certutil: 'Certificate tool, also used to download files',
  'set-executionpolicy': 'Changes the PowerShell script policy',
  'set-alias': 'Redefines PowerShell commands',
  'new-alias': 'Redefines PowerShell commands',
  attrib: 'Changes file attributes (hidden/system/read-only)',
  'clear-recyclebin': 'Empties the Recycle Bin',
  'install-module': 'Installs PowerShell modules',
  'uninstall-module': 'Removes PowerShell modules',
  'install-package': 'Installs software packages',
  'uninstall-package': 'Removes software packages',
  'remove-appxpackage': 'Uninstalls a Windows app',
  'add-appxpackage': 'Installs a Windows app',
  'dism': 'Changes Windows components',
  sfc: 'Repairs Windows system files',
  'new-psdrive': 'Maps a drive',
  powercfg: 'Changes power settings',
  wmic: 'Windows management tool (can change the system)',
  'invoke-wmimethod': 'Calls Windows management methods',
  'invoke-cimmethod': 'Calls Windows management methods'
}

const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'perl', 'php', 'java', 'dotnet', 'go', 'cargo', 'tsx', 'ts-node'])
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bunx'])

const versionOnly = (args: string[]) => args.length === 1 && /^(-v|--version|-version|version|-V|--help|-h|help|\/\?)$/i.test(args[0])

function words(tokens: Token[]): string[] {
  return tokens.map((t) => t.text)
}

/** Positional (non-switch) arguments: candidate file targets. */
function positionals(args: string[], shell: CommandShell): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (shell === 'powershell' && /^-[a-z]/i.test(a)) continue
    if (shell === 'cmd' && /^\/[a-z?]/i.test(a)) continue
    if (/^-{1,2}[a-z]/i.test(a)) continue
    out.push(a)
  }
  return out
}

function targetsVerdict(paths: string[], ctx: CommandContext, op: 'write' | 'delete', base: Verdict): Verdict {
  let v = base
  const resolved: string[] = []
  if (!paths.length && op === 'delete') return { risk: maxRisk(base.risk, 'high'), reason: `${base.reason} (no target given — acts on the current folder)` }
  for (const p of paths) {
    const t = judgeTarget(p, ctx, op)
    if (t.path) resolved.push(t.path)
    if (RANK[t.risk] > RANK[v.risk] || (t.reason && RANK[t.risk] === RANK[v.risk] && op === 'delete')) v = { risk: maxRisk(v.risk, t.risk), reason: t.reason ?? v.reason }
  }
  return { ...v, targets: resolved }
}

function classifyNpm(prog: string, args: string[]): Verdict {
  const sub = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase()
  const global = args.some((a) => /^(-g|--global|--location=global)$/i.test(a))
  if (!args.length || versionOnly(args)) return { risk: 'low', reason: `Shows ${prog} information` }
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx' || sub === 'exec' || sub === 'dlx' || sub === 'x') return { risk: 'medium', reason: `Downloads and runs a package with ${prog}` }
  if (['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'root', 'prefix', 'help', 'search', 'why', 'explain', 'doctor', 'bin'].includes(sub)) return { risk: 'low', reason: `Reads ${prog} package information` }
  if (sub === 'config' && /^(get|list|ls)$/i.test(args[1] ?? '')) return { risk: 'low', reason: `Reads ${prog} configuration` }
  if (sub === 'audit' && !args.includes('fix')) return { risk: 'low', reason: 'Checks dependencies for known vulnerabilities' }
  if (['publish', 'unpublish', 'deprecate', 'owner', 'access', 'token', 'adduser', 'login', 'logout', 'team', 'org', 'hook', 'dist-tag'].includes(sub)) return { risk: 'high', reason: `Changes your published ${prog} packages or account` }
  if (global && ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'link'].includes(sub)) return { risk: 'high', reason: `Installs or removes a ${prog} package for the whole system` }
  if (['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un', 'rebuild', 'link', 'prune', 'dedupe', 'audit', 'import'].includes(sub)) return { risk: 'medium', reason: `Installs or changes project dependencies (${prog} ${sub})` }
  if (sub === 'run' && args.length === 1) return { risk: 'low', reason: 'Lists the project’s scripts' }
  if (['run', 'run-script', 'start', 'test', 't', 'build', 'dev', 'serve', 'preview', 'lint', 'exec', 'create', 'init', 'restart', 'stop'].includes(sub) || prog === 'yarn' || prog === 'pnpm') return { risk: 'medium', reason: `Runs a project script (${prog} ${args.join(' ')})`.slice(0, 160) }
  if (sub === 'config' || sub === 'set') return { risk: 'medium', reason: `Changes ${prog} configuration` }
  return { risk: 'medium', reason: `Runs ${prog} ${sub}` }
}

function classifyGit(args: string[]): Verdict {
  const sub = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase()
  const rest = args.slice(args.indexOf(sub) + 1)
  const has = (re: RegExp) => rest.some((a) => re.test(a))
  if (!args.length || versionOnly(args)) return { risk: 'low', reason: 'Shows git information' }
  if (['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'blame', 'shortlog', 'grep', 'cat-file', 'whatchanged', 'version', 'help'].includes(sub)) return { risk: 'low', reason: `Reads the git repository (git ${sub})` }
  if (sub === 'branch') {
    if (has(/^-(d|D|-delete|M|-force|f)$/)) return { risk: 'high', reason: 'Deletes or force-moves a git branch' }
    if (!rest.length || has(/^-(a|r|v|vv|-list|-show-current|-all|-remotes)$/)) return { risk: 'low', reason: 'Lists git branches' }
    return { risk: 'medium', reason: 'Creates or renames a git branch' }
  }
  if (sub === 'remote') return !rest.length || has(/^-v$|^show$|^get-url$/) ? { risk: 'low', reason: 'Lists git remotes' } : { risk: 'medium', reason: 'Changes git remotes' }
  if (sub === 'stash' && /^(list|show)$/.test(rest[0] ?? '')) return { risk: 'low', reason: 'Lists stashed changes' }
  if (sub === 'tag' && !rest.length) return { risk: 'low', reason: 'Lists git tags' }
  if (sub === 'config') return has(/^--(get|list|get-all)$|^-l$/) ? { risk: 'low', reason: 'Reads git configuration' } : has(/^--(global|system)$/) ? { risk: 'high', reason: 'Changes global git configuration' } : { risk: 'medium', reason: 'Changes git configuration' }
  if (sub === 'push') return has(/^(-f|--force|--force-with-lease|--mirror|--delete|-d)$|^\+/) ? { risk: 'high', reason: 'Force-pushes or deletes remote git history' } : { risk: 'high', reason: 'Publishes commits to a remote repository' }
  if (sub === 'reset') return has(/^--(hard|merge|keep)$/) ? { risk: 'high', reason: 'Discards uncommitted work (git reset --hard)' } : { risk: 'medium', reason: 'Moves the current git branch' }
  if (sub === 'clean') return { risk: 'high', reason: 'Deletes untracked files (git clean)' }
  if (sub === 'restore' || (sub === 'checkout' && (rest.includes('--') || has(/^\.$/) || has(/^-f$|^--force$/)))) return { risk: 'high', reason: 'Discards uncommitted changes to files' }
  if (sub === 'rm') return { risk: 'high', reason: 'Deletes files from the project (git rm)' }
  if (['filter-branch', 'filter-repo', 'gc', 'prune', 'reflog', 'update-ref', 'replace'].includes(sub)) return { risk: 'high', reason: `Rewrites or prunes git history (git ${sub})` }
  return { risk: 'medium', reason: `Changes the git repository (git ${sub})` }
}

function classifyStatement(tokens: Token[], shell: CommandShell, ctx: CommandContext, depth: number): Verdict & { program: string } {
  // PowerShell assignment: `$x = Get-Item foo`
  let t = tokens
  if (shell === 'powershell' && t.length >= 2 && /^\$[\w:{}]+$/.test(t[0].text) && /^[+\-*/]?=$/.test(t[1].text)) t = t.slice(2)
  if (!t.length) return { program: '', risk: 'low', reason: 'Stores a value' }
  const first = t[0]
  const argv = words(t.slice(1))
  if (shell === 'powershell' && !first.quoted && /^\$/.test(first.text)) {
    // A bare variable / expression ($x, $_.Name, $env:PATH) evaluates a value; `& $x` would run it.
    return { program: first.text, risk: 'low', reason: 'Evaluates a value' }
  }
  if (shell === 'powershell' && !first.quoted && /^(\[|\.\w|-\w|\d|@|')/.test(first.text)) {
    if (/^\[(system\.)?(reflection\.)?assembly\]::(load|loadfrom|loadfile)/i.test(first.text)) return { program: first.text, risk: 'critical', reason: 'Loads raw code into memory' }
    if (/^\[(system\.)?(diagnostics\.)?process\]::start/i.test(first.text)) return { program: first.text, risk: 'high', reason: 'Starts a program through .NET' }
    if (/^\[(system\.)?io\.(file|directory)\]::(delete|move|writeall|appendall|copy|create)/i.test(first.text)) return { program: first.text, risk: 'high', reason: 'Writes or deletes files through .NET' }
    if (/^\[(system\.)?net\.webclient\]|^\[scriptblock\]::create/i.test(first.text)) return { program: first.text, risk: 'high', reason: 'Builds or downloads code at run time' }
    return { program: first.text, risk: 'low', reason: 'Evaluates an expression' }
  }
  const prog = programName(first.text, shell)
  const lower = argv.map((a) => a.toLowerCase())
  const hasArg = (re: RegExp) => lower.some((a) => re.test(a))

  // Nested shells: classify what they would run.
  if (prog === 'powershell' || prog === 'pwsh') {
    if (hasArg(/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)$/)) return { program: prog, risk: 'critical', reason: 'Runs hidden, encoded PowerShell code' }
    if (hasArg(/^-(w|wi|win|window|windowstyle)$/) && hasArg(/^hidden$/)) return { program: prog, risk: 'critical', reason: 'Runs PowerShell in a hidden window' }
    const ci = lower.findIndex((a) => /^-(c|co|com|comm|comma|comman|command)$/.test(a))
    const fi = lower.findIndex((a) => /^-(f|fi|fil|file)$/.test(a))
    if (ci >= 0 && depth < 3) {
      const inner = classifyCommand(argv.slice(ci + 1).join(' '), 'powershell', ctx, depth + 1)
      return { program: prog, risk: maxRisk(inner.risk, 'medium'), reason: `Starts PowerShell to run: ${inner.summary}`, targets: inner.targets }
    }
    if (fi >= 0) return { program: prog, risk: 'medium', reason: `Runs the PowerShell script ${argv[fi + 1] ?? ''}`.trim() }
    if (versionOnly(argv)) return { program: prog, risk: 'low', reason: 'Shows PowerShell information' }
    return { program: prog, risk: 'medium', reason: 'Starts another PowerShell' }
  }
  if (prog === 'cmd') {
    const ci = lower.findIndex((a) => /^\/[ck]$/.test(a))
    if (ci >= 0 && depth < 3) {
      const inner = classifyCommand(argv.slice(ci + 1).join(' '), 'cmd', ctx, depth + 1)
      return { program: prog, risk: inner.risk, reason: inner.summary, targets: inner.targets }
    }
    return { program: prog, risk: 'medium', reason: 'Starts another command prompt' }
  }

  if (CRITICAL_PROGRAMS[prog]) {
    // Read-only forms of a few tools are fine.
    if (prog === 'vssadmin' && /^list$/i.test(argv[0] ?? '')) return { program: prog, risk: 'low', reason: 'Lists restore points' }
    if (prog === 'fsutil' && /^(fsinfo|volume)$/i.test(argv[0] ?? '') && !hasArg(/^(dismount|setlabel)$/)) return { program: prog, risk: 'low', reason: 'Reads file system information' }
    if (prog === 'bcdedit' && (!argv.length || hasArg(/^\/enum$/))) return { program: prog, risk: 'high', reason: 'Reads boot configuration (needs administrator)' }
    if (prog === 'cipher' && !hasArg(/^\/(w|e|d|k|r|u|n|x|y|adduser|removeuser|rekey|flushcache)/)) return { program: prog, risk: 'high', reason: 'Shows or changes file encryption' }
    if (prog === 'wevtutil' && /^(qe|query-events|el|enum-logs|gl|get-log|gli)$/i.test(argv[0] ?? '')) return { program: prog, risk: 'low', reason: 'Reads Windows event logs' }
    if (prog === 'auditpol' && /^\/get$/i.test(argv[0] ?? '')) return { program: prog, risk: 'high', reason: 'Reads security auditing (needs administrator)' }
    return { program: prog, risk: 'critical', reason: CRITICAL_PROGRAMS[prog] }
  }

  // Elevation / hidden windows through Start-Process.
  if (prog === 'start-process') {
    if (hasArg(/^-verb(:runas)?$/) && hasArg(/^runas(user)?$/)) return { program: prog, risk: 'critical', reason: 'Asks Windows for administrator rights (elevation)' }
    if (hasArg(/^-windowstyle$/) && hasArg(/^hidden$/)) return { program: prog, risk: 'critical', reason: 'Starts a program in a hidden window' }
    const target = positionals(argv, shell)[0] ?? ''
    if (/^https?:\/\//i.test(target)) return { program: prog, risk: 'low', reason: `Opens ${target}` }
    const tp = programName(target, shell)
    if (/\.(html?|pdf|txt|md|png|jpe?g|gif|svg|webp)$/i.test(target) || OPENERS.has(tp)) return { program: prog, risk: 'low', reason: `Opens ${target}` }
    if (tp === 'powershell' || tp === 'pwsh' || tp === 'cmd') return { program: prog, risk: 'high', reason: 'Starts another shell window' }
    return { program: prog, risk: 'medium', reason: `Starts ${target || 'a program'}` }
  }
  if (shell === 'cmd' && prog === 'start') {
    const target = argv.filter((a) => !/^\//.test(a)).find((a, i) => !(i === 0 && /^".*"$|^$/.test(a))) ?? ''
    if (/^https?:\/\//i.test(target) || /\.(html?|pdf|txt|md|png|jpe?g|gif|svg|webp)$/i.test(target) || OPENERS.has(programName(target, shell))) return { program: prog, risk: 'low', reason: `Opens ${target}` }
    return { program: prog, risk: 'medium', reason: `Starts ${target || 'a program'}` }
  }
  if (prog === 'runas') return { program: prog, risk: 'critical', reason: 'Runs a program as another user (elevation)' }
  if (prog === 'sudo') return { program: prog, risk: 'critical', reason: 'Runs a program with administrator rights' }

  // Processes: critical system processes are protected outright.
  if (prog === 'stop-process' || prog === 'taskkill') {
    if (hasArg(/^(lsass|csrss|winlogon|wininit|smss|services|svchost|system|explorer|dwm|msmpeng|securityhealthservice)(\.exe)?$/)) return { program: prog, risk: 'critical', reason: 'Would end a core Windows process' }
    return { program: prog, risk: 'high', reason: HIGH_PROGRAMS[prog] }
  }

  // Registry tool (cmd and PowerShell).
  if (prog === 'reg') {
    const sub = lower[0] ?? ''
    if (['query', 'compare', 'export'].includes(sub)) return { program: prog, risk: 'low', reason: 'Reads the Windows registry' }
    const key = lower[1] ?? ''
    const machine = /^(hklm|hkey_local_machine|hkcr|hkey_classes_root)/.test(key)
    if (sub === 'delete' && machine) return { program: prog, risk: 'critical', reason: `Deletes machine-wide registry keys (${argv[1]})` }
    if (/\\run(once)?$|\\winlogon|\\policies\\|image file execution options/.test(key)) return { program: prog, risk: 'critical', reason: 'Changes programs that start automatically or system policies' }
    return { program: prog, risk: 'high', reason: `Changes the Windows registry (${argv[1] ?? ''})`.trim() }
  }
  if (prog === 'sc' && shell === 'cmd') {
    if (/^(query|queryex|qc|qdescription|getdisplayname|getkeyname|enumdepend)$/.test(lower[0] ?? '')) return { program: prog, risk: 'low', reason: 'Reads Windows services' }
    return { program: prog, risk: 'high', reason: 'Changes a Windows service' }
  }
  if (prog === 'net' || prog === 'net1') {
    const sub = lower[0] ?? ''
    if ((sub === 'user' || sub === 'localgroup' || sub === 'group') && hasArg(/^\/(add|delete|del|active)/)) return { program: prog, risk: 'critical', reason: 'Changes Windows accounts or privileges' }
    if ((sub === 'user' || sub === 'localgroup') && argv.length > 2) return { program: prog, risk: 'critical', reason: 'Changes a Windows account' }
    if (['start', 'stop', 'pause', 'continue'].includes(sub)) return { program: prog, risk: 'high', reason: `${sub === 'start' ? 'Starts' : 'Stops'} a Windows service` }
    if (sub === 'share' && argv.length > 1) return { program: prog, risk: 'high', reason: 'Shares a folder on the network' }
    if (sub === 'use' && argv.length > 1) return { program: prog, risk: 'medium', reason: 'Connects a network drive' }
    return { program: prog, risk: 'low', reason: 'Reads network or account information' }
  }
  if (prog === 'setx') return hasArg(/^\/m$/) ? { program: prog, risk: 'high', reason: 'Changes system-wide environment variables' } : { program: prog, risk: 'medium', reason: 'Changes your saved environment variables' }
  if (prog === 'set-executionpolicy') {
    const scope = lower[lower.indexOf('-scope') + 1]
    if (lower.includes('-scope') && scope === 'process') return { program: prog, risk: 'medium', reason: 'Changes the script policy for this session only' }
    if (lower.includes('-scope') && scope === 'currentuser') return { program: prog, risk: 'high', reason: 'Changes your PowerShell script policy' }
    return { program: prog, risk: 'critical', reason: 'Changes the machine-wide PowerShell script policy' }
  }
  if (prog === 'schtasks') return /^\/query$/i.test(argv[0] ?? '') ? { program: prog, risk: 'low', reason: 'Lists scheduled tasks' } : { program: prog, risk: 'high', reason: 'Creates, changes or deletes scheduled tasks' }
  if (prog === 'netsh') {
    if (lower[0] === 'advfirewall' && hasArg(/^off$/)) return { program: prog, risk: 'critical', reason: 'Turns off the Windows firewall' }
    if (hasArg(/^(show|dump)$/) && !hasArg(/^(set|add|delete|reset)$/)) return { program: prog, risk: 'low', reason: 'Reads network configuration' }
    return { program: prog, risk: 'high', reason: HIGH_PROGRAMS[prog] }
  }
  if (prog === 'certutil') {
    if (hasArg(/^-(urlcache|verifyctl|decode|decodehex|encode)$/)) return { program: prog, risk: 'high', reason: 'Downloads or decodes files with certutil (common malware technique)' }
    if (hasArg(/^-(addstore|delstore|importpfx|repairstore|setreg)$/)) return { program: prog, risk: 'critical', reason: 'Changes trusted certificates' }
    return { program: prog, risk: 'low', reason: 'Reads certificate information' }
  }
  if (prog === 'wmic') {
    if (hasArg(/^(call|delete|set|create)$/)) return { program: prog, risk: 'high', reason: 'Changes the system through WMI' }
    return { program: prog, risk: 'low', reason: 'Reads system information' }
  }
  if (prog === 'attrib') {
    const paths = positionals(argv, shell).filter((a) => !/^[+-][rahsiox]$/i.test(a))
    if (!hasArg(/^[+-][rahsi]$/)) return { program: prog, risk: 'low', reason: 'Shows file attributes' }
    return { program: prog, ...targetsVerdict(paths, ctx, 'write', { risk: 'high', reason: HIGH_PROGRAMS[prog] }) }
  }

  if (HIGH_PROGRAMS[prog]) {
    if (/^(set|new|remove)-itemproperty$/.test(prog)) {
      const paths = positionals(argv, shell)
      return { program: prog, ...targetsVerdict(paths.slice(0, 1), ctx, prog.startsWith('remove') ? 'delete' : 'write', { risk: 'high', reason: HIGH_PROGRAMS[prog] }) }
    }
    return { program: prog, risk: 'high', reason: HIGH_PROGRAMS[prog] }
  }

  // Deletes.
  if (prog === 'remove-item' || prog === 'clear-content' || prog === 'clear-item' || (shell === 'cmd' && (prog === 'del' || prog === 'rd'))) {
    const recursive = hasArg(/^(-r|-recurse|\/s)$/)
    const base: Verdict = { risk: 'high', reason: prog === 'clear-content' ? 'Erases file contents' : `Deletes files${recursive ? ' and folders' : ''}` }
    return { program: prog, ...targetsVerdict(positionals(argv, shell), ctx, 'delete', base) }
  }

  // Writes.
  if (['new-item', 'set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'rename-item', 'tee-object', 'expand-archive', 'compress-archive', 'export-csv', 'export-clixml'].includes(prog) || (shell === 'cmd' && ['copy', 'xcopy', 'robocopy', 'move', 'rename', 'mklink'].includes(prog))) {
    if (prog === 'robocopy' && hasArg(/^\/(mir|purge)$/)) return { program: prog, ...targetsVerdict(positionals(argv, shell).slice(1, 2), ctx, 'delete', { risk: 'high', reason: 'Mirrors folders and deletes extra files (robocopy /MIR)' }) }
    if (prog === 'mklink') return { program: prog, risk: 'high', reason: 'Creates a file system link' }
    let paths = positionals(argv, shell)
    if (prog === 'new-item' && hasArg(/^-itemtype$/) && hasArg(/^(symboliclink|junction|hardlink)$/)) return { program: prog, risk: 'high', reason: 'Creates a file system link' }
    if (prog === 'new-item') paths = paths.filter((p) => !/^(file|directory|folder)$/i.test(p))
    if (['set-content', 'add-content', 'tee-object'].includes(prog)) paths = paths.slice(0, 1)
    const dir = prog === 'new-item' && hasArg(/^(directory|folder)$/)
    const v = targetsVerdict(paths, ctx, 'write', { risk: dir ? 'low' : 'medium', reason: dir ? 'Creates a folder' : 'Writes files' })
    return { program: prog, ...v, risk: dir && v.risk === 'medium' ? 'low' : v.risk }
  }
  if (prog === 'mkdir') {
    const v = targetsVerdict(positionals(argv, shell), ctx, 'write', { risk: 'low', reason: 'Creates a folder' })
    return { program: prog, ...v, risk: v.risk === 'medium' ? 'low' : v.risk }
  }

  // Network downloads.
  if (prog === 'invoke-webrequest' || prog === 'invoke-restmethod' || prog === 'curl' || prog === 'wget') {
    const out = lower.findIndex((a) => /^(-outfile|-o|--output|-o)$/.test(a))
    if (out >= 0 && argv[out + 1]) return { program: prog, ...targetsVerdict([argv[out + 1]], ctx, 'write', { risk: 'medium', reason: 'Downloads a file from the internet' }) }
    if (hasArg(/^-(x|-request)$/) || hasArg(/^-method$/) || hasArg(/^-(d|-data|-f|-form|t|-upload-file)$/)) return { program: prog, risk: 'medium', reason: 'Sends data to a web server' }
    return { program: prog, risk: 'low', reason: 'Fetches a web page' }
  }

  if (PKG_MANAGERS.has(prog)) return { program: prog, ...classifyNpm(prog, argv) }
  if (prog === 'git') return { program: prog, ...classifyGit(argv) }
  if (prog === 'pip' || prog === 'pip3' || prog === 'uv' || prog === 'poetry' || prog === 'pipenv' || prog === 'conda') {
    const sub = lower[0] ?? ''
    if (!argv.length || versionOnly(argv) || ['list', 'show', 'freeze', 'check', 'search', 'help'].includes(sub)) return { program: prog, risk: 'low', reason: `Reads ${prog} package information` }
    if (hasArg(/^--(break-system-packages|system)$/)) return { program: prog, risk: 'high', reason: 'Changes system-wide Python packages' }
    return { program: prog, risk: 'medium', reason: `Installs or changes Python packages (${prog} ${sub})` }
  }
  if (prog === 'winget' || prog === 'choco' || prog === 'scoop') {
    const sub = lower[0] ?? ''
    if (!argv.length || versionOnly(argv) || ['list', 'search', 'show', 'info', 'outdated'].includes(sub)) return { program: prog, risk: 'low', reason: `Reads ${prog} package information` }
    return { program: prog, risk: 'high', reason: `Installs or removes software on this PC (${prog} ${sub})` }
  }
  if (SCRIPT_RUNNERS.has(prog)) {
    if (!argv.length) return { program: prog, risk: 'medium', reason: `Starts ${prog} interactively` }
    if (versionOnly(argv)) return { program: prog, risk: 'low', reason: `Shows the ${prog} version` }
    if ((prog === 'python' || prog === 'python3' || prog === 'py') && lower[0] === '-m') {
      const mod = lower[1] ?? ''
      if (mod === 'pip') return { program: prog, risk: lower[2] && ['list', 'show', 'freeze', '--version'].includes(lower[2]) ? 'low' : 'medium', reason: 'Runs pip (Python packages)' }
      if (mod === 'http.server') return { program: prog, risk: 'medium', reason: 'Starts a local web server' }
      return { program: prog, risk: 'medium', reason: `Runs the Python module ${mod}` }
    }
    if (hasArg(/^(-e|--eval|-p|--print|-c)$/)) return { program: prog, risk: 'medium', reason: `Runs inline ${prog} code` }
    return { program: prog, risk: 'medium', reason: `Runs ${argv[0]} with ${prog}` }
  }
  if (['tsc', 'vite', 'next', 'webpack', 'eslint', 'prettier', 'jest', 'vitest', 'mvn', 'gradle', 'gradlew', 'make', 'cmake', 'msbuild', 'ng', 'vue', 'nuxt', 'astro', 'flutter', 'dart', 'rustc', 'gcc', 'g++', 'javac', 'electron', 'electron-vite', 'electron-builder'].includes(prog)) {
    if (versionOnly(argv)) return { program: prog, risk: 'low', reason: `Shows the ${prog} version` }
    return { program: prog, risk: 'medium', reason: `Runs the ${prog} build tool` }
  }
  if (OPENERS.has(prog)) {
    if (prog === 'code' && hasArg(/^--(install|uninstall)-extension$/)) return { program: prog, risk: 'medium', reason: 'Installs or removes a VS Code extension' }
    return { program: prog, risk: 'low', reason: `Opens ${argv[0] ?? prog}` }
  }
  if (/\.(ps1|bat|cmd|vbs|vbe|wsf|js|jse|hta)$/i.test(prog)) {
    if (/\.(vbs|vbe|wsf|jse|hta)$/i.test(prog)) return { program: prog, risk: 'high', reason: `Runs the Windows script ${prog}` }
    return { program: prog, risk: 'medium', reason: `Runs the script ${prog}` }
  }
  if (shell === 'powershell' ? LOW_PS.has(prog) || LOW_CMD.has(prog) : LOW_CMD.has(prog)) {
    if (prog === 'set' && shell === 'cmd' && argv.join(' ').includes('=')) return { program: prog, risk: 'low', reason: 'Sets a variable for this command only' }
    if (prog === 'set-clipboard') return { program: prog, risk: 'low', reason: 'Copies text to the clipboard' }
    return { program: prog, risk: 'low', reason: 'Reads information' }
  }
  if (prog === 'call' && shell === 'cmd') {
    const inner = argv.join(' ')
    return depth < 3 ? { program: prog, ...pickVerdict(classifyCommand(inner, 'cmd', ctx, depth + 1)) } : { program: prog, risk: 'medium', reason: 'Calls another script' }
  }
  if (prog === 'new-object' || prog === 'get-credential' || prog === 'read-host') return { program: prog, risk: 'low', reason: 'Prepares a value' }
  return { program: prog, risk: 'medium', reason: `Runs an unfamiliar program (${first.text})` }
}

const pickVerdict = (c: CommandClassification): Verdict => ({ risk: c.risk, reason: c.summary, targets: c.targets })

/* ================================================================ public */

/**
 * Classifies a whole command line. The overall risk is the highest risk of
 * any statement, nested sub-expression or redirection.
 */
export function classifyCommand(command: string, shell: CommandShell, ctx: CommandContext, depth = 0): CommandClassification {
  const text = command.trim()
  if (!text) return { risk: 'low', reasons: [], summary: 'Nothing to run', programs: [], targets: [] }
  if (text.length > 20_000) return { risk: 'high', reasons: ['Very long command that can’t be reviewed at a glance'], summary: 'Runs a very long script', programs: [], targets: [] }
  const parsed = tokenize(text, shell)
  const found: (Verdict & { program?: string })[] = []
  for (const st of parsed.statements) found.push(classifyStatement(st, shell, ctx, depth))
  for (const code of parsed.nested) if (depth < 3) found.push(pickVerdict(classifyCommand(code, shell, ctx, depth + 1)))
  for (const r of parsed.redirects) {
    if (/^\$?null$|^nul$/i.test(r)) continue
    found.push(targetsVerdict([r], ctx, 'write', { risk: 'medium', reason: `Writes output to ${r}` }))
  }
  if (parsed.problems.length) found.push({ risk: 'medium', reason: 'The command has unbalanced quotes' })
  // Piping anything into Invoke-Expression from a download is the classic remote-code pattern.
  const progs = found.map((f) => f.program ?? '')
  if (progs.includes('invoke-expression') && progs.some((p) => ['invoke-webrequest', 'invoke-restmethod', 'curl', 'wget'].includes(p))) {
    found.push({ risk: 'critical', reason: 'Downloads code and runs it immediately' })
  }
  let risk: CommandRisk = 'low'
  for (const f of found) risk = maxRisk(risk, f.risk)
  const ordered = [...found].sort((a, b) => RANK[b.risk] - RANK[a.risk])
  const reasons = [...new Set(ordered.filter((f) => f.risk !== 'low' || ordered.every((o) => o.risk === 'low')).map((f) => f.reason))].slice(0, 6)
  const targets = [...new Set(found.flatMap((f) => f.targets ?? []))]
  return { risk, reasons, summary: reasons[0] ?? 'Reads information', programs: progs.filter(Boolean), targets }
}

/** Why approval is needed, phrased for the permission popup. */
export function approvalReason(c: CommandClassification): string {
  switch (c.risk) {
    case 'low':
      return 'Read-only command.'
    case 'medium':
      return c.reasons.length > 1 ? `Also: ${c.reasons.slice(1).join('; ')}. ZVYRA asks before installing packages, running scripts or changing files.` : 'ZVYRA asks before installing packages, running scripts or changing files.'
    case 'high':
      return 'This can remove data or change how Windows behaves, so it needs your OK every time and can’t be saved as “Always Allow”.'
    case 'critical':
      return `${c.summary}. ZVYRA never runs this kind of command.`
  }
}
