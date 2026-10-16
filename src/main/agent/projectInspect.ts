/**
 * OWNER: Kiro. Works out what a project is and how to run it, from the files
 * on disk (no guessing from the folder name): package.json scripts and
 * dependencies, lockfiles, Python entry points, static sites, .NET, Rust, Go.
 * Used by the `inspect_project` tool so "run this project" picks the right
 * install + launch commands before asking for approval.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProjectPlan {
  root: string
  kind: 'node' | 'python' | 'static' | 'dotnet' | 'rust' | 'go' | 'java' | 'unknown'
  framework: string | null
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | null
  /** Command to install dependencies, when they are missing. */
  install: string | null
  /** Command that launches the project. */
  run: string | null
  /** True when `run` starts a long-running server (run it in the background). */
  runIsServer: boolean
  /** File to open directly (static sites). */
  open: string | null
  scripts: Record<string, string>
  files: string[]
  notes: string[]
}

const NODE_FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@remix-run/dev', 'Remix'],
  ['astro', 'Astro'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['electron', 'Electron'],
  ['vite', 'Vite'],
  ['react-scripts', 'Create React App'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['react', 'React'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS']
]

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function inspectProject(root: string): Promise<ProjectPlan> {
  const st = await stat(root).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`Not a folder: ${root}`)
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => [])).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  const has = (f: string) => entries.includes(f)
  const plan: ProjectPlan = { root, kind: 'unknown', framework: null, packageManager: null, install: null, run: null, runIsServer: false, open: null, scripts: {}, files: entries.slice(0, 60), notes: [] }

  const pkg = has('package.json') ? await readJson(join(root, 'package.json')) : null
  if (pkg) {
    plan.kind = 'node'
    const pm: ProjectPlan['packageManager'] = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    plan.packageManager = pm
    const scripts = (pkg['scripts'] ?? {}) as Record<string, string>
    plan.scripts = scripts
    const deps = { ...((pkg['dependencies'] ?? {}) as Record<string, string>), ...((pkg['devDependencies'] ?? {}) as Record<string, string>) }
    plan.framework = NODE_FRAMEWORKS.find(([d]) => d in deps)?.[1] ?? null
    const hasDeps = Object.keys(deps).length > 0
    if (hasDeps && !has('node_modules/')) plan.install = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`
    const runScript = (name: string) => (pm === 'npm' ? (name === 'start' ? 'npm start' : `npm run ${name}`) : `${pm} ${name === 'start' ? 'start' : `run ${name}`}`)
    const pick = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s])
    if (pick) {
      plan.run = runScript(pick)
      plan.runIsServer = /vite|next|nuxt|astro|react-scripts|webpack(-dev-server| serve)|serve|http-server|nodemon|electron|express|node .*server|ng serve|remix|svelte-kit/i.test(scripts[pick]) || pick !== 'start' || !!plan.framework
    } else if (typeof pkg['main'] === 'string' && existsSync(join(root, pkg['main']))) {
      plan.run = `node ${JSON.stringify(pkg['main'])}`
    } else if (has('index.js') || has('server.js') || has('app.js')) {
      plan.run = `node ${has('server.js') ? 'server.js' : has('app.js') ? 'app.js' : 'index.js'}`
      plan.runIsServer = has('server.js')
    } else if (has('index.html')) {
      plan.open = join(root, 'index.html')
      plan.notes.push('No start script: index.html can be opened directly.')
    }
    if (!plan.run && !plan.open) plan.notes.push('package.json has no dev/start script.')
    return plan
  }

  if (has('manage.py') || has('requirements.txt') || has('pyproject.toml') || has('app.py') || has('main.py')) {
    plan.kind = 'python'
    plan.packageManager = 'pip'
    const reqs = has('requirements.txt') ? await readFile(join(root, 'requirements.txt'), 'utf8').catch(() => '') : ''
    const venv = has('.venv/') || has('venv/')
    if (reqs.trim() && !venv) plan.install = 'python -m pip install -r requirements.txt'
    if (has('manage.py')) {
      plan.framework = 'Django'
      plan.run = 'python manage.py runserver'
      plan.runIsServer = true
    } else if (/^\s*streamlit/im.test(reqs)) {
      plan.framework = 'Streamlit'
      plan.run = `python -m streamlit run ${has('app.py') ? 'app.py' : 'main.py'}`
      plan.runIsServer = true
    } else if (has('app.py') || has('main.py')) {
      const entry = has('app.py') ? 'app.py' : 'main.py'
      const src = await readFile(join(root, entry), 'utf8').catch(() => '')
      plan.framework = /from flask|import flask/i.test(src) ? 'Flask' : /fastapi/i.test(src) ? 'FastAPI' : null
      plan.run = plan.framework === 'FastAPI' ? `python -m uvicorn ${entry.replace(/\.py$/, '')}:app --reload` : `python ${entry}`
      plan.runIsServer = !!plan.framework
    }
    if (venv) plan.notes.push('A virtual environment folder exists; activate it if the packages are installed there.')
    return plan
  }

  if (entries.some((e) => /\.(sln|csproj)$/i.test(e))) {
    plan.kind = 'dotnet'
    plan.run = 'dotnet run'
    return plan
  }
  if (has('Cargo.toml')) {
    plan.kind = 'rust'
    plan.run = 'cargo run'
    return plan
  }
  if (has('go.mod')) {
    plan.kind = 'go'
    plan.run = 'go run .'
    return plan
  }
  if (has('pom.xml') || has('build.gradle') || has('gradlew')) {
    plan.kind = 'java'
    plan.run = has('gradlew') ? '.\\gradlew run' : has('pom.xml') ? 'mvn -q compile exec:java' : 'gradle run'
    plan.notes.push('Java projects often need a configured main class; check the build file if this fails.')
    return plan
  }
  if (has('index.html')) {
    plan.kind = 'static'
    plan.framework = 'Static website'
    plan.open = join(root, 'index.html')
    return plan
  }
  const html = entries.find((e) => /\.html?$/i.test(e))
  if (html) {
    plan.kind = 'static'
    plan.open = join(root, html)
    return plan
  }
  plan.notes.push('Couldn’t recognise this project type from its files.')
  return plan
}
