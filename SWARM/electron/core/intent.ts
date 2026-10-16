// Intent Classification: prevents conversational messages from triggering the build pipeline.
// Uses fast heuristics first, with optional lightweight model fallback for ambiguous cases.
import { detectPlatform } from './platform';
import type { PlatformType } from '../../shared/types';

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

// Simple conversational phrases that should NEVER trigger a build
const CHAT_PATTERNS = [
  /^hi$/i,
  /^hello$/i,
  /^hey$/i,
  /^howdy$/i,
  /^greetings$/i,
  /^how are you\??$/i,
  /^thanks?$/i,
  /^thank you$/i,
  /^ty$/i,
  /^cool$/i,
  /^ok(ay)?$/i,
  /^nice$/i,
  /^great$/i,
  /^good$/i,
  /^bye$/i,
  /^goodbye$/i,
  /^yes$/i,
  /^no$/i,
  /^yep$/i,
  /^nope$/i,
  /^sure$/i,
  /^👍/,
  /^👋/,
];

// Question indicators
const QUESTION_PATTERNS = [
  /^what is/i,
  /^what are/i,
  /^what does/i,
  /^what's/i,
  /^who is/i,
  /^who are/i,
  /^when is/i,
  /^when does/i,
  /^where is/i,
  /^where does/i,
  /^why is/i,
  /^why does/i,
  /^which/i,
  /^can you (tell|explain|describe|list|show)/i,
  /^(tell|explain|describe|list|show) me (about|how|what|why)/i,
  /\?$/,
];

// Explanation/learning requests
const EXPLANATION_PATTERNS = [
  /^how (does|do|to|can|should|would you)/i,
  /^explain\b/i,
  /^what does .* mean/i,
  /^what (is|are) the difference/i,
  /^(difference|comparison) between/i,
  /^summarize/i,
  /would you (build|create|make)/i,
  /^can you (explain|describe|walk)/i,
];

// Research requests
const RESEARCH_PATTERNS = [
  /^search (for|the web|web)/i,
  /^research/i,
  /^find (information|data|details|current|latest)/i,
  /^look up/i,
  /^what('s| is) the (latest|current|newest)/i,
];

// Build/create requests - HIGH confidence these need the full pipeline
const BUILD_PATTERNS = [
  /^build (a|an|me|the)/i,
  /^create (a|an|me|the) (app|website|application|project|full|saas)/i,
  /^make (a|an|me|the) (app|website|application|project|store|dashboard)/i,
  /^develop (a|an|the)/i,
  /^implement (a|an|the) (app|website|application|project)/i,
  /^generate (a|an|the) (app|website|application|project)/i,
  /build.*(website|app|application|project|saas|dashboard)/i,
  /create.*(website|app|application|project|saas|dashboard)/i,
  /make.*(website|store|app|application|dashboard)/i,
  /\bfull[- ]?stack\b/i,
  /\be[- ]?commerce\b/i,
];

// Code/debugging requests
const CODE_PATTERNS = [
  /^fix (the|this|my)/i,
  /^debug/i,
  /^find (and fix|the (bug|error|issue|problem))/i,
  /^(solve|resolve) (the|this|my)/i,
  /error|bug|issue|broken|failing|doesn't work/i,
];

// File/edit operations
const EDIT_PATTERNS = [
  /^(edit|modify|change|update|refactor) (this|the|my)/i,
  /^add (a|an|the) (function|method|class|component|feature) to/i,
  /^remove (the|this)/i,
  /^delete (this|the)/i,
  /^rename (this|the)/i,
];

// Script/automation
const AUTOMATE_PATTERNS = [
  /^(write|create|make) (a |an |me )?(script|automation)/i,
  /^automate/i,
  /script (that|to|for)/i,
  /\bnode\.?js script\b/i,
  /\bpython script\b/i,
];

/**
 * Fast, heuristic-based intent classification.
 * Returns HIGH confidence for obvious cases, LOW confidence for ambiguous ones.
 */
export function classifyIntent(input: string, hasProject: boolean): IntentClassification {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  // Detect platform hint early (used for BUILD intents)
  const platformDetection = detectPlatform(input);
  const platformHint = platformDetection?.platform || null;

  // PHASE 1: Obvious chat (very short, common greetings)
  if (trimmed.length <= 20 && CHAT_PATTERNS.some((p) => p.test(trimmed))) {
    return {
      intent: 'CHAT',
      confidence: 1.0,
      reason: 'Simple conversational message',
      requiresProject: false,
      shouldStartRun: false,
      platformHint: null,
    };
  }

  // PHASE 2: Explanation requests (must come before BUILD to catch "how to build")
  if (EXPLANATION_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'EXPLANATION',
      confidence: 0.85,
      reason: 'Explanation or learning request',
      requiresProject: false,
      shouldStartRun: false,
      platformHint: null,
    };
  }

  if (RESEARCH_PATTERNS.some((p) => p.test(lower))) return { intent: 'RESEARCH', confidence: 0.95, reason: 'Research in Chat', requiresProject: false, shouldStartRun: false, platformHint: null };
  if (/^(help me|write (a|an) .*function|write (a|an) .*email|compare|what would|help .*plan)\b/i.test(trimmed)) return { intent: 'CHAT', confidence: 0.9, reason: 'Conversational assistance', requiresProject: false, shouldStartRun: false, platformHint: null };
  // PHASE 3: Very obvious BUILD requests (strong imperative + artifact)
  if (BUILD_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'BUILD',
      confidence: 0.95,
      reason: platformDetection ? `Clear build request for ${platformDetection.platform}` : 'Clear build/create request with explicit artifact',
      requiresProject: false, // Will create new project
      shouldStartRun: true,
      platformHint,
    };
  }

  // PHASE 4: Research requests
  if (RESEARCH_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'RESEARCH',
      confidence: 0.9,
      reason: 'Web research request',
      requiresProject: false,
      shouldStartRun: true, // Research uses the pipeline but not full build
      platformHint: null,
    };
  }

  // PHASE 5: Questions about information
  if (QUESTION_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'QUESTION',
      confidence: 0.9,
      reason: 'Information question',
      requiresProject: false,
      shouldStartRun: false,
      platformHint: null,
    };
  }

  // PHASE 6: Code/debug operations (requires project)
  if (CODE_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'DEBUG',
      confidence: 0.85,
      reason: 'Debug/fix request',
      requiresProject: true,
      shouldStartRun: hasProject, // Only run if we have a project
      platformHint: null,
    };
  }

  // PHASE 7: File editing (requires project)
  if (EDIT_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'EDIT',
      confidence: 0.8,
      reason: 'File editing request',
      requiresProject: true,
      shouldStartRun: hasProject,
      platformHint: null,
    };
  }

  // PHASE 8: Automation/scripts
  if (AUTOMATE_PATTERNS.some((p) => p.test(lower))) {
    return {
      intent: 'AUTOMATE',
      confidence: 0.85,
      reason: 'Script/automation request',
      requiresProject: false,
      shouldStartRun: true,
      platformHint: platformHint || 'cli',
    };
  }

  // PHASE 9: Length-based heuristics
  // Very short messages without clear imperative are likely conversational
  if (trimmed.length < 15 && !hasImperative(lower)) {
    return {
      intent: 'CHAT',
      confidence: 0.7,
      reason: 'Short message without clear action request',
      requiresProject: false,
      shouldStartRun: false,
      platformHint: null,
    };
  }

  // PHASE 10: Check for imperative + artifact patterns
  const hasImperativeVerb = /^(build|create|make|generate|develop|implement|design|write)\b/i.test(trimmed);
  const hasArtifact = /\b(website|app|application|page|component|dashboard|system|platform|tool|service|store|library|package|sdk)\b/i.test(lower);
  
  if (hasImperativeVerb && hasArtifact) {
    return {
      intent: 'BUILD',
      confidence: 0.80,
      reason: platformDetection ? `Build request for ${platformDetection.platform}` : 'Imperative verb with artifact mention',
      requiresProject: false,
      shouldStartRun: true,
      platformHint,
    };
  }

  // PHASE 11: Ambiguous - needs clarification or context
  // Medium-length messages without clear indicators
  if (trimmed.length < 40) {
    return {
      intent: 'AMBIGUOUS',
      confidence: 0.5,
      reason: 'Unclear intent - too vague',
      requiresProject: false,
      shouldStartRun: false,
      platformHint: null,
    };
  }

  // PHASE 12: Default for longer messages with context - likely BUILD
  // If someone writes a paragraph, they probably want something built
  return {
    intent: 'CHAT',
    confidence: 0.65,
    reason: 'Conversational request',
    requiresProject: false,
    shouldStartRun: false,
    platformHint: null,
  };
}

/**
 * Helper: Check if the text contains imperative language
 */
function hasImperative(lower: string): boolean {
  return /^(build|create|make|generate|fix|debug|implement|develop|design|write|add|remove|update|change|modify|refactor|search|research|find|analyze|explain|show|tell)\b/i.test(lower);
}

/**
 * Validate if an ambiguous intent should proceed to build.
 * Called when user provides more context or confirms.
 */
export function resolveAmbiguous(
  original: string,
  clarification: string,
  hasProject: boolean
): IntentClassification {
  // Combine original + clarification for classification
  const combined = `${original} ${clarification}`;
  return classifyIntent(combined, hasProject);
}

/**
 * Get a user-friendly explanation of what will happen for each intent
 */
export function getIntentAction(intent: IntentType): string {
  switch (intent) {
    case 'CHAT':
      return 'I\'ll respond conversationally';
    case 'QUESTION':
      return 'I\'ll answer your question';
    case 'EXPLANATION':
      return 'I\'ll explain this concept';
    case 'RESEARCH':
      return 'I\'ll research this topic using web search';
    case 'BUILD':
      return 'I\'ll start the full build pipeline';
    case 'CODE':
      return 'I\'ll write or modify code';
    case 'DEBUG':
      return 'I\'ll debug and fix the issue';
    case 'EDIT':
      return 'I\'ll edit the files';
    case 'AUTOMATE':
      return 'I\'ll create an automation script';
    case 'PROJECT_OP':
      return 'I\'ll perform the file operation';
    case 'AMBIGUOUS':
      return 'I\'m not sure what you want - could you clarify?';
  }
}
