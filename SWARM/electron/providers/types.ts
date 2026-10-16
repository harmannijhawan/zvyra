import type { Capability, FreeStatus } from '../../shared/types';

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
  stream: boolean;
  json?: boolean;
  onToken?: (delta: string) => void;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
  latencyMs: number;
  ttftMs: number | null;
  usageEstimated: boolean;
}

export type ProviderErrorKind =
  | 'rate_limit' | 'auth' | 'not_found' | 'timeout' | 'server' | 'bad_request'
  | 'context' | 'network' | 'invalid' | 'cancelled' | 'quota' | 'unsupported';

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderConfig {
  apiKey: string | null;
  baseUrl: string;
  accountId: string | null;
}

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number | null;
  maxOutput: number | null;
  freeStatus: FreeStatus;
  notes?: string;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  kind: 'cloud' | 'local';
  requiresKey: boolean;
  needsAccountId: boolean;
  defaultBaseUrl: string;
  signupUrl: string;
  freeNotes: string;
  /** Whether model discovery works without credentials. */
  publicDiscovery: boolean;
  discover(cfg: ProviderConfig, signal: AbortSignal): Promise<DiscoveredModel[]>;
  chat(cfg: ProviderConfig, modelId: string, req: ChatRequest): Promise<ChatResult>;
}
