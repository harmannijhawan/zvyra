// Production pipeline acceptance runner. No model key or fabricated research.
// node scripts/research-build-check.mjs <public-business-url> <output-folder>
import { build } from '../backend/node_modules/esbuild/lib/main.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// node scripts/research-build-check.mjs "<business name>" <output-folder> "<location>"
const [target, output, location] = process.argv.slice(2)
if (!target || !output) throw new Error('Provide a public business URL (or a business name and location) and an output folder')
const query = /^https?:\/\//i.test(target) ? { url: target } : { name: target, location: location ?? '' }
const work = mkdtempSync(join(tmpdir(), 'zvyra-acceptance-'))
const entry = join(work, 'entry.ts')
const project = resolve(output)
writeFileSync(entry, `
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { researchBusiness } from ${JSON.stringify(resolve('src/main/research/business.ts'))}
import { renderPage } from ${JSON.stringify(resolve('src/main/research/render.ts'))}
import { downloadAssets } from ${JSON.stringify(resolve('src/main/research/assets.ts'))}
import { buildBusinessSite } from ${JSON.stringify(resolve('src/main/agent/businessSite.ts'))}
import { checkSite } from ${JSON.stringify(resolve('src/main/agent/siteCheck.ts'))}
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
 const project = ${JSON.stringify(project)}
 try {
  const research = await researchBusiness({...${JSON.stringify(query)}, saveTo:project}, {render:renderPage, progress:(s) => console.log('[research]', s)})
  const assets = await downloadAssets(research.dossier, project, {max:10})
  await writeFile(research.path!, JSON.stringify(research.dossier,null,2))
  const site = await buildBusinessSite(research.path!,project)
  const qa = await checkSite(project)
  const result = {research:research.summary,assets,site,qa:{...qa,screenshotJpegBase64:undefined}}
  await writeFile(join(project,'acceptance.json'),JSON.stringify(result,null,2))
  const o = research.summary.outcome
  await writeFile(${JSON.stringify(join(work, 'result.json'))}, JSON.stringify({ok:qa.ok,status:o.status,pages:o.pagesRead,menu:o.menuItems,menuTranscribed:o.menuItemsTranscribed,menuDocs:o.menuDocuments,menuDocsRead:o.menuDocumentsRead,images:assets.saved.length,discovery:research.dossier.discovery,sources:research.dossier.sources.map((s)=>s.status+' '+s.url+(s.note?' — '+s.note:'')),missing:o.missing,issues:qa.issues,report:join(project,'acceptance.json')},null,1))
  app.exit(qa.ok?0:1)
 } catch(e) {await mkdir(project,{recursive:true});await writeFile(${JSON.stringify(join(work, 'result.json'))},JSON.stringify({ok:false,error:String(e)}));app.exit(1)}
})`)
await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:join(work,'main.cjs'),external:['electron'],logLevel:'error'})
const child = spawnSync(resolve('node_modules/electron/dist/electron.exe'),[join(work,'main.cjs'),`--user-data-dir=${join(work,'profile')}`],{encoding:'utf8',timeout:300000,windowsHide:true})
try { console.log(readFileSync(join(work,'result.json'),'utf8')) } catch { console.log(JSON.stringify({ok:false,status:child.status,error:child.error?.message,stderr:child.stderr?.slice(-1500)})) }
process.exitCode = child.status ?? 1
