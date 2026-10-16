import { complete, noModelReason, rankModels, type Purpose } from '../router/router';
import { estimatePromptTokens } from '../providers/http';
import type { ChatMessage } from '../providers/types';

export function chatPurpose(text: string): Purpose {
  if (/research|latest|current|sources/i.test(text)) return 'research';
  if (/architect|trade.?off|prove|complex|reason step|distributed/i.test(text)) return 'architecture';
  if (/code|function|python|javascript|typescript|debug|error|async|scraper|```/i.test(text)) return 'code';
  if (text.length > 1500) return 'plan';
  return 'classify';
}

// Chat shares eligibility, health, cooldowns, accounting and fallback with Build.
export class ChatRouter {
  async respond(messages: ChatMessage[], text: string, signal: AbortSignal, onToken: (s: string) => void, onReset: () => void, pinned?: string, summaryOnly = false) {
    const needs = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image')) ? ['vision' as const] : [];
    const purpose = needs.length ? 'vision' : chatPurpose(text);
    const maxTokens = 4096;
    const full = rankModels({ purpose, needs, promptTokens: estimatePromptTokens(messages) + maxTokens, maxTokens, pinned: pinned ?? '' });
    const candidates = full.length ? full : rankModels({ purpose, needs, promptTokens: 1, maxTokens, pinned: pinned ?? '' });
    if (!candidates.length) throw new Error(noModelReason({ purpose, needs }));
    const budget = Math.max(512, candidates[0].model.contextLength - maxTokens - 256);
    const context = [...messages];
    if (summaryOnly) context[0] = { role: 'system', content: `You are SWARM, the user's assistant. The requested tool work has already been performed. Answer the user's request now using the actual observations and screenshot supplied in the recent messages. Distinguish what is visibly shown in the screenshot from OS-reported window metadata, which may include background windows. Mention the foreground window first when asked what is open. Never describe OS metadata as text read from the screenshot. Tools are unavailable for this response. Return only a concise natural-language answer, without action tags, tool calls or hidden reasoning. Never invent applications, file changes, test results or successful actions. If evidence is insufficient, describe that specific limitation. Original user request: ${text}` };
    let omitted = 0;
    // Preserve the system instruction and complete recent exchanges. Never silently clip code.
    while (estimatePromptTokens(context) > budget && context.length > 2) {
      context.splice(1, 1); omitted++;
      if (context[1]?.role === 'assistant') { context.splice(1, 1); omitted++; }
    }
    if (estimatePromptTokens(context) > budget) throw new Error('This message exceeds the available model context. Shorten it or choose a larger-context model.');
    const result = await complete({ route: { purpose, needs, maxTokens, pinned: pinned ?? '' }, messages: context, signal, scope: {}, quiet: true, stream: true, onToken, onReset, validate: summaryOnly ? value => { if (/<(?:computer|swarm|read|list|run|write|edit|message)\b/i.test(value)) throw new Error('The model issued another tool call instead of interpreting the supplied observation.'); return value; } : undefined });
    return { ...result, omitted, purpose };
  }
}
