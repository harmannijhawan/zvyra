/**
 * Dev-only visual QA (Kiro/UI). Enabled only when ZVYRA_QA_CAPTURE=<dir> is set:
 * captures the main window across routes and the Dynamic Island in each mode
 * to PNG files, then quits. Never active in normal runs.
 */
import type { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IslandMode } from '../../shared/shell'
import type { ZvyraEvent } from '../../shared/contract'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runQaCapture(opts: {
  dir: string
  main: () => BrowserWindow | null
  island: () => BrowserWindow | null
  setIslandMode: (m: IslandMode) => void
  navigate: (route: string) => void
  quit: () => void
  hideIsland?: () => void
  exercise?: () => Promise<unknown>
  /** Sends a synthetic backend event to every window (tool-card QA). */
  inject?: (e: ZvyraEvent) => void
}) {
  await mkdir(opts.dir, { recursive: true })
  const shot = async (win: BrowserWindow | null, name: string) => {
    if (!win || win.isDestroyed()) return
    const img = await win.webContents.capturePage()
    await writeFile(join(opts.dir, `${name}.png`), img.toPNG())
  }
  for (const [label, get] of [['main', opts.main], ['island', opts.island]] as const) {
    get()?.webContents.on('console-message', (...args: unknown[]) => {
      const e = args[0] as { level?: string | number; message?: string }
      const level = e.level ?? args[1]
      const message = e.message ?? args[2]
      if (level === 'error' || level === 3 || level === 'warning' || level === 2) process.stderr.write(`[qa:${label}] ${String(message)}\n`)
    })
  }
  await wait(4000)
  if (process.env['ZVYRA_QA_ONBOARD']) {
    const js = (code: string) => opts.main()?.webContents.executeJavaScript(code, true).catch(() => undefined)
    const click = (sel: string, text?: string) =>
      js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text ? `els.find(e => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}; el && el.click(); return !!el })()`)
    await wait(2500)
    await shot(opts.main(), 'onboard-1-welcome')
    await click('.ob-name button')
    await wait(1500)
    await shot(opts.main(), 'onboard-2-connect')
    await click('.ob-btn', 'Set up later')
    await wait(1200)
    await click('.ob-btn', 'Record')
    await wait(2600)
    await shot(opts.main(), 'onboard-3-voice')
    await wait(3000)
    await click('.ob-btn', 'Continue')
    await wait(1800)
    await shot(opts.main(), 'onboard-4-tour')
    opts.quit()
    return
  }
  const routes = (process.env['ZVYRA_QA_ROUTES'] ?? 'home,chat,tasks,computer,apps,projects,agents,activity,knowledge,memory,automations,settings/swarm,settings/voice').split(',')
  for (const r of routes) {
    opts.navigate(r)
    await wait(900)
    await shot(opts.main(), `main-${r.replace(/\//g, '_')}`)
  }
  for (const m of ['compact', 'expanded', 'mini'] as IslandMode[]) {
    opts.setIslandMode(m)
    await wait(900)
    await shot(opts.island(), `island-${m}`)
  }
  // Live tool cards: research (running → done with sources), then a build and media card.
  if (process.env['ZVYRA_QA_TOOL_SHOTS'] && opts.inject) {
    opts.setIslandMode('compact')
    const at = () => new Date().toISOString()
    const research = { id: 'qa-r', tool: 'web_search', kind: 'research' as const, label: 'Researching', subject: 'best budget laptops 2026', status: 'running' as const, startedAt: at(), updatedAt: at() }
    opts.inject({ type: 'tool.activity', payload: research })
    await wait(700)
    await shot(opts.island(), 'island-tool-research-running')
    opts.inject({
      type: 'tool.activity',
      payload: {
        ...research,
        status: 'done',
        updatedAt: at(),
        summary: 'Top picks under $600: Acer Aspire Go 15 for everyday work, Lenovo IdeaPad Slim 3 for battery life, and ASUS Vivobook 16 for a bigger screen.',
        sources: [
          { title: 'pcmag.com', url: 'https://www.pcmag.com/picks/the-best-budget-laptops' },
          { title: 'tomsguide.com', url: 'https://www.tomsguide.com/best-picks/best-budget-laptops' },
          { title: 'rtings.com', url: 'https://www.rtings.com/laptop' }
        ]
      }
    })
    await wait(1600)
    await shot(opts.island(), 'island-tool-research-done')
    opts.inject({ type: 'tool.activity', payload: { id: 'qa-b', tool: 'run_task', kind: 'build', label: 'Building', subject: 'E-commerce site for sneakers', status: 'running', steps: ['Writing index.html', 'Writing styles.css', 'Writing cart.js'], summary: '3 files written', startedAt: at(), updatedAt: at() } })
    opts.inject({ type: 'tool.activity', payload: { id: 'qa-m', tool: 'play_media', kind: 'media', label: 'Playing on YouTube', subject: 'lofi hip hop', status: 'done', summary: 'lofi hip hop radio — Lofi Girl', startedAt: at(), updatedAt: at() } })
    await wait(1400)
    await shot(opts.island(), 'island-tool-stack')
  }
  // Voice timeline: hide the island, then snapshot it while a wake-word clip plays.
  if (process.env['ZVYRA_QA_VOICE_SHOTS']) {
    opts.hideIsland?.()
    for (let i = 1; i <= 10; i++) {
      await wait(2500)
      const win = opts.island()
      process.stderr.write(`[qa] t+${i * 2.5}s island visible=${win?.isVisible()}\n`)
      if (win?.isVisible()) await shot(win, `island-voice-${String(i).padStart(2, '0')}`)
    }
  }
  // Preview-backend only: drive one simulated task through planning → approval.
  if (opts.exercise) {
    opts.setIslandMode('expanded')
    await opts.exercise().catch((e: unknown) => process.stderr.write(`[qa] exercise failed: ${String((e as Error)?.message ?? e)}\n`))
    await wait(Number(process.env['ZVYRA_QA_WAIT_MS'] ?? 2200))
    await shot(opts.island(), 'island-task-running')
    await wait(3500)
    await shot(opts.island(), 'island-task-permission')
    opts.navigate('home')
    await wait(900)
    await shot(opts.main(), 'main-home-after')
    opts.navigate('tasks')
    await wait(900)
    await shot(opts.main(), 'main-tasks-live')
  }
  opts.setIslandMode('compact')
  await wait(300)
  opts.quit()
}
