import { z } from 'zod'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { contrast } from './designBrief'

const text = z.string().trim().min(1).max(2000)
const list = z.array(text).min(1).max(40)
const color = z.string().regex(/^#[0-9a-f]{6}$/i)
const file = z.string().max(200).refine(p => !/^(?:[a-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(p), 'Use project-relative paths without traversal')

/** The model composes this in its normal tool turn: no extra planning inference. */
export const websiteDesignSchema = z.object({
  purpose: text, audience: text, personality: text,
  direction: text, rationale: text,
  tokens: z.object({ background: color, surface: color, text: color, muted: color, accent: color,
    displayFont: text, bodyFont: text, typeScale: list, spacing: list, radius: text }),
  layout: z.object({ grid: text, density: text, composition: text, responsive: list }),
  pages: z.array(z.object({ route: z.string().regex(/^\/(?!\/)[^\s?#]*$/), purpose: text,
    sections: z.array(z.object({ name: text, purpose: text, composition: text, components: list })).min(1).max(20) })).min(1).max(30),
  components: z.array(z.object({ name: text, file, behavior: text, states: list })).min(1).max(60),
  assets: z.array(z.object({ purpose: text, subject: text, aspectRatio: text, maxWidth: z.number().int().min(64).max(3840),
    source: text, treatment: text, fallback: text })).max(30),
  interactions: list, accessibility: list,
  implementation: z.object({ stack: text, files: z.array(file).min(1).max(100), dependencies: z.array(text).max(30),
    order: list, validation: list, requiredConfiguration: z.array(text).max(30) })
}).superRefine((s, ctx) => {
  if (contrast(s.tokens.text, s.tokens.background) < 4.5 || contrast(s.tokens.muted, s.tokens.background) < 4.5)
    ctx.addIssue({ code: 'custom', message: 'Text and muted tokens must meet WCAG AA (4.5:1) on the background.' })
  if (new Set(s.pages.map(p => p.route)).size !== s.pages.length)
    ctx.addIssue({ code: 'custom', message: 'Routes must be unique.' })
  const names = new Set(s.components.map(c => c.name))
  for (const p of s.pages) for (const section of p.sections) for (const name of section.components)
    if (!names.has(name)) ctx.addIssue({ code: 'custom', message: `Section references unspecified component: ${name}` })
})
export type WebsiteDesign = z.infer<typeof websiteDesignSchema>

export function designTokens(s: WebsiteDesign): string {
  const t = s.tokens
  // Only validated hex values enter executable CSS; font/size descriptions remain design data.
  return `:root{--bg:${t.background};--surface:${t.surface};--text:${t.text};--muted:${t.muted};--accent:${t.accent};}`
}

export async function saveWebsiteDesign(root: string, input: unknown, expectedRevision?: string) {
  const specification = websiteDesignSchema.parse(input)
  const directory = join(root, '.zvyra')
  const path = join(directory, 'website-design.json')
  let previous: { revision?: string } | undefined
  try { previous = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (previous && previous.revision !== expectedRevision) throw new Error('Design changed or already exists. Read .zvyra/website-design.json and supply its revision before updating; preserve unrelated decisions.')
  const revision = createHash('sha256').update(JSON.stringify(specification)).digest('hex')
  const result = { version: 1, revision, specification, tokensCss: designTokens(specification) }
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `design-${crypto.randomUUID()}.tmp`)
  await writeFile(temp, JSON.stringify(result, null, 2), 'utf8')
  await rename(temp, path)
  return { ...result, path }
}

export const WEBSITE_GUIDE = `WEBSITE ENGINE: Before website source edits, inspect the existing project and read .zvyra/website-design.json if present. Use design_brief with project_dir and specification_json to commit a tailored design contract; pass expected_revision when revising it. Compose the contract in the current turn, without a separate planning model call. It must describe the actual requested pages, components, interactions, responsive layout, assets, configuration boundaries and validation. The tool returns the required schema when missing. Category directions are inspiration, not mandatory templates. Invent a composition appropriate to the audience; do not append unrequested testimonial/stat/feature sections. Never use build_business_site for a custom website.
Implement the committed pages/components and tokens through normal file tools. Preserve the existing stack and working files. Use edit_file for existing code, create_file only for new files. Read relevant components instead of scanning the whole project repeatedly. Reuse the saved contract on follow-up edits, changing only requested decisions. Include real empty/loading/error/success states and keyboard/mobile navigation; do not represent local sample data as a live backend. Record missing credentials/services in requiredConfiguration and implement explicit integration boundaries. Never embed secrets in browser code.
Use downloaded asset variants/srcset and sizes, real width/height, suitable object-fit/object-position, eager high-priority hero and lazy below-fold images; preserve attribution. No fake 4K claims or broken placeholder URLs.
Run the project's available build/typecheck/tests once after coherent edits using run_command; inspect its actual scripts first. Run check_site against the working preview URL (dev server for framework projects), with routes from the design and review=true. Repair only reported defects; recheck affected routes before a final comprehensive check. Use browser tools to test requested interactive behaviors without making real payments or submitting external forms. Deliver preview, actual checks and precise configuration blockers.`
