// Quality gates: dependencies, typecheck, lint, build, unit tests, app start,
// browser test, console errors, responsive layout, visual QA and review.
// Every gate result comes from an operation that actually ran.
import fs from 'node:fs';
import { timeOperation } from '../core/performance';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GateId, Task, VisualIssue } from '../../shared/types';
import { db } from '../core/db';
import { discoverArtifacts } from '../core/artifacts';
import { getCachedToolchains } from '../core/toolchain';
import { emit } from '../core/bus';
import { CancelledError, errMsg, tail, uid } from '../core/util';
import { runCommand, stopCommand, listLive } from '../tools/process';
import { freePort, serveStatic, waitForHttp } from '../tools/staticServer';
import { openSession, type BrowserSession } from '../browser/browser';
import { auditPage, type DomIssue } from '../browser/domAudit';
import { NoModelError } from '../router/router';
import { IGNORED_DIRS, readFile } from '../tools/fs';
import { callJson, callModel, fsCtx } from './runtime';
import type { RunContext } from './runContext';
import { extractJson } from '../core/util';
import type { ContentPart } from '../providers/types';

export interface GateFailure { gate: GateId; summary: string; details: string }

interface Pkg { 
  scripts?: Record<string, string>; 
  dependencies?: Record<string, string>; 
  devDependencies?: Record<string, string>;
  main?: string;
  module?: string;
  exports?: any;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
}

function readPkg(root: string): { pkg: Pkg | null; error: string | null } {
  const p = path.join(root, 'package.json');
  if (!fs.existsSync(p)) return { pkg: null, error: null };
  try { return { pkg: JSON.parse(fs.readFileSync(p, 'utf8')) as Pkg, error: null }; }
  catch (e) { return { pkg: null, error: `package.json is not valid JSON: ${errMsg(e)}` }; }
}

const pm = (ctx: RunContext) => ctx.settings.execution.packageManager;
const runScript = (ctx: RunContext, name: string) => (pm(ctx) === 'pnpm' ? `pnpm run ${name}` : `npm run ${name}`);

async function gateCommand(ctx: RunContext, task: Task, gate: GateId, command: string, timeoutMs?: number): Promise<GateFailure | null> {
  ctx.setGate(gate, 'running');
  ctx.touchAgent('tester', { status: 'working', lastAction: `Running ${command}` });
  const endTest = timeOperation('test', ctx.run.id);
  const r = await runCommand({ projectId: ctx.project.id, cwd: ctx.root, command, runId: ctx.run.id, taskId: task.id, agent: 'tester', autonomy: ctx.run.options.autonomy, signal: ctx.signal, timeoutMs }).finally(endTest);
  ctx.run.stats.commands++;
  if (r.denied) { ctx.setGate(gate, 'skipped', `Not run: ${r.output}`); return null; }
  if (r.ok) { ctx.setGate(gate, 'passed', `${command} exited 0`); return null; }
  const detail = tail(r.output, 4000);
  ctx.setGate(gate, 'failed', `${command} exited ${r.exitCode ?? r.exec.status}`);
  return { gate, summary: `\`${command}\` failed (exit ${r.exitCode ?? r.exec.status})`, details: detail };
}

let installHash = new Map<string, string>();

export async function runTestGates(ctx: RunContext, task: Task): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  const failures: GateFailure[] = [];
  const warnings: string[] = [];
  const s = ctx.settings;
  const strict = s.behavior.verification === 'strict';
  const basic = s.behavior.verification === 'basic';
  const { pkg, error } = readPkg(ctx.root);
  const arch = ctx.architecture;
  const hasNodeModules = fs.existsSync(path.join(ctx.root, 'node_modules'));
  
  // Platform detection
  const platform = ctx.run.brief?.platform ?? ctx.run.target;
  if (!platform) throw new Error('Cannot verify without a resolved target');

  // --- deps
  if (error) {
    ctx.setGate('deps', 'failed', error);
    return { failures: [{ gate: 'deps', summary: error, details: error }], url: null, warnings };
  }
  if (pkg && (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length)) {
    const hash = createHash('sha256').update(JSON.stringify([pkg.dependencies, pkg.devDependencies, pm(ctx), ...['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(f => fs.existsSync(path.join(ctx.root, f)) ? fs.readFileSync(path.join(ctx.root, f), 'utf8') : '')])).digest('hex');
    if (hasNodeModules && (installHash.get(ctx.root) === hash || db().kvGet('install:' + ctx.root) === hash)) ctx.setGate('deps', 'passed', 'Dependencies unchanged since last install');
    else {
      const cmd = arch?.commands.install && /^(npm|pnpm|yarn)\b/.test(arch.commands.install) ? arch.commands.install : pm(ctx) === 'pnpm' ? 'pnpm install' : 'npm install --no-audit --no-fund';
      const f = await gateCommand(ctx, task, 'deps', cmd, Math.max(s.execution.timeoutSec, 600) * 1000);
      if (f) return { failures: [f], url: null, warnings };
      if (ctx.run.gates.find(g => g.id === 'deps')?.status === 'passed') { installHash.set(ctx.root, hash); db().kvSet('install:' + ctx.root, hash); }
    }
  } else ctx.setGate('deps', 'skipped', pkg ? 'No dependencies declared' : 'No package.json (static or non-Node project)');

  // --- typecheck
  const hasTs = fs.existsSync(path.join(ctx.root, 'tsconfig.json')) && fs.existsSync(path.join(ctx.root, 'node_modules', 'typescript'));
  if (basic) ctx.setGate('typecheck', 'skipped', 'Skipped at Basic verification');
  else if (pkg?.scripts?.typecheck) { const f = await gateCommand(ctx, task, 'typecheck', runScript(ctx, 'typecheck')); if (f) failures.push(f); }
  else if (hasTs) { const f = await gateCommand(ctx, task, 'typecheck', 'npx tsc --noEmit -p .'); if (f) failures.push(f); }
  else ctx.setGate('typecheck', 'skipped', 'No TypeScript configuration');

  // --- lint
  if (pkg?.scripts?.lint && strict) { const f = await gateCommand(ctx, task, 'lint', runScript(ctx, 'lint')); if (f) failures.push(f); }
  else ctx.setGate('lint', 'skipped', pkg?.scripts?.lint ? 'Lint runs at Strict verification' : 'No lint script');

  // --- build
  if (pkg?.scripts?.build) { const f = await gateCommand(ctx, task, 'build', runScript(ctx, 'build'), Math.max(s.execution.timeoutSec, 300) * 1000); if (f) failures.push(f); }
  else ctx.setGate('build', 'skipped', 'No build step');

  // --- unit tests
  const testScript = pkg?.scripts?.test;
  if (testScript && !/no test specified/i.test(testScript) && !basic) { const f = await gateCommand(ctx, task, 'unit', pm(ctx) === 'pnpm' ? 'pnpm test' : 'npm test'); if (f) failures.push(f); }
  else ctx.setGate('unit', 'skipped', testScript ? 'Skipped at Basic verification' : 'No test script');

  if (failures.length) return { failures, url: null, warnings };

  // --- Platform-specific gates
  switch (platform) {
    case 'web':
      return await runWebGates(ctx, task, pkg, arch, strict, failures, warnings);
    case 'windows':
    case 'macos':
    case 'linux':
    case 'desktop':
      return await runDesktopGates(ctx, task, pkg, platform, failures, warnings);
    case 'android':
      return await runAndroidGates(ctx, task, failures, warnings);
    case 'ios':
      return await runIOSGates(ctx, task, failures, warnings);
    case 'cli':
      return await runCLIGates(ctx, task, pkg, failures, warnings);
    case 'backend':
    case 'api':
      return await runBackendGates(ctx, task, pkg, failures, warnings);
    case 'library':
      return await runLibraryGates(ctx, task, pkg, failures, warnings);
    case 'mobile':
      // Generic mobile - skip for now, need more context
      for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
        ctx.setGate(g, 'skipped', 'Mobile platform requires specific platform (Android/iOS)');
      return { failures, url: null, warnings };
    default:
      // Fallback: skip platform-specific gates
      for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
        ctx.setGate(g, 'skipped', `Platform-specific testing not yet implemented for ${platform}`);
      return { failures, url: null, warnings };
  }
}

// ---------------------------------------------------------------- Web Gates
async function runWebGates(ctx: RunContext, task: Task, pkg: Pkg | null, arch: RunContext['architecture'], strict: boolean, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  const s = ctx.settings;
  let url: string;
  try { url = await startApp(ctx, task, pkg); }
  catch (e) {
    if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
    ctx.setGate('server', 'failed', errMsg(e).split('\n')[0]);
    return { failures: [{ gate: 'server', summary: 'The application did not start', details: errMsg(e) }], url: null, warnings };
  }
  ctx.run.previewUrl = url; ctx.saveRun();

  // --- browser test
  if (!s.computer.browser || s.agents.permissions.tester?.browser === false) {
    for (const g of ['browser', 'console', 'responsive'] as GateId[]) ctx.setGate(g, 'skipped', 'Browser automation disabled in Settings');
    return { failures, url, warnings };
  }
  ctx.setGate('browser', 'running');
  ctx.touchAgent('tester', { lastAction: `Opening ${url} in browser` });
  let session: BrowserSession | null = null;
  try {
    session = await openSession({ ...ctx.scope(task), projectId: ctx.project.id }, ctx.root, s.browser.desktop, ctx.signal);
    const status = await session.goto(url);
    const report = await auditPage(session.page, 'desktop');
    const problems: string[] = [];
    if (status >= 400) problems.push(`Home page returned HTTP ${status}`);
    if (report.metrics.textLength < 40) problems.push(`Home page is blank (${report.metrics.textLength} characters rendered)`);
    // Crawl internal links (integration test of routing).
    const crawled: string[] = [];
    if (s.experimental.crawlLinks) {
      for (const link of report.internalLinks.slice(0, s.browser.maxPagesToCrawl)) {
        if (ctx.signal.aborted) throw new CancelledError();
        const st = await session.goto(link).catch((e) => { problems.push(`${link}: ${errMsg(e).split('\n')[0]}`); return 0; });
        if (st >= 400) problems.push(`${new URL(link).pathname} returned HTTP ${st}`);
        crawled.push(`${new URL(link).pathname} → ${st}`);
      }
    }
    // API contract checks from the architecture (GET endpoints without params).
    const apiResults: string[] = [];
    for (const ep of (arch?.api ?? []).filter((a) => a.method.toUpperCase() === 'GET' && !/[:{[]/.test(a.path)).slice(0, 6)) {
      try {
        const res = await fetch(new URL(ep.path, url), { signal: ctx.signal });
        const body = await res.text();
        apiResults.push(`GET ${ep.path} → ${res.status}`);
        if (res.status >= 400) problems.push(`API GET ${ep.path} returned ${res.status}`);
        else if ((res.headers.get('content-type') ?? '').includes('json')) { try { JSON.parse(body); } catch { problems.push(`API GET ${ep.path} returned invalid JSON`); } }
      } catch (e) { if (ctx.signal.aborted) throw new CancelledError(); problems.push(`API GET ${ep.path} failed: ${errMsg(e)}`); }
    }
    emit('BROWSER_ACTION', `Checked ${crawled.length} internal page(s) and ${apiResults.length} API endpoint(s)`, ctx.scope(task), 'info', { crawled, apiResults });
    if (problems.length) {
      ctx.setGate('browser', 'failed', problems[0]);
      failures.push({ gate: 'browser', summary: 'Browser test found problems', details: problems.join('\n') });
    } else ctx.setGate('browser', 'passed', `Loaded ${url} (HTTP ${status})${crawled.length ? `, ${crawled.length} linked page(s) OK` : ''}${apiResults.length ? `, ${apiResults.length} API check(s) OK` : ''}`);

    // --- console errors
    ctx.setGate('console', 'running');
    const origin = new URL(url).origin;
    const reqFails = session.failedRequests.filter((r) => r.url.startsWith(origin) && !/favicon\.ico/.test(r.url));
    const consoleErrs = session.consoleErrors.filter((c) => !/favicon\.ico/.test(c.text + (c.url ?? '')));
    const errs = [...session.pageErrors.map((e) => `Uncaught: ${e}`), ...consoleErrs.map((c) => `console.error: ${c.text}`), ...reqFails.map((r) => `Request failed (${r.status}): ${r.url.replace(origin, '')}`)];
    if (errs.length) {
      ctx.setGate('console', 'failed', `${errs.length} error(s): ${errs[0].slice(0, 120)}`);
      failures.push({ gate: 'console', summary: `${errs.length} browser console/runtime error(s)`, details: [...new Set(errs)].slice(0, 15).join('\n') });
    } else ctx.setGate('console', 'passed', 'No console errors, runtime exceptions or failed requests');

    // --- responsive
    ctx.setGate('responsive', 'running');
    const issues: DomIssue[] = [...report.issues];
    for (const [name, size] of [['tablet', s.browser.tablet], ['mobile', s.browser.mobile]] as const) {
      await session.setViewport(name, size);
      await session.goto(url);
      issues.push(...(await auditPage(session.page, name)).issues);
    }
    await session.setViewport('desktop', s.browser.desktop);
    persistIssues(ctx, issues.map((i) => ({ ...i, source: 'dom' as const })));
    const blocking = issues.filter((i) => i.severity === 'high' || (strict && i.severity === 'medium'));
    const minor = issues.filter((i) => !blocking.includes(i));
    if (minor.length) warnings.push(...minor.map((i) => i.description));
    if (blocking.length) {
      ctx.setGate('responsive', 'failed', blocking[0].description);
      failures.push({ gate: 'responsive', summary: `${blocking.length} layout problem(s) across viewports`, details: blocking.map((i) => `${i.description}${i.selector ? ` [${i.selector}]` : ''}`).join('\n') });
    } else ctx.setGate('responsive', 'passed', `Desktop, tablet and mobile checked${minor.length ? ` (${minor.length} minor note(s))` : ''}`);
  } catch (e) {
    if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
    ctx.setGate('browser', 'failed', errMsg(e).split('\n')[0]);
    failures.push({ gate: 'browser', summary: 'Browser automation error', details: errMsg(e) });
  } finally { await session?.close(); }
  return { failures, url, warnings };
}

// ---------------------------------------------------------------- Desktop Gates
async function runDesktopGates(ctx: RunContext, task: Task, pkg: Pkg | null, platform: string, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  // Skip web-specific gates
  for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', `Not applicable for ${platform}`);
  
  if (platform === 'windows' && !pkg && fs.readdirSync(ctx.root).some(f => f.endsWith('.csproj'))) {
    const tools = await getCachedToolchains();
    if (!tools.dotnet.usable) {
      ctx.setGate('build', 'failed', '.NET SDK is missing. Install it with explicit approval, then retry.');
      failures.push({ gate: 'build', summary: '.NET SDK unavailable', details: 'No usable dotnet SDK was discovered' });
    } else {
      const f = await gateCommand(ctx, task, 'build', 'dotnet build --configuration Release', 300000);
      if (f) failures.push(f);
    }
  }
  // Desktop package test
  ctx.setGate('desktop_package', 'running');
  const hasPackageScript = !!pkg?.scripts?.package || !!pkg?.scripts?.dist || !!pkg?.scripts?.make;
  if (hasPackageScript) {
    const name = pkg?.scripts?.package ? 'package' : pkg?.scripts?.dist ? 'dist' : 'make';
    const f = await gateCommand(ctx, task, 'desktop_package', runScript(ctx, name)); if (f) failures.push(f);
  } else {
    ctx.setGate('desktop_package', 'skipped', 'No package/dist/make script');
    warnings.push('Consider adding a package script for distribution (electron-builder, electron-forge, etc.)');
  }
  
  const executables = discoverArtifacts(ctx.root, ctx.run.startedAt).filter(a => a.kind === 'exe' && !/setup|install|uninstall/i.test(a.path));
  if (platform === 'windows' && process.platform === 'win32' && ctx.settings.computer.native && !failures.length && executables.length === 1) {
    try {
      const { verifyWindowsExecutable } = await import('../computer/windows');
      const observation = await verifyWindowsExecutable(ctx.root, executables[0].path, { projectId: ctx.project.id, runId: ctx.run.id, agent: 'tester' }, ctx.signal);
      const evidencePath = '.swarm/windows-launch-' + ctx.run.id + '.json';
      fs.mkdirSync(path.join(ctx.root, '.swarm'), { recursive: true });
      fs.writeFileSync(path.join(ctx.root, evidencePath), observation);
      ctx.setGate('desktop_launch', 'passed', executables[0].path + ': launched and accessible window observed. Functional and visual QA remain separate.');
    } catch (e) {
      if (ctx.signal.aborted) throw new CancelledError();
      ctx.setGate('desktop_launch', 'failed', errMsg(e));
      failures.push({ gate: 'desktop_launch', summary: 'Windows launch not verified', details: errMsg(e) });
    }
  } else ctx.setGate('desktop_launch', 'skipped', 'Requires Windows, enabled native interaction, a successful build, and exactly one freshly built non-installer EXE.');
  
  return { failures, url: null, warnings };
}

// ---------------------------------------------------------------- Android Gates
async function runAndroidGates(ctx: RunContext, task: Task, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  // Skip web-specific gates
  for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', 'Not applicable for Android');
  
  // Android build test
  ctx.setGate('mobile_build', 'running');
  const gradleExists = fs.existsSync(path.join(ctx.root, 'build.gradle')) || 
                       fs.existsSync(path.join(ctx.root, 'build.gradle.kts')) ||
                       fs.existsSync(path.join(ctx.root, 'app', 'build.gradle'));
  if (gradleExists) {
    const cmd = process.platform === 'win32' ? (fs.existsSync(path.join(ctx.root, 'gradlew.bat')) ? 'gradlew.bat' : 'gradle') : (fs.existsSync(path.join(ctx.root, 'gradlew')) ? './gradlew' : 'gradle');
    const f = await gateCommand(ctx, task, 'mobile_build', `${cmd} assembleDebug`, 300_000); if (f) failures.push(f);
    if (!f) {
      const tools = await getCachedToolchains();
      if (!tools.adb.usable) ctx.setGate('mobile_emulator', 'skipped', 'ADB unavailable; no device verification performed');
      else {
        const adb = tools.adb.path ? '"' + tools.adb.path + '"' : 'adb';
        const devices = await runCommand({ projectId: ctx.project.id, cwd: ctx.root, command: adb + ' devices', runId: ctx.run.id, taskId: task.id, agent: 'tester', autonomy: ctx.run.options.autonomy, signal: ctx.signal });
        ctx.run.stats.commands++;
        const connected = devices.output.split(/\r?\n/).filter(line => /^\S+\s+device$/.test(line.trim()));
        const hasTests = fs.existsSync(path.join(ctx.root, 'app', 'src', 'androidTest'));
        if (devices.ok && connected.length === 1 && hasTests) {
          const test = await gateCommand(ctx, task, 'mobile_emulator', cmd + ' connectedDebugAndroidTest --rerun-tasks', 300000);
          if (test) failures.push(test);
          else if (ctx.run.gates.find(g => g.id === 'mobile_emulator')?.status === 'passed') {
            const reports = path.join(ctx.root, 'app', 'build', 'outputs', 'androidTest-results');
            let executed = 0;
            const inspect = (dir: string) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.isSymbolicLink()) continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) inspect(file); else if (entry.name.endsWith('.xml') && fs.statSync(file).mtimeMs >= ctx.run.startedAt) { const xml = fs.readFileSync(file, 'utf8'); executed += Number(xml.match(/<testsuite\b[^>]*\btests="(\d+)"/)?.[1] ?? 0); } } };
            inspect(reports);
            if (!executed) ctx.setGate('mobile_emulator', 'skipped', 'Gradle exited successfully but no fresh executed instrumentation tests were found');
            else ctx.setGate('mobile_emulator', 'passed', executed + ' instrumentation tests executed on the connected Android device');
          }
        } else ctx.setGate('mobile_emulator', 'skipped', 'Device QA requires exactly one authorized device and project instrumentation tests. Found ' + connected.length + ' device(s); tests: ' + hasTests);
      }
    } else ctx.setGate('mobile_emulator', 'skipped', 'Android build failed');
  } else {
    ctx.setGate('mobile_build', 'failed', 'No Gradle build configuration found');
    failures.push({ gate: 'mobile_build', summary: 'Android project missing Gradle configuration', details: 'Expected build.gradle or build.gradle.kts' });
    return { failures, url: null, warnings };
  }
  
  // Android manifest check
  ctx.setGate('mobile_permissions', 'running');
  const manifestPath = path.join(ctx.root, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    ctx.setGate('mobile_permissions', 'skipped', 'Manifest exists; runtime permission behavior has not been tested');
  } else {
    ctx.setGate('mobile_permissions', 'failed', 'AndroidManifest.xml missing');
    failures.push({ gate: 'mobile_permissions', summary: 'AndroidManifest.xml not found', details: 'Required for Android app configuration' });
  }
  
  return { failures, url: null, warnings };
}

// ---------------------------------------------------------------- iOS Gates
async function runIOSGates(ctx: RunContext, task: Task, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  // Skip web-specific gates
  for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', 'Not applicable for iOS');
  
  // iOS build test
  ctx.setGate('mobile_build', 'running');
  const hasXcodeproj = fs.readdirSync(ctx.root).some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  if (hasXcodeproj) {
    if (process.platform !== 'darwin') ctx.setGate('mobile_build', 'skipped', 'Not verified: Xcode requires macOS');
    else { const f = await gateCommand(ctx, task, 'mobile_build', 'xcodebuild -sdk iphonesimulator -configuration Debug build', 300_000); if (f) failures.push(f); }
  } else {
    ctx.setGate('mobile_build', 'failed', 'No Xcode project found');
    failures.push({ gate: 'mobile_build', summary: 'iOS project missing Xcode configuration', details: 'Expected .xcodeproj or .xcworkspace' });
    return { failures, url: null, warnings };
  }
  
  // iOS permissions check
  ctx.setGate('mobile_permissions', 'running');
  const plistPath = path.join(ctx.root, 'Info.plist');
  if (fs.existsSync(plistPath)) {
    ctx.setGate('mobile_permissions', 'skipped', 'Info.plist exists; permissions have not been exercised');
  } else {
    warnings.push('Info.plist not found in root - may be in project subdirectory');
    ctx.setGate('mobile_permissions', 'skipped', 'Info.plist check not executed');
  }
  
  return { failures, url: null, warnings };
}

// ---------------------------------------------------------------- CLI Gates
async function runCLIGates(ctx: RunContext, task: Task, pkg: Pkg | null, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  // Skip web-specific gates
  for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', 'Not applicable for CLI');
  
  // CLI help test
  ctx.setGate('cli_help', 'running');
  const startCmd = pkg?.scripts?.start || pkg?.bin;
  if (startCmd) {
    if (pkg?.scripts?.start) { const f = await gateCommand(ctx, task, 'cli_help', `${runScript(ctx, 'start')} -- --help`); if (f) failures.push(f); }
    else ctx.setGate('cli_help', 'skipped', 'Entry point exists; no runnable start script to verify help');
  } else {
    ctx.setGate('cli_help', 'skipped', 'No start script or bin field');
    warnings.push('Consider adding a "bin" field in package.json for CLI tools');
  }
  
  // CLI args test
  ctx.setGate('cli_args', 'running');
  ctx.setGate('cli_args', 'skipped', 'Argument cases require project-specific integration tests');
  
  // CLI exit codes
  ctx.setGate('cli_exit_codes', 'running');
  ctx.setGate('cli_exit_codes', 'skipped', 'Invalid-input exit codes require project-specific integration tests');
  
  return { failures, url: null, warnings };
}

// ---------------------------------------------------------------- Backend/API Gates
async function runBackendGates(ctx: RunContext, task: Task, pkg: Pkg | null, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  const s = ctx.settings;
  // Skip browser-specific gates
  for (const g of ['browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', 'Not applicable for backend/API');
  
  // Service start test
  ctx.setGate('service_start', 'running');
  const startScript = pkg?.scripts?.start || pkg?.scripts?.dev;
  if (!startScript) {
    ctx.setGate('service_start', 'skipped', 'No start/dev script');
    warnings.push('Backend service should have a start or dev script');
    return { failures, url: null, warnings };
  }
  
  try {
    const url = await startBackendService(ctx, task, pkg);
    ctx.run.previewUrl = url; 
    ctx.saveRun();
    
    // API endpoint tests
    ctx.setGate('endpoint_tests', 'running');
    const arch = ctx.architecture;
    const apiResults: string[] = [];
    const problems: string[] = [];
    
    for (const ep of (arch?.api ?? []).filter((a) => a.method.toUpperCase() === 'GET' && !/[:{[]/.test(a.path)).slice(0, 10)) {
      try {
        const res = await fetch(new URL(ep.path, url), { signal: ctx.signal });
        apiResults.push(`GET ${ep.path} → ${res.status}`);
        if (res.status >= 500) problems.push(`API GET ${ep.path} returned ${res.status}`);
        else if (res.status >= 400 && ep.path !== '/health' && ep.path !== '/healthz') problems.push(`API GET ${ep.path} returned ${res.status}`);
      } catch (e) { 
        if (ctx.signal.aborted) throw new CancelledError(); 
        problems.push(`API GET ${ep.path} failed: ${errMsg(e)}`); 
      }
    }
    
    if (problems.length) {
      ctx.setGate('endpoint_tests', 'failed', problems[0]);
      failures.push({ gate: 'endpoint_tests', summary: 'API endpoint tests found problems', details: problems.join('\n') });
    } else if (apiResults.length > 0) {
      ctx.setGate('endpoint_tests', 'passed', `${apiResults.length} API endpoint(s) OK`);
    } else {
      ctx.setGate('endpoint_tests', 'skipped', 'No testable GET endpoints found');
    }
    
    // API contract validation
    ctx.setGate('api_contract', 'running');
    if (arch?.api && arch.api.length > 0) {
      ctx.setGate('api_contract', 'skipped', `${arch.api.length} endpoints documented; schema contract validation not executed`);
    } else {
      ctx.setGate('api_contract', 'skipped', 'No API contract defined');
      warnings.push('Consider documenting API endpoints in architecture');
    }
    
    return { failures, url, warnings };
  } catch (e) {
    if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
    ctx.setGate('service_start', 'failed', errMsg(e).split('\n')[0]);
    return { failures: [{ gate: 'service_start', summary: 'Backend service failed to start', details: errMsg(e) }], url: null, warnings };
  }
}

async function startBackendService(ctx: RunContext, task: Task, pkg: Pkg | null): Promise<string> {
  ctx.setGate('service_start', 'running');
  if (ctx.devServer) {
    try { const response = await fetch(ctx.devServer.url, { signal: AbortSignal.timeout(2000) }); if (response.ok) { ctx.setGate('server', 'passed', 'Existing development server remains healthy'); return ctx.devServer.url; } } catch {}
  }
  stopDevServer(ctx);
  const s = ctx.settings;
  const scripts = pkg?.scripts ?? {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) throw new Error('No dev or start script found');
  
  const port = await freePort();
  const cmd = runScript(ctx, script);
  ctx.touchAgent('tester', { lastAction: `Starting backend: ${cmd}` });
  
  let detectedUrl: string | null = null;
  let exited = false;
  const r = runCommand({
    projectId: ctx.project.id, cwd: ctx.root, command: cmd, runId: ctx.run.id, taskId: task.id, agent: 'tester', 
    autonomy: ctx.run.options.autonomy, signal: ctx.signal, background: true, 
    timeoutMs: s.execution.devServerTimeoutSec * 1000, 
    env: { PORT: String(port), HOST: '127.0.0.1' },
    readyWhen: (out) => {
      const m = out.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/);
      if (m) detectedUrl = `http://127.0.0.1:${m[1]}/`;
      return !!m;
    },
    readyProbe: async () => {
      try {
        const ctrl = new AbortController(); 
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, redirect: 'manual' });
        clearTimeout(t); 
        await res.arrayBuffer().catch(() => undefined);
        return true;
      } catch { return false; }
    },
  }).then((res) => { if (!res.ok) exited = true; return res; });
  
  const res = await r;
  if (!res.ok) throw new Error(`Backend service exited during startup (exit ${res.exitCode}).\n${tail(res.output, 3000)}`);
  
  const candidates = [...new Set([detectedUrl, `http://127.0.0.1:${port}/`].filter(Boolean) as string[])];
  let lastErr = '';
  for (const u of candidates) {
    try {
      const st = await waitForHttp(u, Math.min(30_000, s.execution.devServerTimeoutSec * 1000), ctx.signal, () => !exited);
      const cmdId = res.exec.id;
      ctx.devServer = { commandId: cmdId, url: u, port: Number(new URL(u).port), stop: () => stopCommand(cmdId) };
      ctx.setGate('service_start', 'passed', `${cmd} → ${u} (HTTP ${st})`);
      return u;
    } catch (e) { lastErr = errMsg(e); }
  }
  stopCommand(res.exec.id);
  throw new Error(`${lastErr}\n${tail(res.output, 2500)}`);
}

// ---------------------------------------------------------------- Library Gates
async function runLibraryGates(ctx: RunContext, task: Task, pkg: Pkg | null, failures: GateFailure[], warnings: string[]): Promise<{ failures: GateFailure[]; url: string | null; warnings: string[] }> {
  // Skip web/app-specific gates
  for (const g of ['server', 'browser', 'console', 'responsive'] as GateId[]) 
    ctx.setGate(g, 'skipped', 'Not applicable for library');
  
  // Check for proper library configuration
  const hasMain = !!pkg?.main;
  const hasModule = !!(pkg as any)?.module;
  const hasExports = !!(pkg as any)?.exports;
  const hasTypes = !!(pkg as any)?.types || !!(pkg as any)?.typings;
  
  if (hasMain || hasModule || hasExports) {
    warnings.push('Library entry points configured correctly');
  } else {
    warnings.push('Consider adding "main", "module", or "exports" field to package.json for library distribution');
  }
  
  if (!hasTypes && fs.existsSync(path.join(ctx.root, 'tsconfig.json'))) {
    warnings.push('TypeScript library should include "types" field in package.json');
  }
  
  return { failures, url: null, warnings };
}

function persistIssues(ctx: RunContext, issues: (DomIssue & { source: VisualIssue['source'] })[]) {
  for (const i of issues) {
    const vp = i.description.match(/^\[(\w+)\]/)?.[1] ?? 'desktop';
    const v: VisualIssue = { id: uid('vi_'), runId: ctx.run.id, viewport: vp, severity: i.severity, source: i.source, description: i.description, selector: i.selector };
    db().put('visual_issues', v.id, v, { run_id: v.runId, ts: Date.now() });
    if (i.severity !== 'low') emit('VISUAL_ISSUE_FOUND', i.description, ctx.scope(i.source === 'vision' ? 'vision' : 'tester'), i.severity === 'high' ? 'warning' : 'info', { issue: v });
  }
}

async function startApp(ctx: RunContext, task: Task, pkg: Pkg | null): Promise<string> {
  ctx.setGate('server', 'running');
  stopDevServer(ctx);
  const s = ctx.settings;
  const scripts = pkg?.scripts ?? {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (script) {
    const port = await freePort();
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    let cmd = runScript(ctx, script);
    const scriptBody = scripts[script];
    if (/\bvite\b/.test(scriptBody) || (deps.vite && /vite/.test(scriptBody))) cmd += ` -- --port ${port} --strictPort --host 127.0.0.1`;
    else if (/\bnext\b/.test(scriptBody)) cmd += ` -- -p ${port}`;
    ctx.touchAgent('tester', { lastAction: `Starting app: ${cmd}` });
    let detectedUrl: string | null = null;
    let exited = false;
    const r = runCommand({
      projectId: ctx.project.id, cwd: ctx.root, command: cmd, runId: ctx.run.id, taskId: task.id, agent: 'tester', autonomy: ctx.run.options.autonomy,
      signal: ctx.signal, background: true, timeoutMs: s.execution.devServerTimeoutSec * 1000, env: { PORT: String(port), HOST: '127.0.0.1' },
      readyWhen: (out) => {
        const m = out.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/);
        if (m) detectedUrl = `http://127.0.0.1:${m[1]}/`;
        return !!m;
      },
      readyProbe: async () => {
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, redirect: 'manual' });
          clearTimeout(t); await res.arrayBuffer().catch(() => undefined);
          return true;
        } catch { return false; }
      },
    }).then((res) => { if (!res.ok) exited = true; return res; });
    const res = await r;
    if (!res.ok) throw new Error(`Dev server exited during startup (exit ${res.exitCode}).\n${tail(res.output, 3000)}`);
    const candidates = [...new Set([detectedUrl, `http://127.0.0.1:${port}/`].filter(Boolean) as string[])];
    let lastErr = '';
    for (const u of candidates) {
      try {
        const st = await waitForHttp(u, Math.min(30_000, s.execution.devServerTimeoutSec * 1000), ctx.signal, () => !exited);
        const cmdId = res.exec.id;
        ctx.devServer = { commandId: cmdId, url: u, port: Number(new URL(u).port), stop: () => stopCommand(cmdId) };
        ctx.setGate('server', st < 500 ? 'passed' : 'failed', `${cmd} → ${u} (HTTP ${st})`);
        if (st >= 500) throw new Error(`Server responded with HTTP ${st}`);
        return u;
      } catch (e) { lastErr = errMsg(e); }
    }
    stopCommand(res.exec.id);
    throw new Error(`${lastErr}\n${tail(res.output, 2500)}`);
  }
  // Static site: serve with the built-in server.
  const dirs = ['.', 'public', 'dist', 'src', 'site', 'www'];
  const dir = dirs.find((d) => fs.existsSync(path.join(ctx.root, d, 'index.html')));
  if (!dir) throw new Error('No way to start the app: package.json has no "dev"/"start" script and there is no index.html.');
  const srv = await serveStatic(ctx.project.id, path.join(ctx.root, dir));
  await waitForHttp(srv.url, 5000, ctx.signal);
  ctx.devServer = { commandId: null, url: srv.url, port: srv.port, stop: srv.stop };
  ctx.setGate('server', 'passed', `Serving ${dir === '.' ? 'project root' : dir + '/'} at ${srv.url}`);
  emit('COMMAND_STARTED', `Static server for ${dir === '.' ? 'project root' : dir} at ${srv.url}`, ctx.scope(task), 'info', {});
  return srv.url;
}

export function stopDevServer(ctx: RunContext) {
  ctx.devServer?.stop();
  ctx.devServer = null;
  // Also stop dev servers from previous runs of this project.
  for (const e of listLive(ctx.project.id)) if (e.background) stopCommand(e.id);
}

// ---------------------------------------------------------------- Visual QA
const VisionSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  summary: z.string().default(''),
  issues: z.array(z.object({ severity: z.enum(['low', 'medium', 'high']).catch('low'), viewport: z.string().default('desktop'), description: z.string() })).default([]),
});

export async function runVisualQA(ctx: RunContext, task: Task, url: string): Promise<{ failures: GateFailure[]; summary: string }> {
  const s = ctx.settings;
  ctx.setGate('visual', 'running');
  if (!s.experimental.visionQA) { ctx.setGate('visual', 'skipped', 'Vision QA disabled in Settings › Experimental'); return { failures: [], summary: 'Vision QA disabled' }; }
  if (!s.computer.browser || s.agents.permissions.vision?.browser === false) { ctx.setGate('visual', 'skipped', 'Browser automation disabled'); return { failures: [], summary: 'Browser disabled' }; }
  ctx.touchAgent('vision', { status: 'working', lastAction: 'Capturing screenshots' });
  const session = await openSession({ ...ctx.scope(task), projectId: ctx.project.id }, ctx.root, s.browser.desktop, ctx.signal);
  const images: { viewport: string; b64: string }[] = [];
  const domNotes: string[] = [];
  try {
    for (const [name, size] of [['desktop', s.browser.desktop], ['mobile', s.browser.mobile]] as const) {
      await session.setViewport(name, size);
      await session.goto(url);
      await session.page.waitForTimeout(400);
      await session.screenshot(name, false);
      const jpeg = await session.page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
      images.push({ viewport: name, b64: jpeg.toString('base64') });
      const rep = await auditPage(session.page, name);
      domNotes.push(`${name}: ${rep.metrics.headings} headings, ${rep.metrics.images} images (${rep.metrics.brokenImages} broken), width ${rep.metrics.scrollWidth}/${rep.metrics.innerWidth}px`);
    }
  } finally { await session.close(); }

  ctx.touchAgent('vision', { lastAction: 'Inspecting screenshots with a vision model' });
  const parts: ContentPart[] = [{
    type: 'text',
    text: `You are a meticulous visual QA engineer. Inspect these screenshots of a web app (first: desktop ${s.browser.desktop.join('×')}, second: mobile ${s.browser.mobile.join('×')}).\nObjective: ${ctx.run.objective}\nMeasured layout facts: ${domNotes.join('; ')}\n\nReport only problems you can actually SEE: overlapping elements, cut-off or unreadable text, broken layout, empty sections, missing images/placeholders, poor contrast, misaligned components, unstyled HTML. Severity "high" only for problems that make the page look broken.\nRespond with JSON only: {"verdict":"pass|fail","summary":"one sentence","issues":[{"severity":"low|medium|high","viewport":"desktop|mobile","description":"..."}]}`,
  }, ...images.map((i) => ({ type: 'image' as const, dataUrl: `data:image/jpeg;base64,${i.b64}` }))];
  try {
    const { value } = await callModel(ctx, task, [{ role: 'user', content: parts }], {
      purpose: 'vision', needs: ['vision'], maxTokens: 2500, temperature: 0.1,
      validate: (t) => { const p = VisionSchema.safeParse(extractJson(t)); if (!p.success) throw new Error('Invalid vision JSON'); return p.data; },
    });
    const v = value as z.infer<typeof VisionSchema>;
    if (v.issues.length) ctx.message('vision', 'designer', v.issues.map(i => i.description).join('\n'), task.id, 'DESIGN_FEEDBACK');
    persistIssues(ctx, v.issues.map((i) => ({ severity: i.severity, description: `[${i.viewport}] ${i.description}`, source: 'vision' as const })));
    // High issues always block. Medium issues block on the first visual pass (standard/strict), so one repair
    // cycle is spent on them without looping on subjective notes.
    const firstPass = (ctx.run.gates.find((g) => g.id === 'visual')?.attempt ?? 1) === 1;
    const high = v.issues.filter((i) => i.severity === 'high' || (i.severity === 'medium' && firstPass && s.behavior.verification !== 'basic'));
    if (high.length || v.verdict === 'fail') {
      ctx.setGate('visual', 'failed', high[0]?.description ?? v.summary ?? 'Vision model reported a failure');
      return { failures: [{ gate: 'visual', summary: `Vision QA found ${high.length} visible problem(s)`, details: high.map((i) => `[${i.viewport}] ${i.description}`).join('\n') }], summary: v.summary };
    }
    ctx.setGate('visual', 'passed', `${v.summary || 'No visible defects'}${v.issues.length ? ` (${v.issues.length} minor note(s))` : ''}`);
    ctx.message('vision', 'manager', `Visual inspection complete: ${v.summary || 'no blocking visual defects'}.`, task.id);
    return { failures: [], summary: v.summary };
  } catch (e) {
    if (e instanceof CancelledError || ctx.signal.aborted) throw new CancelledError();
    if (e instanceof NoModelError) {
      ctx.setGate('visual', 'skipped', 'No vision-capable free model responded; screenshots captured and DOM layout checks ran instead');
      ctx.message('vision', 'manager', 'No vision-capable model is available right now, so visual inspection relied on measured DOM layout checks.', task.id);
      return { failures: [], summary: 'Vision model unavailable' };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- Review
const ReviewSchema = z.object({
  verdict: z.enum(['pass', 'needs_fixes']),
  summary: z.string().default(''),
  issues: z.array(z.object({ severity: z.enum(['critical', 'major', 'minor']).catch('minor'), file: z.string().default(''), description: z.string(), fix: z.string().default('') })).default([]),
});

export async function collectSourceFiles(root: string, prefer: string[], maxFiles = 10, maxChars = 32_000): Promise<string> {
  const all: { rel: string; size: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1); }
      else if (/\.(html?|css|m?js|jsx|tsx?|json|vue|svelte|py|md)$/i.test(e.name) && !/lock|\.min\./i.test(e.name)) all.push({ rel: r, size: fs.statSync(path.join(dir, e.name)).size });
    }
  };
  walk(root, '', 0);
  const preferred = new Set(prefer);
  all.sort((a, b) => Number(preferred.has(b.rel)) - Number(preferred.has(a.rel)) || Number(/README|SWARM_REPORT|\.swarm/.test(a.rel)) - Number(/README|SWARM_REPORT|\.swarm/.test(b.rel)) || a.size - b.size);
  let out = ''; let n = 0;
  for (const f of all) {
    if (n >= maxFiles || out.length > maxChars) break;
    const content = fs.readFileSync(path.join(root, f.rel), 'utf8');
    const chunk = content.length > 4500 ? content.slice(0, 4500) + '\n…[truncated]' : content;
    out += `\n--- ${f.rel} ---\n${chunk}\n`; n++;
  }
  return out || '(no source files)';
}

export async function runReview(ctx: RunContext, task: Task): Promise<{ failures: GateFailure[]; summary: string }> {
  ctx.setGate('review', 'running');
  ctx.touchAgent('reviewer', { status: 'working', lastAction: 'Reading implementation' });
  const touched = [...ctx.tasks.values()].flatMap((t) => t.filesTouched);
  const files = await collectSourceFiles(ctx.root, touched);
  const req = ctx.run.brief?.requirements.map((r) => `- ${r}`).join('\n') ?? '';
  const out = await callJson(ctx, task,
    'You are the SWARM Reviewer: a senior engineer reviewing a real implementation. Identify defects that would break functionality or clearly violate requirements (critical/major), and quality notes (minor). Do not nitpick style. Be specific: file and fix.',
    `Objective: ${ctx.run.objective}\nRequirements:\n${req}\n\nFiles:\n${files}\n\nReturn {"verdict":"pass|needs_fixes","summary":"...","issues":[{"severity":"critical|major|minor","file":"path","description":"...","fix":"..."}]}`,
    ReviewSchema, { purpose: 'review', maxTokens: 4000 });
  const firstPass = (ctx.run.gates.find((g) => g.id === 'review')?.attempt ?? 1) === 1;
  const blocking = out.issues.filter((i) => i.severity === 'critical' || (i.severity === 'major' && ctx.settings.behavior.verification !== 'basic' && (firstPass || ctx.settings.behavior.verification === 'strict')));
  if (out.verdict === 'needs_fixes' && !blocking.length) blocking.push({ severity: 'major', file: '', description: out.summary || 'Reviewer requested fixes', fix: '' });
  if (blocking.length) {
    ctx.setGate('review', 'failed', `${blocking.length} blocking issue(s): ${blocking[0].description.slice(0, 120)}`);
    ctx.message('reviewer', 'coder', `Review found ${blocking.length} blocking issue(s). First: ${blocking[0].file} — ${blocking[0].description}`, task.id);
    return { failures: [{ gate: 'review', summary: `Review found ${blocking.length} blocking issue(s)`, details: blocking.map((i) => `[${i.severity}] ${i.file}: ${i.description}${i.fix ? `\n  fix: ${i.fix}` : ''}`).join('\n') }], summary: out.summary };
  }
  ctx.setGate('review', 'passed', out.summary.slice(0, 200) || 'No blocking issues');
  ctx.message('reviewer', 'manager', `Review passed. ${out.summary}`.trim(), task.id);
  return { failures: [], summary: out.summary };
}

export async function readScopeFiles(ctx: RunContext, task: Task, files: string[], maxChars = 14_000): Promise<string> {
  let out = '';
  for (const f of files) {
    if (out.length > maxChars) break;
    try { const c = await readFile(fsCtx(ctx, task), f, 6000); out += `\n--- ${f} ---\n${c}\n`; } catch { /* missing */ }
  }
  return out;
}

export function resetInstallCache() { installHash = new Map(); }
