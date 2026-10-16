export interface ChatAttachment { name: string; text: string }
export interface ChatActivity {
  id: string;
  tool: string;
  label: string;
  status: 'running' | 'complete' | 'error' | 'approval';
  detail?: string;
  preview?: string;
  ts: number;
}
export interface ChatTurn {
  id: string;
  ts?: number;
  agent?: AgentRole;
  taskId?: string;
  eventId?: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: ChatAttachment[];
  status: 'complete' | 'streaming' | 'error' | 'stopped';
  error?: string;
  model?: string;
  routing?: string;
  tokens?: number;
  omitted?: number;
  activities?: ChatActivity[];
  runId?: string;
}
export interface Conversation { id: string; title: string; updatedAt: number; turns: ChatTurn[]; runId?: string; projectId?: string; kind?: 'coordinator' | 'agent'; agentRole?: AgentRole }
export interface NewChatInput { agentRole?: AgentRole; runId?: string; projectId?: string }
export interface ChatInput { id: string; text: string; attachments?: ChatAttachment[]; model?: string; retryFrom?: string }
import type { AgentRole } from './types';
