import { z } from 'zod';

const role = z.enum(['manager', 'planner', 'researcher', 'designer', 'architect', 'coder', 'tester', 'reviewer', 'optimizer', 'vision', 'finalizer']);

const rolePerms = z.object({ fs: z.boolean(), terminal: z.boolean(), browser: z.boolean(), web: z.boolean() });

export const SettingsSchema = z.object({
  general: z.object({
    startup: z.enum(['home', 'last_project']).default('last_project'),
    confirmDestructive: z.boolean().default(true),
    openPreviewOnSuccess: z.boolean().default(true),
  }).prefault({}),
  appearance: z.object({
    // White by default, matching the web workspace; dark and system remain one click away.
    theme: z.enum(['light', 'dark', 'system']).default('light'),
    accent: z.enum(['graphite', 'blue', 'violet', 'green', 'amber', 'rose']).default('blue'),
    density: z.enum(['compact', 'comfortable', 'spacious']).default('comfortable'),
    animations: z.boolean().default(true),
    reducedMotion: z.enum(['system', 'on', 'off']).default('system'),
    fontScale: z.number().min(0.85).max(1.25).default(1),
  }).prefault({}),
  interface: z.object({
    showInspector: z.boolean().default(true),
    sidebarCollapsed: z.boolean().default(false),
    autoFocus: z.boolean().default(true),
    showTimestamps: z.boolean().default(true),
    userLogDetail: z.enum(['simple', 'detailed']).default('simple'),
  }).prefault({}),
  ai: z.object({
    freeMode: z.boolean().default(true),
    /** Intelligence configuration chosen in setup (docs/SWARM_PLATFORM_SPEC.md §6). */
    profile: z.enum(['recommended', 'best_coding', 'fast', 'free_first', 'custom']).default('recommended'),
    routing: z.enum(['auto', 'local_first', 'cloud_first', 'fastest', 'quality']).default('auto'),
    pinnedModel: z.string().nullable().default(null),
    temperature: z.number().min(0).max(1.5).default(0.3),
    maxOutputTokens: z.number().int().min(512).max(32768).default(8192),
  }).prefault({}),
  routing: z.object({
    maxFallbacks: z.number().int().min(0).max(12).default(6),
    /** Ordered fallback model ids used by the custom profile (primary is ai.pinnedModel). */
    fallbacks: z.array(z.string().max(300)).max(12).default([]),
    requestTimeoutSec: z.number().int().min(10).max(600).default(150),
    firstTokenTimeoutSec: z.number().int().min(5).max(180).default(20),
    healthCheckOnStartup: z.boolean().default(false),
    discoveryIntervalMin: z.number().int().min(0).max(1440).default(60),
    excluded: z.array(z.string()).default([]),
    preferLargeForPlanning: z.boolean().default(true),
  }).prefault({}),
  providers: z.object({
    enabled: z.record(z.string(), z.boolean()).default({}),
    baseUrls: z.record(z.string(), z.string()).default({}),
    accountIds: z.record(z.string(), z.string()).default({}),
    useEnvKeys: z.boolean().default(true),
  }).prefault({}),
  agents: z.object({
    enabled: z.partialRecord(role, z.boolean()).default({
      manager: true, planner: true, researcher: true, designer: true, architect: true, coder: true,
      tester: true, reviewer: true, optimizer: false, vision: true, finalizer: true,
    }),
    maxConcurrent: z.number().int().min(1).max(16).default(4),
    modelPreference: z.partialRecord(role, z.string().nullable()).default({}),
    permissions: z.partialRecord(role, rolePerms).default({}),
    maxSteps: z.number().int().min(2).max(40).default(12),
  }).prefault({}),
  behavior: z.object({
    autonomy: z.enum(['manual', 'assisted', 'autonomous']).default('assisted'),
    maxRetries: z.number().int().min(0).max(6).default(2),
    maxRepairCycles: z.number().int().min(0).max(10).default(4),
    verification: z.enum(['basic', 'standard', 'strict']).default('standard'),
    context: z.enum(['minimal', 'balanced', 'rich']).default('balanced'),
    parallel: z.boolean().default(true),
  }).prefault({}),
  /** Hard per-task / per-run budgets. Exceeding one stops the work with a recorded reason instead of looping. */
  limits: z.object({
    taskTokens: z.number().int().min(10_000).max(5_000_000).default(250_000),
    taskMinutes: z.number().int().min(1).max(240).default(20),
    runTokens: z.number().int().min(50_000).max(50_000_000).default(1_500_000),
    runMinutes: z.number().int().min(5).max(1440).default(120),
    /** Identical failing action sets tolerated before a task is stopped for lack of progress. */
    repeatedActions: z.number().int().min(1).max(10).default(2),
    /** Times a task may wait for a provider cooldown before failing. */
    retryWaits: z.number().int().min(0).max(5).default(2),
  }).prefault({}),
  memory: z.object({
    project: z.boolean().default(true),
    agent: z.boolean().default(true),
    retentionDays: z.number().int().min(1).max(3650).default(90),
  }).prefault({}),
  research: z.object({
    defaultOn: z.boolean().default(true),
    engine: z.enum(['auto', 'duckduckgo', 'wikipedia', 'brave', 'tavily', 'searxng']).default('auto'),
    searxngUrl: z.string().default(''),
    maxSources: z.number().int().min(1).max(30).default(8),
    maxQueries: z.number().int().min(1).max(10).default(4),
    fetchPages: z.boolean().default(true),
    respectRobots: z.boolean().default(true),
    requestsPerSecond: z.number().min(0.2).max(5).default(1),
    cacheHours: z.number().int().min(0).max(720).default(24),
    citationStyle: z.enum(['numeric', 'domain']).default('numeric'),
  }).prefault({}),
  browser: z.object({
    channel: z.enum(['msedge', 'chrome', 'custom']).default('msedge'),
    executablePath: z.string().default(''),
    headless: z.boolean().default(true),
    desktop: z.tuple([z.number(), z.number()]).default([1440, 900]),
    tablet: z.tuple([z.number(), z.number()]).default([820, 1180]),
    mobile: z.tuple([z.number(), z.number()]).default([390, 844]),
    navigationTimeoutSec: z.number().int().min(5).max(120).default(30),
    captureConsole: z.boolean().default(true),
    maxPagesToCrawl: z.number().int().min(1).max(20).default(5),
  }).prefault({}),
  computer: z.object({
    native: z.boolean().default(false),
    filesystem: z.boolean().default(true),
    terminal: z.boolean().default(true),
    browser: z.boolean().default(true),
    web: z.boolean().default(true),
    packageInstall: z.boolean().default(true),
    openExternal: z.boolean().default(true),
  }).prefault({}),
  execution: z.object({
    timeoutSec: z.number().int().min(10).max(3600).default(300),
    devServerTimeoutSec: z.number().int().min(10).max(600).default(90),
    packageManager: z.enum(['npm', 'pnpm']).default('npm'),
    autoApprove: z.array(z.string()).default(['node ', 'npm run ', 'npm test', 'npx tsc', 'pnpm run ', 'git status', 'git diff', 'dir', 'ls', 'type ', 'echo ']),
    blocked: z.array(z.string()).default([]),
    scrubEnv: z.boolean().default(true),
    maxOutputKb: z.number().int().min(16).max(4096).default(256),
  }).prefault({}),
  security: z.object({
    fsScope: z.enum(['project', 'workspace']).default('project'),
    blockDangerous: z.boolean().default(true),
    redactSecrets: z.boolean().default(true),
    allowAgentNetwork: z.boolean().default(true),
    allowDeletes: z.boolean().default(true),
  }).prefault({}),
  privacy: z.object({
    storeLogs: z.boolean().default(true),
    storeScreenshots: z.boolean().default(true),
    storeModelIO: z.boolean().default(false),
  }).prefault({}),
  projects: z.object({
    defaultStack: z.enum(['auto', 'node-express', 'static', 'vite-react']).default('auto'),
    gitInit: z.boolean().default(true),
  }).prefault({}),
  workspace: z.object({
    root: z.string().default(''),
  }).prefault({}),
  keyboard: z.object({
    palette: z.string().default('Mod+K'),
    newProject: z.string().default('Mod+N'),
    search: z.string().default('Mod+P'),
    run: z.string().default('Mod+Enter'),
    toggleTheme: z.string().default('Mod+Shift+L'),
    toggleInspector: z.string().default('Mod+I'),
    terminal: z.string().default('Mod+J'),
    settings: z.string().default('Mod+,'),
  }).prefault({}),
  notifications: z.object({
    enabled: z.boolean().default(true),
    desktop: z.boolean().default(true),
    onComplete: z.boolean().default(true),
    onFail: z.boolean().default(true),
    onApproval: z.boolean().default(true),
    onBrowserFail: z.boolean().default(true),
    onBlocked: z.boolean().default(true),
    onFallback: z.boolean().default(false),
  }).prefault({}),
  performance: z.object({
    streaming: z.boolean().default(true),
    cacheModelResults: z.boolean().default(true),
    cacheResearch: z.boolean().default(true),
    maxEventsInView: z.number().int().min(200).max(20000).default(5000),
    streamThrottleMs: z.number().int().min(16).max(1000).default(120),
  }).prefault({}),
  logs: z.object({
    level: z.enum(['debug', 'info']).default('info'),
    retentionDays: z.number().int().min(1).max(365).default(30),
  }).prefault({}),
  advanced: z.object({
    ollamaUrl: z.string().default('http://127.0.0.1:11434'),
    userAgent: z.string().default('SWARM-Research/1.0 (+desktop; respectful bot)'),
    devtools: z.boolean().default(false),
  }).prefault({}),
  remote: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).default(47821),
    manualHost: z.string().default(''),
  }).prefault({}),
  experimental: z.object({
    visionQA: z.boolean().default(true),
    optimizer: z.boolean().default(false),
    crawlLinks: z.boolean().default(true),
  }).prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/** Deep-merge a partial patch into settings, then validate. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merged = deepMerge(structuredClone(base) as never, patch as never);
  return SettingsSchema.parse(merged);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (!b || typeof b !== 'object') return a;
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      a[k] = deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else a[k] = v;
  }
  return a;
}
