// Compatibility entry point. All answers use the shared ChatRouter.
import type { ConversationalResponse, IntentType } from '../../shared/types';
import { ChatRouter } from '../chat/router';
export async function generateConversationalResponse(_intent: IntentType, input: string): Promise<ConversationalResponse> {
  const result = await new ChatRouter().respond([{role:'system',content:'You are SWARM, a helpful conversational assistant. Answer the user directly.'},{role:'user',content:input}], input, new AbortController().signal, () => {}, () => {});
  return {message:result.text};
}
export function isEscalationToBuild(input: string) { return /^(build|create|make) (it|this|that)\b/i.test(input); }
