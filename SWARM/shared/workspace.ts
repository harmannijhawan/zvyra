import type { AgentRole, AgentState, ApprovalRequest, FileChange, Run } from './types';

export type WorkspaceEventType = 'message' | 'assistant_message' | 'agent_started' | 'agent_status' | 'agent_message' | 'task_started' | 'task_progress' | 'tool_started' | 'tool_finished' | 'computer_started' | 'computer_action' | 'computer_observation' | 'file_created' | 'file_modified' | 'file_deleted' | 'command_started' | 'command_finished' | 'search_started' | 'search_finished' | 'approval_required' | 'approval_resolved' | 'task_completed' | 'task_failed' | 'run_started' | 'run_completed' | 'run_failed' | 'run_paused' | 'run_resumed' | 'run_stopped' | 'notification';
export interface WorkspaceEvent {
  id: string;
  sequence: number;
  ts: number;
  type: WorkspaceEventType;
  conversationId?: string;
  runId?: string;
  projectId?: string;
  taskId?: string;
  agent?: AgentRole;
  message: string;
  status?: 'running' | 'complete' | 'error' | 'approval' | 'stopped';
  data?: Record<string, unknown>;
}
export interface WorkspaceQuery { conversationId?: string; runId?: string; projectId?: string; after?: number; limit?: number }
export type WorkspaceFile = Omit<FileChange, 'before' | 'after'>;
export interface WorkspaceSnapshot {
  events: WorkspaceEvent[];
  cursor: number;
  hasMore: boolean;
  agents: AgentState[];
  run?: Run;
  files: WorkspaceFile[];
  approvals: ApprovalRequest[];
  conversationId?: string;
  runId?: string;
  projectId?: string;
}
export interface WorkspaceFilePreview extends FileChange { diff: string; truncated: boolean }
