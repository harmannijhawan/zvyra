// Deterministic execution-strategy selection. No model call is spent deciding how much orchestration to use:
// the least expensive mode that can satisfy the objective wins.
//   simple   — one coding agent, no planning calls, targeted + platform verification.
//   standard — one Manager brief call, deterministic task graph (no Planner call), one coder, verification + review.
//   complex  — full Manager + Planner pipeline with specialised agents and safe parallelism.
import type { ExecutionMode } from '../../shared/types';
import { isSmallChange } from '../core/factory';

export interface ModeDecision { mode: ExecutionMode; reason: string; research: boolean; design: boolean }

const SUBSYSTEMS: [string, RegExp][] = [
  ['authentication', /\b(auth\w*|log ?in|sign ?up|oauth|jwt|accounts?|user roles?|permissions?)\b/i],
  ['database', /\b(database|db\b|sql\w*|postgres\w*|mongo\w*|sqlite|prisma|persist\w* (?:to|in) (?:a )?server)\b/i],
  ['payments', /\b(payments?|stripe|checkout|billing|subscriptions?)\b/i],
  ['backend/API', /\b(backend|rest api|graphql|api server|endpoints?|microservices?|server-side)\b/i],
  ['realtime', /\b(real-?time|websockets?|live updates|chat server|multiplayer)\b/i],
  ['admin/dashboard', /\b(admin panel|dashboard|analytics|reporting)\b/i],
  ['deployment', /\b(deploy\w*|docker\w*|kubernetes|ci\/cd|hosting)\b/i],
  ['integrations', /\b(integrat\w+|third-party|webhooks?|email sending|notifications service)\b/i],
  ['AI features', /\b(llm|machine learning|ai agents?|embeddings?|rag)\b/i],
];
const RESEARCH = /\b(research|latest|current (?:prices|data|events|trends)|real(?:-world)? (?:data|facts|content)|statistics|market|competitors?|news|cite|citations?|sources)\b/i;
const DESIGN = /\b(design system|brand\w*|visual identity|style guide|mood|unconventional|premium|luxury|animations?|beautiful|stunning)\b/i;
const PLATFORM_WORDS = /\b(web(?:site| app)?|windows|mac(?:os)?|linux|android|ios|iphone|cli|command[- ]line|desktop|mobile)\b/gi;

export function instructionOf(objective: string): string {
  return objective.split('\n\nConversation requirements and context:')[0].trim();
}

export function selectExecutionMode(objective: string, o: { existingFiles: boolean; attachments: number; webResearch: boolean }): ModeDecision {
  const text = instructionOf(objective);
  const subsystems = SUBSYSTEMS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const bullets = text.split('\n').filter(l => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l)).length;
  const platforms = new Set([...text.matchAll(PLATFORM_WORDS)].map(m => m[1].toLowerCase().replace(/^(website|web app)$/, 'web').replace(/^mac$/, 'macos').replace(/^iphone$/, 'ios').replace(/^command[- ]line$/, 'cli')));
  const research = o.webResearch && RESEARCH.test(text);
  const design = DESIGN.test(text);

  if (isSmallChange(text) && o.existingFiles) return { mode: 'simple', reason: 'Small change to an existing project', research: false, design: false };
  if (text.length > 2000 || subsystems.length >= 3 || bullets >= 12 || platforms.size >= 3)
    return { mode: 'complex', reason: `Large scope: ${[subsystems.length ? `subsystems ${subsystems.join(', ')}` : '', bullets >= 12 ? `${bullets} listed requirements` : '', platforms.size >= 3 ? `${platforms.size} platforms` : '', text.length > 2000 ? `${text.length}-character brief` : ''].filter(Boolean).join('; ')}`, research: o.webResearch, design: true };
  if (text.length <= 400 && subsystems.length === 0 && bullets <= 4 && !research && o.attachments === 0)
    return { mode: 'simple', reason: 'Short, self-contained objective with no backend, data, auth or research needs', research: false, design: false };
  return { mode: 'standard', reason: subsystems.length ? `Moderate scope: ${subsystems.join(', ')}` : research ? 'Needs researched content' : 'Moderate scope', research, design };
}

/** Per-mode ceilings. The user's settings still apply when they are lower. */
export const MODE_LIMITS: Record<ExecutionMode, { maxSteps: number; repairCycles: number }> = {
  simple: { maxSteps: 14, repairCycles: 2 },
  standard: { maxSteps: 24, repairCycles: 3 },
  complex: { maxSteps: 40, repairCycles: 10 },
};
