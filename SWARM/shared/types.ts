// Shared domain types used by the main process and the renderer.

export type AgentRole =
  | 'manager'
  | 'planner'
  | 'researcher'
  | 'designer'
  | 'architect'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'optimizer'
  | 'vision'
  | 'finalizer';

export const AGENT_ROLES: AgentRole[] = [
  'manager', 'planner', 'researcher', 'designer', 'architect', 'coder', 'tester', 'reviewer', 'optimizer', 'vision', 'finalizer',
];

export type TaskKind =
  | 'plan' | 'decompose' | 'research' | 'design' | 'architecture' | 'code' | 'install'
  | 'test' | 'review' | 'visual_qa' | 'repair' | 'optimize' | 'finalize' | 'agent_request';

/**
 * Task lifecycle. `waiting` is the persisted QUEUED state (kept for storage/protocol compatibility):
 * QUEUED(waiting) → READY → RUNNING → VERIFYING → COMPLETED, with BLOCKED, FAILED, CANCELLED, RETRY_WAIT
 * and SKIPPED (superseded / dependency failed). Transitions are enforced by electron/agents/taskState.ts.
 */
export type TaskStatus = 'waiting' | 'ready' | 'running' | 'verifying' | 'retry_wait' | 'blocked' | 'failed' | 'completed' | 'skipped' | 'cancelled';
/** How much orchestration a run uses. Chosen deterministically by electron/agents/strategy.ts. */
export type ExecutionMode = 'simple' | 'standard' | 'complex';
export type ErrorCategory = 'quota' | 'rate_limit' | 'context' | 'auth' | 'invalid_request' | 'network' | 'timeout' | 'server' | 'malformed_output' | 'no_provider' | 'budget' | 'no_progress' | 'verification' | 'tool' | 'approval' | 'internal';

/** One recorded retry/recovery decision. Every retry has a reason, an attempt number and a strategy. */
export interface RecoveryRecord {
  ts: number;
  taskId: string | null;
  attempt: number;
  maxAttempts: number;
  reason: string;
  category: ErrorCategory;
  strategy: string;
}

export type EvidenceStatus = 'verified' | 'failed' | 'not_run' | 'not_applicable';
export interface EvidenceItem { status: EvidenceStatus; evidence: string }
/** Evidence-based delivery status. `productionReady` is only true when every applicable level is verified. */
export interface ReadinessReport {
  implemented: EvidenceItem;
  buildVerified: EvidenceItem;
  testsVerified: EvidenceItem;
  runtimeVerified: EvidenceItem;
  securityReviewed: EvidenceItem;
  deploymentVerified: EvidenceItem;
  productionReady: boolean;
  /** Plain-language reasons production readiness is not established. */
  missing: string[];
  computedAt: number;
}

/** Truthful, persisted live progress for a run. */
export interface RunProgress {
  mode: ExecutionMode;
  modeReason: string;
  phase: 'planning' | 'implementing' | 'verifying' | 'repairing' | 'finalizing' | 'blocked' | 'waiting_retry' | 'done';
  currentTask: { id: string; title: string; role: AgentRole; status: TaskStatus } | null;
  lastSuccess: { text: string; ts: number } | null;
  lastVerified: { milestone: string; ts: number } | null;
  blocker: { text: string; category: ErrorCategory; ts: number } | null;
  lastError: { message: string; category: ErrorCategory; ts: number } | null;
  retries: { used: number; max: number };
  model: { providerId: string; modelId: string; displayName: string } | null;
  usage: { calls: number; failedCalls: number; reportedTokens: number; estimatedTokens: number; promptTokens: number; completionTokens: number };
  recovery: RecoveryRecord[];
  updatedAt: number;
}
export type AgentStatus = 'idle' | 'available' | 'waiting' | 'planning' | 'working' | 'blocked' | 'failed' | 'completed';

export type Capability = 'json' | 'chat' | 'coding' | 'reasoning' | 'vision' | 'tools' | 'long_context' | 'fast';
export type FreeStatus = 'free' | 'free_tier' | 'local' | 'paid' | 'unknown';
export type ModelHealth = 'healthy' | 'degraded' | 'rate_limited' | 'offline' | 'auth_required' | 'unsupported' | 'unknown';

export interface ModelInfo {
  id: string; // `${providerId}::${modelId}`
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number;
  maxOutput: number | null;
  freeStatus: FreeStatus;
  health: ModelHealth;
  streaming: boolean;
  enabled: boolean;
  paramsB: number | null; // estimated parameter count in billions, from model id
  // measured runtime stats
  latencyMs: number | null; // EWMA of time-to-first-token / total for short calls
  tokensPerSec: number | null;
  calls: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  lastCheckedAt: number | null;
  rateLimitedUntil: number | null;
  discoveredAt: number;
  notes: string | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: 'cloud' | 'local';
  requiresKey: boolean;
  needsAccountId: boolean;
  configured: boolean;
  enabled: boolean;
  keyHint: string | null; // masked, e.g. "••••3f9a"
  keySource: 'settings' | 'env' | null;
  baseUrl: string;
  health: ModelHealth;
  modelCount: number;
  freeModelCount: number;
  lastDiscoveryAt: number | null;
  lastError: string | null;
  latencyMs: number | null;
  signupUrl: string;
  freeNotes: string;
}

export interface ProjectMemory {
  objective: string;
  summary: string;
  completedTasks: string[];
  unresolved: string[];
  decisions: { ts: number; text: string }[];
  architecture: string;
  lastRunOutcome: string;
  commands: { install?: string; dev?: string; build?: string; test?: string; typecheck?: string; lint?: string };
  previewUrl?: string;
  lastViewedRunId?: string; // Track which run user last viewed for this project
}

export interface Project {
  id: string;
  name: string;
  path: string;
  objective: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'attention';
  favorite: boolean;
  archived: boolean;
  isDemo: boolean;
  external: boolean; // user-supplied existing folder
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  lastRunId: string | null;
  memory: ProjectMemory;
  settings: { webResearch: boolean; autonomy: AutonomyMode | null; stack: string | null };
}

export type AutonomyMode = 'manual' | 'assisted' | 'autonomous';

export type PlatformType =
  | 'web'              // Web application
  | 'windows'          // Windows desktop application
  | 'macos'            // macOS desktop application
  | 'linux'            // Linux desktop application
  | 'android'          // Android mobile app
  | 'ios'              // iOS mobile app
  | 'cli'              // Command-line tool
  | 'backend'          // Backend service
  | 'api'              // REST/GraphQL API service
  | 'library'          // Reusable library/SDK
  | 'desktop'          // Generic desktop (OS determined by context)
  | 'mobile';          // Generic mobile (platform TBD)

export type ApplicationType =
  | 'website'          // Static or dynamic website
  | 'webapp'           // Web application
  | 'desktop_app'      // Native desktop application
  | 'mobile_app'       // Native mobile application
  | 'cli_tool'         // Command-line tool
  | 'service'          // Backend/API service
  | 'library'          // Reusable package
  | 'game'             // Game application
  | 'embedded';        // Embedded system

export interface BuildTarget {
  platform: PlatformType;
  applicationType: ApplicationType;
  framework: string | null;        // React, Flutter, WinUI, etc.
  language: string | null;          // TypeScript, Kotlin, C#, etc.
  runtime: string | null;           // node, python, .NET, JVM, etc.
  packaging: string | null;         // .exe, .apk, .app, npm package, etc.
  validationStrategy: string[];     // Tests and checks to run
  availableToolchains: string[];    // Detected tools that can be used
  confidence: number;               // 0-1 confidence in platform detection
  needsToolchain: string[];         // Required tools not yet detected
}

export type IntentType =
  | 'CHAT'           // Simple greetings and conversation
  | 'QUESTION'       // Information request
  | 'EXPLANATION'    // "How does X work?", "What is Y?"
  | 'RESEARCH'       // Web research request
  | 'BUILD'          // Create/build an application
  | 'CODE'           // Code editing/implementation
  | 'DEBUG'          // Fix errors, troubleshoot
  | 'EDIT'           // Modify existing files
  | 'AUTOMATE'       // Create scripts/automation
  | 'PROJECT_OP'     // File/project operations
  | 'AMBIGUOUS';     // Needs clarification

export interface IntentClassification {
  intent: IntentType;
  confidence: number; // 0-1
  reason: string;
  requiresProject: boolean;
  shouldStartRun: boolean;
  platformHint?: PlatformType | null; // Detected platform from user input
}

export interface ConversationalResponse {
  message: string;
  suggestions?: string[];
}

export type GateId = 
  // Universal gates
  | 'deps' | 'typecheck' | 'lint' | 'build' | 'unit' | 'review'
  // Web-specific gates
  | 'server' | 'browser' | 'console' | 'responsive' | 'visual'
  // CLI-specific gates
  | 'cli_args' | 'cli_help' | 'cli_exit_codes'
  // Desktop-specific gates
  | 'desktop_launch' | 'desktop_package'
  // Mobile-specific gates
  | 'mobile_build' | 'mobile_emulator' | 'mobile_permissions'
  // Backend/API-specific gates
  | 'service_start' | 'endpoint_tests' | 'api_contract';
export interface QualityGate {
  id: GateId;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  detail: string | null;
  ts: number | null;
  attempt: number;
}

export interface Run {
  target?: PlatformType;
  id: string;
  projectId: string;
  objective: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'attention';
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  brief: ManagerBrief | null;
  gates: QualityGate[];
  previewUrl: string | null;
  repairCycles: number;
  /** Repair cycles already used before the latest resume; the repair budget applies per execution. */
  repairBase?: number;
  options: RunOptions;
  /** `tokens` = reported + estimated; `tokensEstimated` is the part providers did not report. */
  stats: { tasks: number; completed: number; failed: number; modelCalls: number; fallbacks: number; tokens: number; tokensEstimated?: number; files: number; commands: number; sources: number };
  mode?: ExecutionMode;
  progress?: RunProgress;
  readiness?: ReadinessReport;
}

export interface RunOptions {
  webResearch: boolean;
  autonomy: AutonomyMode;
  attachments: string[];
  pinnedModel: string | null;
}

export interface ManagerBrief {
  title: string;
  projectType: 'web_app' | 'desktop_app' | 'mobile_app' | 'cli_tool' | 'backend_service' | 'api_service' | 'library' | 'research' | 'fix' | 'analysis' | 'design' | 'automation' | 'script';
  platform: PlatformType | null;  // Detected target platform
  summary: string;
  requirements: string[];
  agents: AgentRole[];
  researchQueries: string[];
  stackHint: string;
}

export interface Task {
  priority?: number;
  requiredCapabilities?: Capability[];
  producedArtifacts?: string[];
  consumedArtifacts?: string[];
  id: string;
  runId: string;
  key: string; // short key from the planner, used for deps
  title: string;
  description: string;
  role: AgentRole;
  kind: TaskKind;
  status: TaskStatus;
  deps: string[]; // task ids
  attempt: number;
  scope: string[]; // file scope hints
  output: string | null;
  error: string | null;
  modelId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  filesTouched: string[];
  tokens: number;
  /** Why the task is blocked / waiting to retry, and when a retry_wait expires. */
  blocker?: string | null;
  retryAt?: number | null;
  retryWaits?: number;
  errorCategory?: ErrorCategory | null;
}

export interface AgentState {
  role: AgentRole;
  status: AgentStatus;
  taskId: string | null;
  taskTitle: string | null;
  modelId: string | null;
  lastAction: string | null;
  tasksDone: number;
  errors: number;
  tokens: number;
  filesTouched: string[];
  updatedAt: number;
}

export type EventType =
  | 'PROJECT_CREATED' | 'PROJECT_UPDATED' | 'PROJECT_DELETED'
  | 'RUN_STARTED' | 'RUN_COMPLETED' | 'RUN_FAILED' | 'RUN_CANCELLED' | 'RUN_UPDATED' | 'RUN_RESUMED' | 'RUN_PAUSED' | 'RUN_STALLED'
  | 'TASK_CREATED' | 'TASK_STARTED' | 'TASK_COMPLETED' | 'TASK_FAILED' | 'TASK_UPDATED' | 'TASK_SKIPPED' | 'TASK_RESET' | 'TASK_STALLED'
  | 'GRAPH_UPDATED'
  | 'AGENT_STARTED' | 'AGENT_STATUS' | 'AGENT_MESSAGE' | 'AGENT_ACTION' | 'AGENT_STREAM'
  | 'MODEL_SELECTED' | 'MODEL_FALLBACK' | 'MODEL_ERROR' | 'MODEL_COMPLETED'
  | 'WEB_SEARCH' | 'SOURCE_FOUND' | 'SOURCE_BLOCKED' | 'FINDING_ADDED'
  | 'FILE_CREATED' | 'FILE_MODIFIED' | 'FILE_DELETED' | 'FILE_RENAMED' | 'FILE_REVERTED'
  | 'COMMAND_STARTED' | 'COMMAND_OUTPUT' | 'COMMAND_COMPLETED' | 'COMMAND_DENIED'
  | 'APPROVAL_REQUIRED' | 'APPROVAL_RESOLVED'
  | 'BROWSER_OPENED' | 'BROWSER_ACTION' | 'SCREENSHOT_CAPTURED' | 'BROWSER_CLOSED' | 'COMPUTER_ACTION' | 'COMPUTER_STARTED' | 'COMPUTER_OBSERVATION'
  | 'TOOL_STARTED' | 'TOOL_FINISHED' | 'SEARCH_STARTED' | 'SEARCH_FINISHED'
  | 'TEST_STARTED' | 'TEST_PASSED' | 'TEST_FAILED' | 'TEST_SKIPPED'
  | 'VISUAL_ISSUE_FOUND' | 'PATCH_APPLIED' | 'REPAIR_STARTED'
  | 'PROVIDER_UPDATED' | 'MODELS_UPDATED'
  | 'CHECKPOINT_SAVED' | 'CHECKPOINT_LOADED' | 'CHECKPOINT_FAILED'
  | 'RUNTIME_CREATED' | 'RUNTIME_STARTING' | 'RUNTIME_STARTED' | 'RUNTIME_STOPPED' 
  | 'RUNTIME_RESTARTED' | 'RUNTIME_FAILED' | 'RUNTIME_CRASHED' | 'RUNTIME_UNHEALTHY' 
  | 'RUNTIME_DISPOSED' | 'RUNTIME_ERROR'
  | 'RUN_CHAT_USER' | 'RUN_CHAT_ASSISTANT' | 'RUN_CHAT_AGENT_USER' | 'RUN_CHAT_AGENT_ASSISTANT'
  | 'GRAPH_VERSION_CREATED'
  | 'NOTIFICATION' | 'LOG';

export type LogLevel = 'debug' | 'info' | 'success' | 'warning' | 'error';

export interface SwarmEvent {
  id: string;
  ts: number;
  type: EventType;
  level: LogLevel;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  agent: AgentRole | null;
  message: string;
  data?: Record<string, unknown>;
}

export type AgentMessageType = 'STATUS' | 'FINDING' | 'REQUEST' | 'HANDOFF' | 'BLOCKED' | 'ERROR' | 'ARTIFACT_READY' | 'TEST_FAILURE' | 'DESIGN_FEEDBACK' | 'ARCHITECTURE_CHANGE' | 'REQUIREMENT_CHANGE' | 'ESCALATION' | 'APPROVAL' | 'COMPLETION';
export interface AgentMessage {
  type?: AgentMessageType;
  priority?: 'normal' | 'high';
  payload?: Record<string, unknown>;
  relatedTaskIds?: string[];
  relatedArtifactIds?: string[];
  id: string;
  ts: number;
  runId: string;
  from: AgentRole;
  to: AgentRole | 'all';
  content: string;
  taskId: string | null;
}

export interface ResearchSource {
  id: string;
  projectId: string;
  runId: string | null;
  query: string;
  url: string;
  title: string;
  domain: string;
  snippet: string;
  excerpt: string | null;
  status: 'fetched' | 'search_only' | 'blocked_robots' | 'failed';
  error: string | null;
  engine: string;
  fetchedAt: number;
  ref: number; // citation number within the run
}

export interface ResearchFinding {
  id: string;
  projectId: string;
  runId: string | null;
  category: string;
  claim: string;
  sourceIds: string[];
  createdAt: number;
}

export interface FileChange {
  id: string;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  agent: AgentRole | 'user' | null;
  path: string; // relative to project root, forward slashes
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  before: string | null;
  after: string | null;
  renamedFrom: string | null;
  status: 'applied' | 'accepted' | 'reverted';
  ts: number;
  additions: number;
  deletions: number;
}

export interface CommandExecution {
  id: string;
  projectId: string;
  runId: string | null;
  taskId: string | null;
  agent: AgentRole | 'user' | null;
  command: string;
  cwd: string;
  status: 'pending_approval' | 'running' | 'exited' | 'killed' | 'denied' | 'timeout' | 'failed';
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  output: string;
  background: boolean;
  risk: Risk;
}

export type Risk = 'low' | 'medium' | 'high' | 'blocked';

export interface ApprovalRequest {
  id: string;
  ts: number;
  projectId: string | null;
  runId: string | null;
  agent: AgentRole | null;
  kind: 'command' | 'install' | 'fs_delete' | 'fs_outside' | 'browser' | 'network' | 'computer';
  title: string;
  detail: string;
  risk: Risk;
}

export interface Screenshot {
  id: string;
  projectId: string;
  runId: string | null;
  url: string;
  viewport: string;
  width: number;
  height: number;
  path: string;
  ts: number;
}

export interface VisualIssue {
  id: string;
  runId: string;
  viewport: string;
  severity: 'low' | 'medium' | 'high';
  source: 'dom' | 'vision' | 'console';
  description: string;
  selector?: string;
}

export interface UsageRecord {
  id: string;
  ts: number;
  projectId: string | null;
  runId: string | null;
  agent: AgentRole | null;
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  costUsd: number;
  local: boolean;
}

export interface AppNotification {
  id: string;
  ts: number;
  level: LogLevel;
  title: string;
  body: string;
  projectId: string | null;
  runId: string | null;
  read: boolean;
  kind: string;
}

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  mtime?: number;
  children?: FileNode[];
}

export interface UsageSummary {
  cloudUsd: number;
  localUsd: number;
  totalUsd: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  byProvider: { providerId: string; calls: number; tokens: number; failures: number; avgLatencyMs: number }[];
  byModel: { modelId: string; providerId: string; calls: number; tokens: number; failures: number; avgLatencyMs: number }[];
}

export interface BootstrapState {
  firstRun: boolean;
  version: string;
  platform: string;
  paths: { data: string; workspace: string };
  ollama: { installed: boolean; running: boolean; url: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE RUN CHAT — conversation with the active Manager and individual agents
// ─────────────────────────────────────────────────────────────────────────────

export type LiveMessageClassification =
  | 'NO_CHANGE'
  | 'STATUS'
  | 'CLARIFICATION'
  | 'TASK_UPDATE'
  | 'PLAN_CHANGE'
  | 'ARCHITECTURE_CHANGE'
  | 'DESIGN_CHANGE'
  | 'CODE_CHANGE'
  | 'TARGET_CHANGE'
  | 'PRIORITY_CHANGE'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'CANCEL';

export type AgentChatClassification =
  | 'QUESTION'
  | 'GUIDANCE'
  | 'TASK_CHANGE'
  | 'DESIGN_CHANGE'
  | 'CODE_CHANGE'
  | 'ARCHITECTURE_CHANGE'
  | 'PROJECT_CHANGE'
  | 'STATUS_REQUEST'
  | 'FEEDBACK'
  | 'STOP'
  | 'PAUSE';

/** A single turn in a Live Run Chat conversation */
export interface RunChatTurn {
  id: string;
  ts: number;
  runId: string;
  conversationId: string; // runId + ':manager' or runId + ':' + agentRole
  senderType: 'user' | 'manager' | 'agent' | 'system';
  senderId: string;       // 'user', agentRole, or 'system'
  recipientType: 'manager' | 'agent';
  recipientId: string;    // agentRole
  text: string;
  status: 'complete' | 'streaming' | 'error';
  error?: string;
  classification?: LiveMessageClassification | AgentChatClassification;
  relatedTaskId?: string | null;
  relatedGraphVersion?: number;
  /** Compact event list: graph update summaries, file links, etc. */
  events?: RunChatEvent[];
  model?: string;
  tokens?: number;
}

/** Small inline event attached to a chat turn (graph change, file link, etc.) */
export interface RunChatEvent {
  kind: 'graph_updated' | 'task_invalidated' | 'task_added' | 'file_changed' | 'agent_notified' | 'priority_changed' | 'decision';
  label: string;
  taskIds?: string[];
  filePaths?: string[];
  agentRoles?: AgentRole[];
}

/** A snapshot of the live run context, sent to the Manager before responding */
export interface LiveRunSnapshot {
  runId: string;
  projectId: string;
  objective: string;
  target: string | null;
  phase: string;           // current high-level phase
  currentTaskTitle: string | null;
  completedCount: number;
  activeCount: number;
  blockedCount: number;
  totalCount: number;
  failedCount: number;
  recentDecisions: string[];
  architectureSummary: string;
  designSummary: string;
  activeAgents: { role: AgentRole; status: string; taskTitle: string | null }[];
  recentUserInstructions: string[];
  graphVersion: number;
}

/** Versioned graph mutation record */
export interface GraphVersion {
  version: number;
  runId: string;
  ts: number;
  reason: string;
  userInstruction: string | null;
  tasksAdded: string[];     // task IDs
  tasksRemoved: string[];
  tasksInvalidated: string[];
  agentsNotified: AgentRole[];
}

/** Input for sending a message to the live run Manager */
export interface RunChatInput {
  runId: string;
  text: string;
}

/** Input for sending a message directly to an agent */
export interface AgentChatInput {
  runId: string;
  agentRole: AgentRole;
  text: string;
}
