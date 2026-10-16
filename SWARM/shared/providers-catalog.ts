/**
 * Unified Provider Catalog
 * Single source of truth for AI provider definitions across Web, Desktop, and Android
 * 
 * Design Principles:
 * - Platform-agnostic schema
 * - Official URLs only (verified)
 * - Client-side validation patterns
 * - No hardcoded API keys
 * - Extensible for future providers
 */

export interface ProviderDefinition {
  // Identity
  id: string;
  name: string;
  description: string;
  
  // Visual
  logoUrl: string; // Relative path or CDN URL
  brandColor: string; // Hex color for UI theming
  
  // Authentication
  requiresKey: boolean;
  needsAccountId: boolean; // e.g., Cloudflare needs account ID
  keyFormat: {
    pattern: RegExp;
    example: string; // Masked example: "sk-or-v1-••••••••"
    placeholder: string; // Input placeholder
    helpText: string; // Format description
  };
  
  // Official links (MUST be verified)
  urls: {
    signup: string; // Where to create API key
    console: string; // Provider dashboard
    docs: string; // API documentation
    pricing: string; // Pricing page
  };
  
  // Free tier information
  freeTier: {
    available: boolean;
    description: string; // e.g., "15 requests/min, 1M tokens/month"
    limitations?: string; // Optional caveats
  };
  
  // Technical details
  technical: {
    kind: 'cloud' | 'local';
    baseUrl: string;
    publicDiscovery: boolean; // Can list models without auth
    supportsStreaming: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
  };
  
  // UI/UX metadata
  ui: {
    featured: boolean; // Show in "recommended" section
    sortOrder: number; // Display priority (lower = higher priority)
    tags: string[]; // e.g., ["fast", "free", "vision"]
    setupDifficulty: 'easy' | 'medium' | 'advanced';
  };
  
  // Connection test configuration
  testConfig: {
    testModelId?: string; // Specific model to test with
    testPrompt: string; // Simple test message
    expectedResponsePattern?: RegExp; // Validate response
    timeout: number; // Max test duration (ms)
  };
}

/**
 * Provider Catalog
 * Ordered by recommended setup priority
 */
export const PROVIDERS: Record<string, ProviderDefinition> = {
  // ==================== TIER 1: RECOMMENDED ====================
  
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 200+ AI models from multiple providers through one API. Best for beginners with generous free tier.',
    logoUrl: '/providers/openrouter.svg',
    brandColor: '#6366f1',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^sk-or-v1-[a-f0-9]{64}$/,
      example: 'sk-or-v1-••••••••••••••••',
      placeholder: 'sk-or-v1-...',
      helpText: 'Starts with sk-or-v1- followed by 64 hex characters'
    },
    
    urls: {
      signup: 'https://openrouter.ai/keys',
      console: 'https://openrouter.ai/settings/keys',
      docs: 'https://openrouter.ai/docs',
      pricing: 'https://openrouter.ai/models'
    },
    
    freeTier: {
      available: true,
      description: 'Free models available with ":free" suffix. Daily rate limits apply.',
      limitations: 'Free keys limited to ~200 requests/day. Paid models start at $0.0001/1K tokens.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://openrouter.ai/api/v1',
      publicDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true
    },
    
    ui: {
      featured: true,
      sortOrder: 1,
      tags: ['recommended', 'free', 'easy', 'beginner-friendly'],
      setupDifficulty: 'easy'
    },
    
    testConfig: {
      testModelId: 'meta-llama/llama-3.2-3b-instruct:free',
      testPrompt: 'Say "hello" in one word.',
      expectedResponsePattern: /hello/i,
      timeout: 30000
    }
  },
  
  groq: {
    id: 'groq',
    name: 'Groq',
    description: 'Lightning-fast inference with LPU technology. Generous free tier with daily limits.',
    logoUrl: '/providers/groq.svg',
    brandColor: '#f97316',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^gsk_[a-zA-Z0-9]{52}$/,
      example: 'gsk_••••••••••••••••',
      placeholder: 'gsk_...',
      helpText: 'Starts with gsk_ followed by 52 alphanumeric characters'
    },
    
    urls: {
      signup: 'https://console.groq.com/keys',
      console: 'https://console.groq.com/keys',
      docs: 'https://console.groq.com/docs/quickstart',
      pricing: 'https://wow.groq.com/groq-pricing/'
    },
    
    freeTier: {
      available: true,
      description: '14,400 requests per day (resets at midnight UTC)',
      limitations: 'Rate limits: 30 req/min. Free tier includes all models.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://api.groq.com/openai/v1',
      publicDiscovery: false,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true
    },
    
    ui: {
      featured: true,
      sortOrder: 2,
      tags: ['recommended', 'fast', 'free', 'streaming'],
      setupDifficulty: 'easy'
    },
    
    testConfig: {
      testModelId: 'llama-3.3-70b-versatile',
      testPrompt: 'Respond with the word "success" only.',
      expectedResponsePattern: /success/i,
      timeout: 15000
    }
  },
  
  google: {
    id: 'google',
    name: 'Google Gemini',
    description: 'Google\'s multimodal AI models with vision capabilities. Generous free tier for developers.',
    logoUrl: '/providers/google.svg',
    brandColor: '#4285f4',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^[A-Za-z0-9_-]{39}$/,
      example: 'AIzaSy••••••••••••••••••••',
      placeholder: 'AIzaSy...',
      helpText: '39-character API key from Google AI Studio'
    },
    
    urls: {
      signup: 'https://aistudio.google.com/apikey',
      console: 'https://aistudio.google.com/apikey',
      docs: 'https://ai.google.dev/gemini-api/docs',
      pricing: 'https://ai.google.dev/pricing'
    },
    
    freeTier: {
      available: true,
      description: '15 requests/min, 1,500 requests/day, 1M tokens/month',
      limitations: 'Rate limits enforced. Some newer models may require billing enabled.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      publicDiscovery: false,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true
    },
    
    ui: {
      featured: true,
      sortOrder: 3,
      tags: ['recommended', 'vision', 'multimodal', 'free'],
      setupDifficulty: 'easy'
    },
    
    testConfig: {
      testModelId: 'gemini-2.0-flash-exp',
      testPrompt: 'Reply with: OK',
      expectedResponsePattern: /ok/i,
      timeout: 20000
    }
  },
  
  // ==================== TIER 2: ADVANCED ====================
  
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'High-performance AI inference optimized for NVIDIA GPUs. Trial credits available.',
    logoUrl: '/providers/nvidia.svg',
    brandColor: '#76b900',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^nvapi-[A-Za-z0-9_-]{20,}$/,
      example: 'nvapi-••••••••••••••••',
      placeholder: 'nvapi-...',
      helpText: 'Starts with nvapi- followed by alphanumeric string'
    },
    
    urls: {
      signup: 'https://build.nvidia.com/explore/discover',
      console: 'https://build.nvidia.com/nvidia',
      docs: 'https://docs.api.nvidia.com/',
      pricing: 'https://build.nvidia.com/pricing'
    },
    
    freeTier: {
      available: true,
      description: 'Trial credits for new accounts. Check console for current offers.',
      limitations: 'Credits expire. Requires NVIDIA account.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      publicDiscovery: true,
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false
    },
    
    ui: {
      featured: false,
      sortOrder: 4,
      tags: ['performance', 'gpu', 'enterprise'],
      setupDifficulty: 'medium'
    },
    
    testConfig: {
      testModelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
      testPrompt: 'Test',
      timeout: 30000
    }
  },
  
  huggingface: {
    id: 'huggingface',
    name: 'HuggingFace',
    description: 'Access open-source models from the HuggingFace Hub. Some models free to use.',
    logoUrl: '/providers/huggingface.svg',
    brandColor: '#ff9d00',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^hf_[a-zA-Z0-9]{37}$/,
      example: 'hf_••••••••••••••••',
      placeholder: 'hf_...',
      helpText: 'HuggingFace access token starting with hf_'
    },
    
    urls: {
      signup: 'https://huggingface.co/settings/tokens',
      console: 'https://huggingface.co/settings/tokens',
      docs: 'https://huggingface.co/docs/api-inference/index',
      pricing: 'https://huggingface.co/pricing'
    },
    
    freeTier: {
      available: true,
      description: 'Free inference API for many models with rate limits',
      limitations: 'Rate limits vary by model. Some models require Pro subscription.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://api-inference.huggingface.co/models',
      publicDiscovery: false,
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: false
    },
    
    ui: {
      featured: false,
      sortOrder: 5,
      tags: ['open-source', 'community', 'research'],
      setupDifficulty: 'medium'
    },
    
    testConfig: {
      testPrompt: 'Hello',
      timeout: 45000
    }
  },
  
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Ultra-fast inference with Cerebras wafer-scale engines. Limited free tier.',
    logoUrl: '/providers/cerebras.svg',
    brandColor: '#00d4ff',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^csk-[a-z0-9]{32}$/,
      example: 'csk-••••••••••••••••',
      placeholder: 'csk-...',
      helpText: 'Cerebras API key starting with csk-'
    },
    
    urls: {
      signup: 'https://cloud.cerebras.ai/',
      console: 'https://cloud.cerebras.ai/settings',
      docs: 'https://inference-docs.cerebras.ai/introduction',
      pricing: 'https://cerebras.ai/pricing'
    },
    
    freeTier: {
      available: true,
      description: 'Limited free credits for new users',
      limitations: 'Credits expire. Check console for current balance.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://api.cerebras.ai/v1',
      publicDiscovery: false,
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false
    },
    
    ui: {
      featured: false,
      sortOrder: 6,
      tags: ['fast', 'inference', 'advanced'],
      setupDifficulty: 'medium'
    },
    
    testConfig: {
      testModelId: 'llama3.1-8b',
      testPrompt: 'Hi',
      timeout: 10000
    }
  },
  
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'European AI provider with competitive models. Pay-as-you-go pricing.',
    logoUrl: '/providers/mistral.svg',
    brandColor: '#f2552c',
    
    requiresKey: true,
    needsAccountId: false,
    keyFormat: {
      pattern: /^[a-zA-Z0-9]{32}$/,
      example: '••••••••••••••••',
      placeholder: 'Enter 32-character key',
      helpText: '32-character API key from Mistral console'
    },
    
    urls: {
      signup: 'https://console.mistral.ai/',
      console: 'https://console.mistral.ai/api-keys/',
      docs: 'https://docs.mistral.ai/',
      pricing: 'https://mistral.ai/technology/#pricing'
    },
    
    freeTier: {
      available: false,
      description: 'Pay-as-you-go. No free tier.',
      limitations: 'Requires payment method. Competitive pricing.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://api.mistral.ai/v1',
      publicDiscovery: false,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false
    },
    
    ui: {
      featured: false,
      sortOrder: 7,
      tags: ['european', 'enterprise', 'paid'],
      setupDifficulty: 'medium'
    },
    
    testConfig: {
      testModelId: 'mistral-small-latest',
      testPrompt: 'Test',
      timeout: 25000
    }
  },
  
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: 'Run AI inference on Cloudflare\'s edge network. Generous free tier for Workers.',
    logoUrl: '/providers/cloudflare.svg',
    brandColor: '#f38020',
    
    requiresKey: true,
    needsAccountId: true,
    keyFormat: {
      pattern: /^[a-zA-Z0-9_-]{40}$/,
      example: '••••••••••••••••',
      placeholder: 'API token from Cloudflare dashboard',
      helpText: 'Cloudflare API token with Workers AI permissions'
    },
    
    urls: {
      signup: 'https://dash.cloudflare.com/sign-up/workers-and-pages',
      console: 'https://dash.cloudflare.com/',
      docs: 'https://developers.cloudflare.com/workers-ai/',
      pricing: 'https://developers.cloudflare.com/workers-ai/platform/pricing/'
    },
    
    freeTier: {
      available: true,
      description: '10,000 neurons per day (neurons = model size × requests)',
      limitations: 'Requires Cloudflare account. Account ID needed.'
    },
    
    technical: {
      kind: 'cloud',
      baseUrl: 'https://api.cloudflare.com/client/v4',
      publicDiscovery: true,
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false
    },
    
    ui: {
      featured: false,
      sortOrder: 8,
      tags: ['edge', 'global', 'free'],
      setupDifficulty: 'advanced'
    },
    
    testConfig: {
      testModelId: '@cf/meta/llama-3.1-8b-instruct',
      testPrompt: 'Hello',
      timeout: 30000
    }
  },
  
  // ==================== TIER 3: LOCAL ====================
  
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run open-source models locally on your computer. No API key needed.',
    logoUrl: '/providers/ollama.svg',
    brandColor: '#000000',
    
    requiresKey: false,
    needsAccountId: false,
    keyFormat: {
      pattern: /.*/,
      example: 'No key required',
      placeholder: 'Not applicable',
      helpText: 'Ollama runs locally - no API key needed'
    },
    
    urls: {
      signup: 'https://ollama.com/download',
      console: 'http://localhost:11434',
      docs: 'https://github.com/ollama/ollama',
      pricing: 'https://ollama.com/'
    },
    
    freeTier: {
      available: true,
      description: 'Completely free - runs on your hardware',
      limitations: 'Requires Ollama installation and sufficient disk space/RAM'
    },
    
    technical: {
      kind: 'local',
      baseUrl: 'http://localhost:11434',
      publicDiscovery: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true
    },
    
    ui: {
      featured: false,
      sortOrder: 9,
      tags: ['local', 'private', 'free', 'offline'],
      setupDifficulty: 'advanced'
    },
    
    testConfig: {
      testModelId: 'llama3.2',
      testPrompt: 'Say hi',
      timeout: 60000
    }
  }
};

/**
 * Get featured providers (recommended for onboarding)
 */
export function getFeaturedProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS)
    .filter(p => p.ui.featured)
    .sort((a, b) => a.ui.sortOrder - b.ui.sortOrder);
}

/**
 * Get all providers sorted by priority
 */
export function getAllProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS)
    .sort((a, b) => a.ui.sortOrder - b.ui.sortOrder);
}

/**
 * Get provider by ID
 */
export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDERS[id];
}

/**
 * Validate API key format (client-side)
 */
export function validateKeyFormat(providerId: string, key: string): { valid: boolean; error?: string } {
  const provider = getProvider(providerId);
  if (!provider) return { valid: false, error: 'Unknown provider' };
  
  if (!provider.requiresKey) return { valid: true };
  
  if (!key || key.trim().length === 0) {
    return { valid: false, error: 'API key is required' };
  }
  
  if (!provider.keyFormat.pattern.test(key)) {
    return { 
      valid: false, 
      error: `Invalid format. ${provider.keyFormat.helpText}` 
    };
  }
  
  return { valid: true };
}

/**
 * Search providers by keyword
 */
export function searchProviders(query: string): ProviderDefinition[] {
  const q = query.toLowerCase();
  return getAllProviders().filter(p => 
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.ui.tags.some(tag => tag.includes(q))
  );
}

/**
 * Get providers by tag
 */
export function getProvidersByTag(tag: string): ProviderDefinition[] {
  return getAllProviders().filter(p => p.ui.tags.includes(tag));
}
