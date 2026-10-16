/**
 * OWNER: Kiro. Direct desktop tools shared by the Gemini Live voice session and
 * the typed-command agent. These do the work immediately (no task queue):
 * files in the user's folders, opening things in a chosen browser/app,
 * launching installed apps, and running commands (always confirmed natively).
 */
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Type, type FunctionDeclaration } from '@google/genai'
import { isInside } from '../desktop/pure'
import { checkSite } from '../agent/siteCheck'
import { inspectProject } from '../agent/projectInspect'
import type { CommandOutcome } from '../desktop/terminal'

/* ---------------------------------------------------------------- paths */

const HOME = homedir()
const KNOWN: Record<string, string> = {
  downloads: join(HOME, 'Downloads'),
  download: join(HOME, 'Downloads'),
  desktop: join(HOME, 'Desktop'),
  documents: join(HOME, 'Documents'),
  docs: join(HOME, 'Documents'),
  pictures: join(HOME, 'Pictures'),
  music: join(HOME, 'Music'),
  videos: join(HOME, 'Videos'),
  projects: join(HOME, 'Documents', 'ZVYRA Projects'),
  home: HOME
}

/** Where the agent builds multi-file projects (websites, apps) unless the user names a folder. */
export const PROJECTS_DIR = KNOWN.projects

/** Expands ~, %VARS%, and leading known-folder names ("Downloads/x.html"). Relative paths land in Downloads. */
export function resolveUserPath(input: string, base = KNOWN.downloads): string {
  let p = input.trim().replace(/^["']|["']$/g, '')
  p = p.replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`)
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(HOME, p.slice(1))
  if (!isAbsolute(p)) {
    const [first, ...rest] = p.split(/[\\/]/)
    const known = KNOWN[first.toLowerCase()]
    p = known ? join(known, ...rest) : join(base, p)
  }
  return normalize(resolve(p))
}

export function ensureInHome(p: string, extraRoots: string[] = []) {
  if ([HOME, ...extraRoots].some((r) => isInside(r, p))) return p
  throw new Error(`For safety ZVYRA only works inside your user folders (${HOME}). “${p}” is outside.`)
}

/* ---------------------------------------------------------------- browsers / apps */

const PF = process.env['ProgramFiles'] ?? 'C:\\Program Files'
const PF86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
const LAD = process.env['LOCALAPPDATA'] ?? join(HOME, 'AppData', 'Local')

const BROWSERS: Record<string, string[]> = {
  brave: [join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(PF86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
  chrome: [join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  edge: [join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  firefox: [join(PF, 'Mozilla Firefox', 'firefox.exe'), join(PF86, 'Mozilla Firefox', 'firefox.exe')],
  opera: [join(LAD, 'Programs', 'Opera', 'opera.exe')],
  vscode: [join(LAD, 'Programs', 'Microsoft VS Code', 'Code.exe'), join(PF, 'Microsoft VS Code', 'Code.exe')],
  notepad: [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'notepad.exe')]
}

const ALIASES: Record<string, string> = {
  'brave browser': 'brave',
  'google chrome': 'chrome',
  'microsoft edge': 'edge',
  'mozilla firefox': 'firefox',
  'visual studio code': 'vscode',
  'vs code': 'vscode',
  code: 'vscode'
}

export function findAppExe(name: string): string | null {
  const key = ALIASES[name.toLowerCase().trim()] ?? name.toLowerCase().trim()
  return (BROWSERS[key] ?? []).find((p) => existsSync(p)) ?? null
}

function spawnDetached(exe: string, args: string[]) {
  return new Promise<void>((res, rej) => {
    const c = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
    c.once('error', rej)
    c.once('spawn', () => {
      c.unref()
      res()
    })
  })
}

/** Start-menu shortcut search, so “open Spotify” works without setup. */
async function findStartMenuShortcut(name: string): Promise<string | null> {
  const roots = [join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]
  const want = name.toLowerCase().replace(/\.(lnk|exe)$/, '').trim()
  let best: { path: string; score: number } | null = null
  const walk = async (dir: string, depth: number) => {
    if (depth > 3) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (/\.(lnk|url)$/i.test(e.name)) {
        const n = e.name.replace(/\.(lnk|url)$/i, '').toLowerCase()
        if (/uninstall|readme|help|documentation/.test(n)) continue
        const score = n === want ? 3 : n.startsWith(want) ? 2 : n.includes(want) ? 1 : 0
        if (score && (!best || score > best.score || (score === best.score && n.length < basename(best.path).length))) best = { path: full, score }
      }
    }
  }
  for (const r of roots) await walk(r, 0)
  return (best as { path: string } | null)?.path ?? null
}

/* ---------------------------------------------------------------- declarations */

export const DESKTOP_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'create_file',
    description:
      'Create (or overwrite) a text file on the user’s PC with the given content — HTML pages, CSS, JavaScript, notes, code, CSV, etc. Missing folders are created. Relative paths (e.g. "calculator/index.html") are saved in the current WORKSPACE (the selected project, or Documents/ZVYRA Projects when none is selected). Paths may also be absolute or start with ~ or a known folder (Downloads, Desktop, Documents, Projects). The result reports the verified path and size on disk. Write complete, polished, working content — never placeholders or TODOs.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'e.g. "Downloads/hello.html"' },
        content: { type: Type.STRING },
        overwrite: { type: Type.BOOLEAN, description: 'Set true to replace an existing file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'open',
    description: 'Open a file, folder or URL. Optionally with a specific app: brave, chrome, edge, firefox, opera, vscode, notepad, explorer. Use this right after create_file when the user wants to see it.',
    parameters: {
      type: Type.OBJECT,
      properties: { target: { type: Type.STRING, description: 'Path or http(s) URL' }, app: { type: Type.STRING, description: 'Optional app name; omit for the default app' } },
      required: ['target']
    }
  },
  {
    name: 'launch_app',
    description: 'Launch an installed Windows app by name (searches the Start menu), e.g. Spotify, Brave, Calculator, Word.',
    parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING } }, required: ['name'] }
  },
  {
    name: 'list_folder',
    description: 'List files in a folder in the user’s profile (e.g. Downloads, Desktop).',
    parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING } }, required: ['path'] }
  },
  {
    name: 'read_file',
    description: 'Read a text file from the user’s folders (first 100 KB).',
    parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING } }, required: ['path'] }
  },
  {
    name: 'run_command',
    description:
      'Run a Windows command and get its REAL result (status, exit code, output). shell="powershell" (default) or "cmd" for Command Prompt syntax (dir /b, &&, set X=1). Read-only commands run immediately; installs, scripts and file changes show the user an approval popup first; dangerous system commands are blocked. If the result status is denied, expired or blocked, the command did NOT run — stop and tell the user. Use background=true for dev servers and other commands that keep running (returns after a few seconds with the output so far and any local URL). Do NOT use this to create or edit files — use create_file / edit_file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING },
        cwd: { type: Type.STRING, description: 'Folder to run in (defaults to the workspace)' },
        shell: { type: Type.STRING, description: 'powershell | cmd' },
        background: { type: Type.BOOLEAN, description: 'Keep running (servers); return after ~8 s' },
        timeout_seconds: { type: Type.NUMBER, description: 'Default 120, max 1800' }
      },
      required: ['command']
    }
  },
  {
    name: 'get_workspace',
    description: 'Where ZVYRA saves new work right now: the selected project folder, or Documents/ZVYRA Projects when no project is selected. Also lists the user’s registered projects.',
    parameters: { type: Type.OBJECT, properties: {} }
  },
  {
    name: 'inspect_project',
    description:
      'Inspect a project folder (default: the workspace) and report its type, framework, package manager, scripts, and the exact install and run commands. Call this before running a project so you use the right commands.',
    parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING } } }
  },
  {
    name: 'open_project',
    description: 'Open one of the user’s projects (by name, or the selected one when no name is given) in VS Code, or File Explorer when VS Code isn’t installed.',
    parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, app: { type: Type.STRING, description: 'vscode | explorer (optional)' } } }
  },
  {
    name: 'edit_file',
    description: 'Change part of an existing text file by exact find-and-replace. `find` must match the file exactly (copy it from read_file) and only once unless all=true. Use for fixes instead of rewriting a whole file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING },
        find: { type: Type.STRING, description: 'Exact existing text to replace' },
        replace: { type: Type.STRING, description: 'New text' },
        all: { type: Type.BOOLEAN, description: 'Replace every occurrence' }
      },
      required: ['path', 'find', 'replace']
    }
  },
  {
    name: 'list_tree',
    description: 'List every file in a project folder recursively (skips node_modules, .git, dist). Use to review what you built.',
    parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING } }, required: ['path'] }
  },
  {
    name: 'check_site',
    description:
      'Load a local web page (path to an .html file) or URL in a hidden browser and report real problems: JavaScript console errors, missing files/failed requests, the page title and visible text. Always run this after building a website and fix everything it reports.',
    parameters: { type: Type.OBJECT, properties: { target: { type: Type.STRING, description: 'Path to index.html or an http(s) URL' } }, required: ['target'] }
  },
  {
    name: 'run_task',
    description:
      'Start ZVYRA’s builder agent in the background for a big job — complete multi-file websites/apps (e.g. an e-commerce store), long reports. It plans, writes every file, tests and opens the result while you keep talking. Give it the full request with every detail the user said.',
    parameters: { type: Type.OBJECT, properties: { instruction: { type: Type.STRING } }, required: ['instruction'] }
  },
  { name: 'get_status', description: 'What ZVYRA is doing: running tasks, approvals waiting, recent results.', parameters: { type: Type.OBJECT, properties: {} } }
]

/* ---------------------------------------------------------------- executor */

export interface CommandRequest {
  cwd?: string
  shell?: 'powershell' | 'cmd'
  background?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  taskTitle?: string
}

export interface DesktopToolHost {
  activity(type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error'): void
  /** Classified, approved (when needed) and executed by the terminal service; always the real outcome. */
  runCommand(command: string, o: CommandRequest): Promise<CommandOutcome>
  runTask(instruction: string): Promise<{ id: string; title: string; status: string }>
  status(): Promise<string>
  extraRoots(): Promise<string[]>
  userApps(): { id: string; name: string; path?: string }[]
  launchUserApp(id: string): Promise<void>
  /** The selected project folder, or ZVYRA's default projects folder. */
  workspace(): Promise<{ name: string; path: string; selected: boolean }>
  projects(): Promise<{ id: string; name: string; path: string }[]>
  openInEditor(path: string): Promise<void>
  /** Right-side desktop notification for a real event. */
  notifyEvent(t: { key: string; kind: 'success' | 'error' | 'file' | 'launch' | 'info'; title: string; body?: string; detail?: string; timeoutMs: number }): void
}

export type ToolResult = Record<string, unknown>

/** Resolves a tool path: relative paths land in the workspace; everything must stay in the user's folders. */
async function resolveToolPath(host: DesktopToolHost, raw: string, fallback?: string) {
  const ws = await host.workspace()
  const roots = [ws.path, ...(await host.extraRoots())]
  return { path: ensureInHome(resolveUserPath(raw || fallback || ws.path, ws.path), roots), workspace: ws }
}

export async function runDesktopTool(host: DesktopToolHost, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'create_file': {
      if (!str('path').trim()) return { error: 'Give the file a name, e.g. "calculator/index.html".' }
      const { path: p, workspace } = await resolveToolPath(host, str('path'))
      const exists = existsSync(p)
      if (exists && args['overwrite'] !== true) return { error: `“${p}” already exists. Call again with overwrite=true to replace it, or choose another name.` }
      await mkdir(dirname(p), { recursive: true })
      const content = str('content')
      await writeFile(p, content, 'utf8')
      // Verify: the file must exist with exactly what was written.
      const back = await readFile(p, 'utf8').catch(() => null)
      if (back === null || back.length !== content.length) return { error: `Writing ${p} could not be verified (the file is missing or incomplete afterwards).` }
      const bytes = Buffer.byteLength(content)
      host.activity('file.created', `${exists ? 'Updated' : 'Created'} ${basename(p)}`, p, 'success')
      host.notifyEvent({ key: `file:${dirname(p)}`, kind: 'file', title: exists ? 'File updated' : 'File created', body: basename(p), detail: p, timeoutMs: 5000 })
      return { ok: true, verified: true, path: p, folder: dirname(p), bytes, inWorkspace: isInside(workspace.path, p), workspace: workspace.path }
    }
    case 'open': {
      const target = str('target').trim()
      const app = str('app').trim().toLowerCase()
      const isUrl = /^https?:\/\//i.test(target) || (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(target) && !existsSync(resolveUserPath(target)))
      const url = isUrl ? (/^https?:/i.test(target) ? target : `https://${target}`) : null
      const path = url ? null : (await resolveToolPath(host, target)).path
      if (path && !existsSync(path)) return { error: `Nothing exists at “${path}”.` }
      if (app && app !== 'default') {
        if (app === 'explorer' && path) {
          shell.showItemInFolder(path)
          host.activity('app.opened', `Showed ${basename(path)} in File Explorer`, path)
          return { ok: true }
        }
        const exe = findAppExe(app)
        if (!exe) return { error: `${app} isn’t installed (looked in the usual folders). Use the default app instead?` }
        await spawnDetached(exe, [url ?? (/\.(html?|svg|pdf|png|jpe?g|gif|webp)$/i.test(path!) && /brave|chrome|edge|firefox|opera/.test(app) ? pathToFileURL(path!).href : path!)])
        host.activity('app.opened', `Opened ${url ?? basename(path!)} in ${app}`, url ?? path!)
        return { ok: true, opened: url ?? path, openedWith: app }
      }
      if (url) await shell.openExternal(url)
      else {
        const err = await shell.openPath(path!)
        if (err) return { error: `Windows couldn’t open ${path}: ${err}` }
      }
      host.activity('app.opened', `Opened ${url ?? basename(path!)}`, url ?? path!)
      return { ok: true, opened: url ?? path, with: 'default app' }
    }
    case 'launch_app': {
      const want = str('name')
      const user = host.userApps().find((a) => a.name.toLowerCase().includes(want.toLowerCase()))
      if (user) {
        await host.launchUserApp(user.id)
        return { ok: true, launched: user.name }
      }
      const exe = findAppExe(want)
      if (exe) {
        await spawnDetached(exe, [])
        host.activity('app.opened', `Opened ${want}`)
        return { ok: true, launched: want }
      }
      const lnk = await findStartMenuShortcut(want)
      if (!lnk) return { error: `Couldn’t find an app called “${want}” in the Start menu.` }
      const err = await shell.openPath(lnk)
      if (err) return { error: err }
      host.activity('app.opened', `Opened ${basename(lnk).replace(/\.(lnk|url)$/i, '')}`)
      return { ok: true, launched: basename(lnk).replace(/\.(lnk|url)$/i, '') }
    }
    case 'list_folder': {
      const p = ensureInHome(resolveUserPath(str('path') || 'Downloads'), await host.extraRoots())
      const entries = await readdir(p, { withFileTypes: true })
      const items = await Promise.all(
        entries.slice(0, 200).map(async (e) => {
          const st = await stat(join(p, e.name)).catch(() => null)
          return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', size: st?.size, modified: st?.mtime.toISOString() }
        })
      )
      return { path: p, count: entries.length, items }
    }
    case 'read_file': {
      const p = (await resolveToolPath(host, str('path'))).path
      const buf = await readFile(p)
      if (buf.subarray(0, 4000).includes(0)) return { error: 'That is a binary file.' }
      return { path: p, content: buf.subarray(0, 100_000).toString('utf8'), truncated: buf.length > 100_000 }
    }
    case 'edit_file': {
      const p = (await resolveToolPath(host, str('path'))).path
      if (!existsSync(p)) return { error: `Nothing exists at “${p}”. Use create_file for new files.` }
      const find = str('find')
      if (!find) return { error: '`find` is empty.' }
      const before = await readFile(p, 'utf8')
      const count = before.split(find).length - 1
      if (!count) return { error: `The text to find isn’t in ${basename(p)}. read_file it again and copy the exact text (whitespace matters).` }
      if (count > 1 && args['all'] !== true) return { error: `That text appears ${count} times in ${basename(p)}. Include more surrounding lines so it is unique, or pass all=true.` }
      const after = args['all'] === true ? before.split(find).join(str('replace')) : before.replace(find, () => str('replace'))
      await writeFile(p, after, 'utf8')
      host.activity('file.created', `Edited ${basename(p)}`, p, 'success')
      return { ok: true, path: p, replaced: args['all'] === true ? count : 1 }
    }
    case 'list_tree': {
      const root = (await resolveToolPath(host, str('path'))).path
      if (!existsSync(root)) return { error: `Nothing exists at “${root}”.` }
      const lines: string[] = []
      const walk = async (dir: string, depth: number) => {
        if (depth > 6 || lines.length >= 400) return
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
          if (lines.length >= 400) return
          if (/^(node_modules|\.git|dist|build|\.next|__pycache__)$/.test(e.name)) continue
          const full = join(dir, e.name)
          if (e.isDirectory()) {
            lines.push(`${relative(root, full)}/`)
            await walk(full, depth + 1)
          } else {
            const st = await stat(full).catch(() => null)
            lines.push(`${relative(root, full)}${st ? ` (${st.size} B)` : ''}`)
          }
        }
      }
      await walk(root, 0)
      return { root, files: lines, truncated: lines.length >= 400 }
    }
    case 'check_site': {
      const target = str('target').trim()
      const isUrl = /^https?:\/\//i.test(target)
      const entry = isUrl ? target : (await resolveToolPath(host, target)).path
      if (!isUrl && !existsSync(entry)) return { error: `Nothing exists at “${entry}”.` }
      const r = await checkSite(entry)
      return {
        ok: r.ok,
        title: r.title,
        consoleErrors: r.consoleErrors,
        failedRequests: r.failedRequests,
        visibleText: r.textSample.slice(0, 900),
        verdict: r.ok ? 'No console errors or missing files.' : 'Fix every error above (edit_file), then run check_site again.'
      }
    }
    case 'run_command': {
      const command = str('command')
      if (!command.trim()) return { error: 'No command given.' }
      const ws = await host.workspace()
      const cwd = str('cwd') ? (await resolveToolPath(host, str('cwd'))).path : existsSync(ws.path) ? ws.path : HOME
      const shellName = str('shell').toLowerCase() === 'cmd' ? 'cmd' : 'powershell'
      const t = typeof args['timeout_seconds'] === 'number' && Number.isFinite(args['timeout_seconds']) ? (args['timeout_seconds'] as number) * 1000 : undefined
      const r = await host.runCommand(command, { cwd, shell: shellName, background: args['background'] === true, timeoutMs: t, signal })
      return {
        ok: r.ok,
        status: r.status,
        exitCode: r.exitCode,
        summary: r.summary,
        risk: r.risk,
        shell: r.shell,
        cwd: r.cwd,
        ...(r.url ? { url: r.url } : {}),
        ...(r.runId && r.status === 'running' ? { runId: r.runId } : {}),
        output: r.output.slice(-8000),
        ...(r.ok ? {} : { note: r.status === 'failed' ? 'The command ran but FAILED. Read the output, fix the cause and retry, or explain the error to the user.' : 'The command did NOT run successfully. Do not claim it worked.' })
      }
    }
    case 'get_workspace': {
      const ws = await host.workspace()
      const projects = await host.projects().catch(() => [])
      return { workspace: ws.path, name: ws.name, selectedProject: ws.selected, exists: existsSync(ws.path), projects: projects.slice(0, 30).map((p) => ({ name: p.name, path: p.path })) }
    }
    case 'inspect_project': {
      const root = (await resolveToolPath(host, str('path'))).path
      if (!existsSync(root)) return { error: `Nothing exists at “${root}”.` }
      const plan = await inspectProject(root)
      return {
        ok: true,
        ...plan,
        files: plan.files.slice(0, 40),
        next: plan.run
          ? `${plan.install ? `Run "${plan.install}" first (dependencies are missing), then ` : 'Run '}"${plan.run}" with run_command${plan.runIsServer ? ' and background=true, then open the URL it prints' : ''}.`
          : plan.open
            ? `Open ${plan.open} with the open tool.`
            : 'Explain to the user what you found and ask how they normally start it.'
      }
    }
    case 'open_project': {
      const want = str('name').trim().toLowerCase()
      const ws = await host.workspace()
      const list = await host.projects().catch(() => [])
      const match = want
        ? (list.find((p) => p.name.toLowerCase() === want) ?? list.find((p) => p.name.toLowerCase().includes(want)) ?? list.find((p) => basename(p.path).toLowerCase().includes(want)))
        : ws.selected
          ? { id: '', name: ws.name, path: ws.path }
          : undefined
      if (!match) {
        return { error: want ? `No project called “${str('name')}”. Known projects: ${list.map((p) => p.name).slice(0, 15).join(', ') || 'none yet'}.` : 'No project is selected. Ask which one to open.', projects: list.map((p) => p.name).slice(0, 30) }
      }
      if (!existsSync(match.path)) return { error: `The folder for ${match.name} is missing: ${match.path}` }
      const app = str('app').toLowerCase()
      if (app === 'explorer' || (!findAppExe('vscode') && app !== 'vscode')) {
        const err = await shell.openPath(match.path)
        if (err) return { error: err }
        host.activity('app.opened', `Opened ${match.name} in File Explorer`, match.path)
        host.notifyEvent({ key: `launch:${match.path}`, kind: 'launch', title: 'Project opened', body: `${match.name} in File Explorer`, detail: match.path, timeoutMs: 5000 })
        return { ok: true, opened: match.path, with: 'File Explorer' }
      }
      await host.openInEditor(match.path)
      host.notifyEvent({ key: `launch:${match.path}`, kind: 'launch', title: 'Project opened', body: `${match.name} in VS Code`, detail: match.path, timeoutMs: 5000 })
      return { ok: true, opened: match.path, with: 'VS Code' }
    }
    case 'run_task': {
      const t = await host.runTask(str('instruction'))
      return { started: true, taskId: t.id, title: t.title, status: t.status, note: 'Running in the background; the user can follow it in Tasks.' }
    }
    case 'get_status':
      return { status: await host.status() }
    default:
      return { error: `Unknown tool ${name}` }
  }
}

export const AGENT_GUIDE = [
  'You are a task-execution assistant, not a chatbot: you act on the user’s Windows PC with tools. Work out the user’s OBJECTIVE and deliver the finished result. Never answer a “make / create / build / run / open” request with instructions, code to copy, or steps for the user to do.',
  'MAKING THINGS: for simple web creations (a calculator, game, landing page, timer, to-do app, quiz, clock, converter…) write ONE complete, self-contained HTML file with inline <style> and <script> using create_file at "<short-kebab-name>/index.html" (relative paths go to the workspace), then open it with open, then reply in one or two sentences with what you made and the exact folder path. For files the user names (e.g. “create index.html”), create exactly that name with the requested content.',
  'RUNNING A PROJECT: call inspect_project first, then run the install command it reports (if any) and the run command with run_command (background=true for servers), then open the URL or file it reports, and report the real outcome including errors. OPENING A PROJECT: use open_project.',
  'COMMANDS: use run_command only when a command is really needed — never to create or edit files (use create_file / edit_file). Pick shell="cmd" for Command Prompt syntax. Installs, scripts and changes ask the user for approval automatically; you can’t approve anything yourself. If a result is denied, expired or blocked, stop that operation and tell the user plainly what didn’t happen. If a command failed, read its output and fix the cause or explain it.',
  `Folders: home ${HOME}; Downloads ${KNOWN.downloads}; Desktop ${KNOWN.desktop}; when no project is selected new work goes in ${PROJECTS_DIR}. Call get_workspace if you need to know where things go.`,
  'For questions about current facts, news, prices or anything you are unsure of, use web_search instead of guessing. Use play_media / media_control for music and videos, camera to look through the webcam, weather, system_status, set_timer and clipboard when they fit.',
  'Ask one short clarifying question only when an essential detail is missing and can’t be reasonably assumed. Otherwise pick sensible defaults and proceed.',
  'Never claim something was created, opened, run or done unless the tool result says ok (create_file reports verified:true). If a tool returns an error, say so honestly and suggest a fix.'
].join('\n')

/** Extra instructions for the typed/background agent that builds real multi-file projects. */
export const BUILDER_GUIDE = [
  'BUILDING PROJECTS (websites, web apps, stores, dashboards, games):',
  `1. Pick a folder: "<short-kebab-name>/" inside the workspace (the selected project, otherwise ${PROJECTS_DIR}) unless the user named one. Never put a project loose in Downloads.`,
  '2. Decide the file list first (e.g. index.html, products.html, cart.html, checkout.html, css/styles.css, js/data.js, js/cart.js, js/app.js, assets/…). Say nothing to the user yet — just start writing.',
  '3. Write EVERY file completely with create_file. To finish fast, call create_file for 2–4 files in the SAME response (parallel calls) instead of one file per turn. Real content only: realistic product names, prices and descriptions, working JavaScript (cart in localStorage, quantity changes, totals, search/filter, form validation), responsive modern CSS (CSS variables, grid/flex, hover states, mobile layout). No lorem ipsum, no “TODO”, no “add more here”. Images: use inline SVG, CSS gradients or https://picsum.photos/seed/<word>/600/400 URLs.',
  '4. Plain HTML/CSS/JS that works by opening index.html (no build step, no npm). If the user asks for React, load React + ReactDOM + Babel standalone from unpkg via <script> tags so it still opens directly. Keep each file under ~400 lines; split big scripts into several files. Use relative paths between files.',
  '5. When all files exist, call check_site on index.html (and other key pages). Fix every console error and missing file with edit_file (read_file first), then check again until it reports ok.',
  '6. Open index.html in the browser (open). Finish with 2–4 sentences: what you built, the folder path, and how to use it.',
  'Keep going until the whole project is done — do not stop after a few files and do not ask the user for permission between steps.'
].join('\n')
