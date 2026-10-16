/**
 * Unified BYOK Router
 * Single routing algorithm for Web, Desktop, and Android
 * 
 * Key Changes from Desktop Router:
 * - Uses provider catalog for discovery
 * - Checks user credential availability
 * - Platform-agnostic (no direct provider imports)
 * - Shareable between frontend and backend
 */

import type { Capability } from './types';
import { getProvider, type ProviderDefinition } from './providers-catalog';

export type Purpose = 
  | 'plan' 
  | 'research' 
  | 'design' 
  | 'architecture' 
  | 'code' 
  | 'review' 
  | 'vision' 
  | 'classify' 
  | 'summarize' 
  | 'test';

export interface ModelInfo {
  id: string;
  modelId: string;
  displayName: string;
  providerId: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutput: number | null;
  
  // Health tracking
  health: 'healthy' | 'unknown' | 'rate_limited' | 'auth_required' | 'unsupported';
  calls?: number;
  successes?: number;
  consecutiveFailures?: number;
  latencyMs?: number | null;
  tokensPerSec?: number | null;
  rateLimitedUntil?: number;
}

export interface RouteRequest {
  purpose: Purpose;
  role?: string; // 'planner', 'coder', 'reviewer', etc.
  needs?: Capability[]; // Required capabilities
  promptTokens: number;
  maxTokens: number;
  
  // User preferences
  pinned?: string | null; // Pin specific model
  exclude?: Set<string>; // Exclude models
  complexity?: 'small' | 'normal' | 'complex';
  
  // Routing mode
  routing?: 'fastest' | 'quality' | 'auto';
  
  // Free mode (exclude paid providers)
  freeMode?: boolean;
}

export interface RoutingContext {
  // Available models with health info
  models: ModelInfo[];
  
  // User's configured providers
  configuredProviders: Set<string>;
  
  // Current in-flight requests per provider
  inflightCounts?: Map<string, number>;
  
  // Provider concurrency limits
  providerLimits?: Record<string, number>;
}

/**
 * Score a model for a specific request
 * Higher score = better match
 */
export function scoreModel(model: ModelInfo, req: RouteRequest): number {
  let score = 0;
  
  // 1. Health penalties (most important)
  if (model.health === 'auth_required') return -10000;
  if (model.health === 'unsupported') return -9000;
  if (model.health === 'rate_limited' && model.rateLimitedUntil && model.rateLimitedUntil > Date.now()) {
    return -8000;
  }
  
  // 2. Pinned model gets massive boost
  if (req.pinned && model.id === req.pinned) {
    score += 5000;
  }
  
  // 3. Success rate boost
  if (model.calls && model.calls > 0) {
    const successRate = (model.successes || 0) / model.calls;
    score += successRate * 200; // 0-200 points
  } else if (model.health === 'healthy') {
    score += 100; // Healthy but untested
  }
  
  // 4. Consecutive failures penalty
  const failures = model.consecutiveFailures || 0;
  score -= failures * 50;
  
  // 5. Speed-based scoring
  const routingMode = req.routing || 'auto';
  
  if (routingMode === 'fastest' || req.purpose === 'classify' || req.complexity === 'small') {
    // Prioritize fast models
    if (model.tokensPerSec && model.tokensPerSec > 100) {
      score += 150; // Ultra-fast (Groq territory)
    } else if (model.tokensPerSec && model.tokensPerSec > 50) {
      score += 75; // Fast
    }
    
    if (model.latencyMs && model.latencyMs < 1000) {
      score += 50; // Low latency
    }
    
    // Small/fast models preferred
    const params = estimateParams(model.modelId);
    if (params && params <= 14) score += 100;
    else if (params && params <= 30) score += 50;
  }
  
  if (routingMode === 'quality' || req.complexity === 'complex') {
    // Prioritize capability over speed
    const params = estimateParams(model.modelId);
    if (params && params >= 70) score += 200; // Large models
    else if (params && params >= 30) score += 100;
    
    // Reasoning models
    if (model.capabilities.includes('reasoning')) score += 150;
  }
  
  // 6. Purpose-specific boosts
  switch (req.purpose) {
    case 'code':
      if (model.capabilities.includes('coding')) score += 200;
      if (model.capabilities.includes('tools')) score += 100;
      if (/code|coder|codestral|starcoder|deepseek|qwen|kimi|glm|gpt/.test(model.modelId.toLowerCase())) {
        score += 150;
      }
      break;
      
    case 'review':
      if (model.capabilities.includes('reasoning')) score += 200;
      if (model.capabilities.includes('coding')) score += 150;
      break;
      
    case 'architecture':
    case 'plan':
      if (model.capabilities.includes('reasoning')) score += 200;
      if (model.capabilities.includes('long_context')) score += 100;
      break;
      
    case 'vision':
      if (model.capabilities.includes('vision')) score += 500;
      else return -1000; // Cannot fulfill
      break;
      
    case 'research':
      if (model.capabilities.includes('long_context')) score += 100;
      break;
  }
  
  // 7. Context length requirement
  const requiredContext = req.promptTokens + req.maxTokens + 64;
  const modelContext = model.contextLength || 32768;
  
  if (modelContext < requiredContext) {
    return -5000; // Cannot fit
  }
  
  // Bonus for models with extra headroom
  if (modelContext >= requiredContext * 2) {
    score += 50;
  }
  
  // 8. Long context capability
  if (model.capabilities.includes('long_context') && req.promptTokens > 16000) {
    score += 100;
  }
  
  // 9. Tools capability (for swarm mode)
  if (req.needs?.includes('tools')) {
    if (model.capabilities.includes('tools')) score += 300;
    else return -2000; // Cannot fulfill
  }
  
  // 10. Speed penalty for complex tasks
  if (req.complexity === 'complex') {
    // Don't penalize, but ensure quality models rank higher (already done above)
  }
  
  return score;
}

/**
 * Rank models for a request
 * Returns sorted array with best models first
 */
export function rankModels(req: RouteRequest, ctx: RoutingContext): ModelInfo[] {
  // Filter to configured providers only
  const eligibleModels = ctx.models.filter(m => 
    ctx.configuredProviders.has(m.providerId)
  );
  
  // Filter by required capabilities
  const capableModels = eligibleModels.filter(m => {
    if (!req.needs) return true;
    return req.needs.every(cap => m.capabilities.includes(cap));
  });
  
  // Filter by exclusions
  const includedModels = capableModels.filter(m => 
    !req.exclude?.has(m.id)
  );
  
  // Score each model
  const scored = includedModels.map(model => ({
    model,
    score: scoreModel(model, req)
  }));
  
  // Apply in-flight penalty (deprioritize busy providers)
  if (ctx.inflightCounts) {
    for (const item of scored) {
      const inflight = ctx.inflightCounts.get(item.model.providerId) || 0;
      item.score -= inflight * 25; // -25 per in-flight request
    }
  }
  
  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);
  
  // Return just the models
  return scored
    .filter(s => s.score > -1000) // Exclude impossible matches
    .map(s => s.model);
}

/**
 * Infer purpose from text content
 * Used when purpose not explicitly specified
 */
export function inferPurpose(text: string): Purpose {
  const lower = text.toLowerCase();
  
  if (/research|latest|current|sources|search|find information/i.test(text)) {
    return 'research';
  }
  
  if (/architect|trade.?off|prove|complex|reason step|distributed|system design/i.test(text)) {
    return 'architecture';
  }
  
  if (/code|function|python|javascript|typescript|debug|error|async|```|implement|class|method/i.test(text)) {
    return 'code';
  }
  
  if (/review|evaluate|analyze|assess|check|audit|improve/i.test(text)) {
    return 'review';
  }
  
  if (/vision|image|picture|photo|screenshot|diagram|chart/i.test(text)) {
    return 'vision';
  }
  
  if (/plan|strategy|outline|roadmap|steps|phases/i.test(text)) {
    return 'plan';
  }
  
  if (/test|spec|unit test|integration|e2e|validate/i.test(text)) {
    return 'test';
  }
  
  if (/summarize|summary|tldr|brief|condense/i.test(text)) {
    return 'summarize';
  }
  
  // Default for short queries
  if (text.length < 100) {
    return 'classify';
  }
  
  // Default for longer queries
  return 'plan';
}

/**
 * Estimate model parameter count from ID
 * Used for quality/speed tradeoffs
 */
export function estimateParams(modelId: string): number | null {
  const s = modelId.toLowerCase();
  
  // Exact matches
  if (/\b(1|1\.5|2|3|4|7|8|9|11|13|14|22|27|32|72)b\b/.test(s)) {
    const match = s.match(/\b(\d+(?:\.\d+)?)b\b/);
    if (match) return Number(match[1]);
  }
  
  // Common sizes
  if (/\b70b\b/.test(s)) return 70;
  if (/\b405b\b/.test(s)) return 405;
  if (/\b(123|120)b\b/.test(s)) return 120;
  if (/\b236b\b/.test(s)) return 236;
  
  // Size keywords
  if (/tiny|nano/.test(s)) return 1;
  if (/small|mini/.test(s)) return 3;
  if (/medium/.test(s)) return 14;
  if (/large|ultra/.test(s)) return 70;
  
  return null;
}

/**
 * Get default provider concurrency limits
 */
export function getDefaultProviderLimits(): Record<string, number> {
  return {
    ollama: 1,       // Local, sequential
    openrouter: 3,   // API aggregate
    groq: 4,         // Fast inference
    google: 3,       // Gemini
    nvidia: 4,       // NIM
    huggingface: 3,  // Inference API
    cerebras: 3,     // Wafer-scale
    mistral: 2,      // European
    cloudflare: 3    // Workers AI
  };
}

/**
 * Check if provider needs credentials
 */
export function providerNeedsCredentials(providerId: string): boolean {
  const provider = getProvider(providerId);
  return provider?.requiresKey ?? true;
}

/**
 * Get provider concurrency limit
 */
export function getProviderLimit(providerId: string): number {
  const limits = getDefaultProviderLimits();
  return limits[providerId] ?? 3; // Default to 3 concurrent
}

/**
 * Estimate prompt token count (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters
  // More accurate would use tiktoken, but this is platform-agnostic
  return Math.ceil(text.length / 4);
}

/**
 * Build routing context from available data
 */
export function buildRoutingContext(
  models: ModelInfo[],
  configuredProviders: string[],
  inflightCounts?: Map<string, number>
): RoutingContext {
  return {
    models,
    configuredProviders: new Set(configuredProviders),
    inflightCounts,
    providerLimits: getDefaultProviderLimits()
  };
}

/**
 * Simple route request builder
 */
export function createRouteRequest(
  purpose: Purpose,
  promptTokens: number,
  options?: {
    maxTokens?: number;
    needs?: Capability[];
    routing?: 'fastest' | 'quality' | 'auto';
    pinned?: string;
    complexity?: 'small' | 'normal' | 'complex';
  }
): RouteRequest {
  return {
    purpose,
    promptTokens,
    maxTokens: options?.maxTokens ?? 4096,
    needs: options?.needs,
    routing: options?.routing ?? 'auto',
    pinned: options?.pinned,
    complexity: options?.complexity ?? 'normal'
  };
}
