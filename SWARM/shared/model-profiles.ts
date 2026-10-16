/**
 * Model Profile Configurations
 * Defines which models are suitable for Fast vs SWE profiles
 */

export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  models: ModelReference[];
  defaultEnabled: boolean;
}

export interface ModelReference {
  providerId: string;
  modelId: string;
  priority: number; // 1-10, higher = preferred
  maxContextTokens?: number;
  notes?: string;
}

/**
 * Fast Profile
 * Optimized for speed and cost efficiency
 * Best for: quick queries, simple tasks, high volume
 */
export const FAST_PROFILE: ModelProfile = {
  id: 'fast',
  name: 'Fast',
  description: 'Quick responses, cost-efficient, good for general queries',
  defaultEnabled: true,
  models: [
    // Groq - Fastest inference
    {
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      priority: 10,
      maxContextTokens: 32768,
      notes: 'Fastest, free tier available'
    },
    {
      providerId: 'groq',
      modelId: 'llama-3.1-70b-versatile',
      priority: 9,
      maxContextTokens: 32768
    },
    {
      providerId: 'groq',
      modelId: 'llama-3.1-8b-instant',
      priority: 8,
      maxContextTokens: 8192,
      notes: 'Ultra-fast for simple queries'
    },
    {
      providerId: 'groq',
      modelId: 'gemma2-9b-it',
      priority: 7,
      maxContextTokens: 8192
    },

    // Google Gemini - Free tier
    {
      providerId: 'google',
      modelId: 'gemini-2.0-flash-exp',
      priority: 9,
      maxContextTokens: 1048576,
      notes: 'Huge context, free tier'
    },
    {
      providerId: 'google',
      modelId: 'gemini-1.5-flash',
      priority: 8,
      maxContextTokens: 1048576
    },
    {
      providerId: 'google',
      modelId: 'gemini-1.5-flash-8b',
      priority: 7,
      maxContextTokens: 1048576,
      notes: 'Smallest, fastest Gemini'
    },

    // OpenRouter - Budget options
    {
      providerId: 'openrouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      priority: 8,
      maxContextTokens: 131072
    },
    {
      providerId: 'openrouter',
      modelId: 'qwen/qwen-2.5-72b-instruct',
      priority: 7,
      maxContextTokens: 32768,
      notes: 'Good code generation'
    },
    {
      providerId: 'openrouter',
      modelId: 'google/gemini-flash-1.5',
      priority: 6,
      maxContextTokens: 1048576
    },

    // Anthropic - Claude Haiku (fast & cheap)
    {
      providerId: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      priority: 8,
      maxContextTokens: 200000,
      notes: 'Fastest Claude'
    },

    // OpenAI - GPT-4o-mini
    {
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      priority: 7,
      maxContextTokens: 128000,
      notes: 'Cheap, good quality'
    },

    // Mistral - Small fast models
    {
      providerId: 'mistral',
      modelId: 'mistral-small-latest',
      priority: 6,
      maxContextTokens: 32000
    },
  ]
};

/**
 * SWE (Software Engineering) Profile
 * Optimized for complex reasoning, code generation, and detailed analysis
 * Best for: coding tasks, debugging, architecture, complex problems
 */
export const SWE_PROFILE: ModelProfile = {
  id: 'swe',
  name: 'SWE',
  description: 'Best reasoning and code generation, optimized for software engineering',
  defaultEnabled: true,
  models: [
    // OpenRouter - Top reasoning models
    {
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-r1',
      priority: 10,
      maxContextTokens: 65536,
      notes: 'Best reasoning, open source'
    },
    {
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-chat',
      priority: 9,
      maxContextTokens: 65536,
      notes: 'Excellent code generation'
    },
    {
      providerId: 'openrouter',
      modelId: 'qwen/qwen-2.5-coder-32b-instruct',
      priority: 9,
      maxContextTokens: 32768,
      notes: 'Specialized code model'
    },

    // Anthropic - Claude Sonnet (best balance)
    {
      providerId: 'anthropic',
      modelId: 'claude-3-7-sonnet-20250219',
      priority: 10,
      maxContextTokens: 200000,
      notes: 'Best overall reasoning'
    },
    {
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet-20241022',
      priority: 9,
      maxContextTokens: 200000
    },

    // OpenAI - GPT-4
    {
      providerId: 'openai',
      modelId: 'gpt-4o',
      priority: 9,
      maxContextTokens: 128000,
      notes: 'Strong all-around'
    },
    {
      providerId: 'openai',
      modelId: 'o1',
      priority: 10,
      maxContextTokens: 200000,
      notes: 'Best reasoning from OpenAI'
    },

    // Google - Gemini Pro
    {
      providerId: 'google',
      modelId: 'gemini-2.0-flash-thinking-exp',
      priority: 9,
      maxContextTokens: 32768,
      notes: 'Advanced reasoning mode'
    },
    {
      providerId: 'google',
      modelId: 'gemini-1.5-pro',
      priority: 8,
      maxContextTokens: 2097152,
      notes: 'Massive context window'
    },

    // Groq - Fast reasoning
    {
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
      priority: 7,
      maxContextTokens: 32768,
      notes: 'Fast inference for SWE tasks'
    },
    {
      providerId: 'groq',
      modelId: 'deepseek-r1-distill-llama-70b',
      priority: 8,
      maxContextTokens: 8192,
      notes: 'Reasoning-optimized, ultra-fast'
    },

    // Mistral - Large models
    {
      providerId: 'mistral',
      modelId: 'mistral-large-latest',
      priority: 8,
      maxContextTokens: 128000,
      notes: 'Strong reasoning'
    },

    // xAI - Grok
    {
      providerId: 'xai',
      modelId: 'grok-2-latest',
      priority: 7,
      maxContextTokens: 131072,
      notes: 'Strong code understanding'
    },
  ]
};

/**
 * Get all profiles
 */
export function getAllProfiles(): ModelProfile[] {
  return [FAST_PROFILE, SWE_PROFILE];
}

/**
 * Get profile by ID
 */
export function getProfile(profileId: string): ModelProfile | undefined {
  return getAllProfiles().find(p => p.id === profileId);
}

/**
 * Check if model is in profile
 */
export function isModelInProfile(
  profileId: string,
  providerId: string,
  modelId: string
): boolean {
  const profile = getProfile(profileId);
  if (!profile) return false;
  
  return profile.models.some(
    m => m.providerId === providerId && m.modelId === modelId
  );
}

/**
 * Get model priority in profile
 */
export function getModelPriority(
  profileId: string,
  providerId: string,
  modelId: string
): number {
  const profile = getProfile(profileId);
  if (!profile) return 0;
  
  const modelRef = profile.models.find(
    m => m.providerId === providerId && m.modelId === modelId
  );
  
  return modelRef?.priority || 0;
}

/**
 * Get models for profile, sorted by priority
 */
export function getProfileModels(profileId: string): ModelReference[] {
  const profile = getProfile(profileId);
  if (!profile) return [];
  
  return [...profile.models].sort((a, b) => b.priority - a.priority);
}
