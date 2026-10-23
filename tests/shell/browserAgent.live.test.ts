/**
 * Opt-in (ZVYRA_LIVE_BROWSER=1): drives the installed Edge/Chrome headlessly
 * against a local page. Checks DOM refs, typing with read-back, approval gates
 * for submit buttons, password refusal and login detection.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BrowserAgent } from '../../src/main/tools/browserAgent'
import { serveStatic } from '../../src/main/agent/staticServer'

describe.skipIf(!process.env['ZVYRA_LIVE_BROWSER'])('browser agent (live, headless)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zvyra-browser-'))
  const asked: string[] = []
  let allow = false
  const agent = new BrowserAgent({ profileDir: join(dir, 'profile'), downloadsDir: join(dir, 'dl'), headless: true, approve: async (t) => (asked.push(t), allow) })
  afterAll(async () => {
    await agent.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads, types, gates submits and refuses passwords', async () => {
    writeFileSync(
      join(dir, 'index.html'),
      `<!doctype html><title>Order</title><a href="/next.html">Next page</a><form onsubmit="event.preventDefault(); document.title='Sent'"><label>Name <input name="n"></label><label>Password <input type="password" name="p"></label><button type="submit">Place order</button></form>`
    )
    writeFileSync(join(dir, 'next.html'), '<!doctype html><title>Next</title><p>Hello</p>')
    const url = await serveStatic(dir)
    const s = await agent.goto(url)
    expect(s.title).toBe('Order')
    expect(s.signals.login).toBe(true)
    const name = s.elements.find((e) => e.name.startsWith('Name') || e.type === 'text')!
    const pass = s.elements.find((e) => e.type === 'password')!
    const submit = s.elements.find((e) => e.name === 'Place order')!
    expect((await agent.type(name.ref, 'Asha')).verified).toBe(true)
    await expect(agent.type(pass.ref, 'secret')).rejects.toThrow(/does not type passwords/)
    expect((await agent.click(submit.ref)).clicked).toBe(false)
    expect(asked[0]).toMatch(/Place order/)
    expect((await agent.snapshot()).title).toBe('Order')
    allow = true
    await agent.click(submit.ref)
    expect((await agent.snapshot()).title).toBe('Sent')
    const link = (await agent.snapshot()).elements.find((e) => e.name === 'Next page')!
    const after = (await agent.click(link.ref)) as { navigated?: boolean; title?: string }
    expect(after.navigated).toBe(true)
    expect(after.title).toBe('Next')
  }, 60_000)
})
