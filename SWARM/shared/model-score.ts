// Shared desktop scoring policy. No storage or runtime dependencies.
export type Purpose = 'plan' | 'research' | 'design' | 'architecture' | 'code' | 'review' | 'vision' | 'classify' | 'summarize' | 'test';
export type Capability = 'chat'|'coding'|'reasoning'|'vision'|'long_context'|'fast'|'tools'|'json';
export type RoutingSettings = {ai:{routing:'auto'|'local_first'|'cloud_first'|'fastest'|'quality'};agents:{modelPreference:Record<string,string|null|undefined>}};
export type RouteModel = {id:string;providerId:string;capabilities:readonly string[];paramsB:number|null;successes:number;calls:number;consecutiveFailures:number;latencyMs:number|null;tokensPerSec:number|null;health:string;contextLength:number};
export interface RouteRequest {purpose:Purpose;role?:string;promptTokens:number;maxTokens:number;pinned?:string|null;complexity?:'small'|'normal'|'complex';escalation?:number}
interface Weights { size: number; reliability: number; latency: number; local: number; cloud: number }

const PURPOSE_CAPS: Record<Purpose, Capability[]> = {
  plan: ['reasoning', 'long_context'],
  research: ['long_context', 'reasoning'],
  design: ['reasoning'],
  architecture: ['reasoning', 'coding'],
  code: ['coding', 'long_context'],
  review: ['coding', 'reasoning'],
  vision: ['vision'],
  classify: ['fast'],
  summarize: ['fast', 'long_context'],
  test: ['coding'],
};
const HEAVY: Purpose[] = ['plan', 'architecture', 'code', 'review', 'design'];

function weights(s: RoutingSettings): Weights {
  switch (s.ai.routing) {
    case 'local_first': return { size: 1, reliability: 1, latency: 1, local: 60, cloud: 0 };
    case 'cloud_first': return { size: 1, reliability: 1, latency: 1, local: -40, cloud: 10 };
    case 'fastest': return { size: 0.3, reliability: 1, latency: 4, local: 0, cloud: 0 };
    case 'quality': return { size: 2, reliability: 1.2, latency: 0.3, local: -10, cloud: 5 };
    default: return { size: 1, reliability: 1, latency: 1, local: 0, cloud: 0 };
  }
}

export function scoreModel(m: RouteModel, req: RouteRequest, s: RoutingSettings): number {
  const w = weights(s);
  let score = 0;
  const caps = new Set(m.capabilities);
  for (const c of PURPOSE_CAPS[req.purpose]) if (caps.has(c)) score += 25;
  const heavy = HEAVY.includes(req.purpose);
  const size = m.paramsB ?? (m.providerId === 'ollama' ? 7 : 30);
  if (req.complexity === 'small' && !(req.escalation ?? 0) && s.ai.routing === 'auto') {
    // Prefer efficient capable models, still weighted by observed reliability below.
    score += Math.max(0, 48 - Math.log2(Math.max(size, 1)) * 8);
  } else if (heavy) {
    score += Math.min(Math.log2(Math.max(size, 1)) * 7, 70) * w.size;
    if (size < 13 && s.ai.routing === 'auto') score -= 25; // keep small models for light work
  } else if (req.purpose === 'classify' || req.purpose === 'summarize') {
    score += Math.max(0, 30 - Math.log2(Math.max(size, 1)) * 4);
  } else {
    score += Math.min(Math.log2(Math.max(size, 1)) * 4, 40) * w.size;
  }
  // Measured reliability (Laplace smoothed) and latency.
  const rel = (m.successes + 1) / (m.calls + 2);
  score += rel * 40 * w.reliability;
  if (m.consecutiveFailures) score -= m.consecutiveFailures * 12;
  // Expected wall time for this request from measured time-to-first-token and throughput.
  // Unmeasured models get a size-based throughput prior (very large models are usually slower).
  {
    const expectedTokens = Math.min(req.maxTokens, heavy ? 2500 : 700);
    const tpsPrior = size <= 30 ? 60 : size <= 150 ? 35 : 18;
    const secs = (m.latencyMs ?? 3000) / 1000 + expectedTokens / Math.max(4, m.tokensPerSec ?? tpsPrior);
    score -= Math.min(secs, 150) * 0.6 * w.latency;
  }
  if (m.health === 'healthy') score += 45;
  else if (m.health === 'degraded') score -= 20;
  else if (m.health === 'offline') score -= 60;
  if (m.providerId === 'ollama') score += w.local; else score += w.cloud;
  // Context headroom.
  if (m.contextLength < req.promptTokens + req.maxTokens) score -= 80;
  // Per-role preference from settings.
  if (req.role && s.agents.modelPreference[req.role] === m.id) score += 1000;
  if (req.pinned && req.pinned === m.id) score += 5000;
  return score;
}

