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
      'Create (or overwrite) a text file on the user’s PC with the given content — HTML pages, CSS, JavaScript, notes, code, CSV, etc. Missing folders are created. Paths may be absolute, start with ~ or a known folder (Downloads, Desktop, Documents, Projects = Documents/ZVYRA Projects), or be a bare filename (saved in Downloads). Write complete, polished, working content — never placeholders or TODOs.',
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
    description: 'Run a PowerShell command. The user is always asked to confirm in a dialog first. Returns output.',
    parameters: { type: Type.OBJECT, properties: { command: { type: Type.STRING }, cwd: { type: Type.STRING } }, required: ['command'] }
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

export interface DesktopToolHost {
  activity(type: string, title: string, detail?: string, level?: 'info' | 'success' | 'warning' | 'error'): void
  runCommand(command: string, cwd?: string): Promise<{ exitCode: number | null; output: string; status: string }>
  runTask(instruction: string): Promise<{ id: string; title: string; status: string }>
  status(): Promise<string>
  extraRoots(): Promise<string[]>
  userApps(): { id: string; name: string; path?: string }[]
  launchUserApp(id: string): Promise<void>
}

export type ToolResult = Record<string, unknown>

export async function runDesktopTool(host: DesktopToolHost, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'create_file': {
      const p = ensureInHome(resolveUserPath(str('path')), await host.extraRoots())
      const exists = existsSync(p)
      if (exists && args['overwrite'] !== true) return { error: `“${p}” already exists. Call again with overwrite=true to replace it, or choose another name.` }
      await mkdir(dirname(p), { recursive: true })
      const content = str('content')
      await writeFile(p, content, 'utf8')
      host.activity('file.created', `${exists ? 'Updated' : 'Created'} ${basename(p)}`, p, 'success')
      return { ok: true, path: p, bytes: Buffer.byteLength(content) }
    }
    case 'open': {
      const target = str('target').trim()
      const app = str('app').trim().toLowerCase()
      const isUrl = /^https?:\/\//i.test(target) || (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(target) && !existsSync(resolveUserPath(target)))
      const url = isUrl ? (/^https?:/i.test(target) ? target : `https://${target}`) : null
      const path = url ? null : ensureInHome(resolveUserPath(target), await host.extraRoots())
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
        return { ok: true, openedWith: app }
      }
      if (url) await shell.openExternal(url)
      else {
        const err = await shell.openPath(path!)
        if (err) return { error: err }
      }
      host.activity('app.opened', `Opened ${url ?? basename(path!)}`, url ?? path!)
      return { ok: true }
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
      const p = ensureInHome(resolveUserPath(str('path')), await host.extraRoots())
      const buf = await readFile(p)
      if (buf.subarray(0, 4000).includes(0)) return { error: 'That is a binary file.' }
      return { path: p, content: buf.subarray(0, 100_000).toString('utf8'), truncated: buf.length > 100_000 }
    }
    case 'edit_file': {
      const p = ensureInHome(resolveUserPath(str('path')), await host.extraRoots())
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
      const root = ensureInHome(resolveUserPath(str('path') || 'Projects'), await host.extraRoots())
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
      const entry = isUrl ? target : ensureInHome(resolveUserPath(target), await host.extraRoots())
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
      const cwd = str('cwd') ? ensureInHome(resolveUserPath(str('cwd'), HOME), await host.extraRoots()) : undefined
      const r = await host.runCommand(str('command'), cwd)
      return { status: r.status, exitCode: r.exitCode, output: r.output.slice(-8000) }
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
  'You can act on the user’s Windows PC directly with tools. When asked to make something, actually make it with create_file, then open it with open (pass app:"brave" etc. if the user names a browser). Confirm what you did in one short sentence including the file name.',
  `The user’s home folder is ${HOME}; Downloads is ${KNOWN.downloads}; Desktop is ${KNOWN.desktop}; new projects go in ${PROJECTS_DIR}.`,
  'For questions about current facts, news, prices or anything you are unsure of, use web_search instead of guessing. Use play_media / media_control for music and videos, camera to look through the webcam, weather, system_status, set_timer and clipboard when they fit.',
  'Never claim something was created, opened or done unless the tool result says ok. If a tool returns an error, explain it briefly and suggest a fix.'
].join('\n')

/** Extra instructions for the typed/background agent that builds real multi-file projects. */
export const BUILDER_GUIDE = [
  'BUILDING PROJECTS (websites, web apps, stores, dashboards, games):',
  `1. Pick a folder: ${PROJECTS_DIR}\\<short-kebab-name> unless the user named one. Never put a project loose in Downloads.`,
  '2. Decide the file list first (e.g. index.html, products.html, cart.html, checkout.html, css/styles.css, js/data.js, js/cart.js, js/app.js, assets/…). Say nothing to the user yet — just start writing.',
  '3. Write EVERY file completely with create_file. To finish fast, call create_file for 2–4 files in the SAME response (parallel calls) instead of one file per turn. Real content only: realistic product names, prices and descriptions, working JavaScript (cart in localStorage, quantity changes, totals, search/filter, form validation), responsive modern CSS (CSS variables, grid/flex, hover states, mobile layout). No lorem ipsum, no “TODO”, no “add more here”. Images: use inline SVG, CSS gradients or https://picsum.photos/seed/<word>/600/400 URLs.',
  '4. Plain HTML/CSS/JS that works by opening index.html (no build step, no npm). If the user asks for React, load React + ReactDOM + Babel standalone from unpkg via <script> tags so it still opens directly. Keep each file under ~400 lines; split big scripts into several files. Use relative paths between files.',
  '5. When all files exist, call check_site on index.html (and other key pages). Fix every console error and missing file with edit_file (read_file first), then check again until it reports ok.',
  '6. Open index.html in the browser (open). Finish with 2–4 sentences: what you built, the folder path, and how to use it.',
  'Keep going until the whole project is done — do not stop after a few files and do not ask the user for permission between steps.'
].join('\n')
