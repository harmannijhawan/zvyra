// Event compaction for long-running builds to reduce memory usage and improve UI performance.
// Groups repeated events into summary entries while preserving full detail in the database.
import type { SwarmEvent, EventType } from '../../shared/types';

const COMPACTABLE_TYPES: EventType[] = [
  'AGENT_STATUS',
  'TASK_UPDATED',
  'MODEL_SELECTED',
  'FILE_MODIFIED',
  'COMMAND_OUTPUT',
];

interface CompactedEvent extends SwarmEvent {
  compacted: true;
  originalCount: number;
  timeRange: { start: number; end: number };
  summary: string;
}

/**
 * Check if an event can be compacted with the previous one.
 */
function canCompact(current: SwarmEvent, previous: SwarmEvent | CompactedEvent): boolean {
  // Same type and same source
  if (current.type !== previous.type) return false;
  if (current.agent !== previous.agent) return false;
  if (current.taskId !== previous.taskId) return false;
  
  // Only compact specific event types
  if (!COMPACTABLE_TYPES.includes(current.type)) return false;
  
  // Don't compact errors or warnings
  if (current.level === 'error' || current.level === 'warning') return false;
  if (previous.level === 'error' || previous.level === 'warning') return false;
  
  // Events must be close in time (within 5 minutes)
  const timeDiff = current.ts - previous.ts;
  if (timeDiff > 5 * 60 * 1000) return false;
  
  return true;
}

/**
 * Create a compacted event from a group of similar events.
 */
function createCompactedEvent(
  events: SwarmEvent[],
  type: EventType,
  agent: string | null,
  taskId: string | null,
): CompactedEvent {
  const first = events[0];
  const last = events[events.length - 1];
  
  let summary = '';
  switch (type) {
    case 'AGENT_STATUS':
      summary = `Status updates (${events.length})`;
      break;
    case 'TASK_UPDATED':
      summary = `Task updates (${events.length})`;
      break;
    case 'MODEL_SELECTED':
      summary = `Model selections (${events.length})`;
      break;
    case 'FILE_MODIFIED':
      summary = `File modifications (${events.length})`;
      break;
    case 'COMMAND_OUTPUT':
      summary = `Command output (${events.length} chunks)`;
      break;
    default:
      summary = `${type} (${events.length})`;
  }
  
  return {
    ...last,
    compacted: true,
    originalCount: events.length,
    timeRange: { start: first.ts, end: last.ts },
    summary,
    message: summary,
  };
}

/**
 * Compact a list of events by grouping repeated similar events.
 * Preserves important events (errors, warnings, milestones) in full.
 */
export function compactEvents(events: SwarmEvent[], maxCompacted: number = 300): SwarmEvent[] {
  if (events.length <= maxCompacted) return events;
  
  const result: (SwarmEvent | CompactedEvent)[] = [];
  let currentGroup: SwarmEvent[] = [];
  let currentType: EventType | null = null;
  let currentAgent: string | null = null;
  let currentTaskId: string | null = null;
  
  for (const event of events) {
    // Check if we can add this event to the current group
    if (
      currentGroup.length > 0 &&
      canCompact(event, currentGroup[0]) &&
      currentType === event.type &&
      currentAgent === event.agent &&
      currentTaskId === event.taskId
    ) {
      currentGroup.push(event);
      
      // If group gets large enough, flush it
      if (currentGroup.length >= 10) {
        result.push(createCompactedEvent(currentGroup, currentType!, currentAgent, currentTaskId));
        currentGroup = [];
        currentType = null;
        currentAgent = null;
        currentTaskId = null;
      }
    } else {
      // Flush current group if it exists
      if (currentGroup.length > 1) {
        result.push(createCompactedEvent(currentGroup, currentType!, currentAgent, currentTaskId));
      } else if (currentGroup.length === 1) {
        result.push(currentGroup[0]);
      }
      
      // Start new group if this event is compactable
      if (COMPACTABLE_TYPES.includes(event.type) && event.level !== 'error' && event.level !== 'warning') {
        currentGroup = [event];
        currentType = event.type;
        currentAgent = event.agent;
        currentTaskId = event.taskId;
      } else {
        // Not compactable - add directly
        result.push(event);
        currentGroup = [];
        currentType = null;
        currentAgent = null;
        currentTaskId = null;
      }
    }
  }
  
  // Flush any remaining group
  if (currentGroup.length > 1) {
    result.push(createCompactedEvent(currentGroup, currentType!, currentAgent, currentTaskId));
  } else if (currentGroup.length === 1) {
    result.push(currentGroup[0]);
  }
  
  return result as SwarmEvent[];
}

/**
 * Apply a sliding window to events, keeping only the most recent N events.
 * Always preserves important events (errors, warnings, milestones).
 */
export function applyEventWindow(events: SwarmEvent[], maxEvents: number): SwarmEvent[] {
  if (events.length <= maxEvents) return events;
  
  const importantTypes: EventType[] = [
    'RUN_STARTED',
    'RUN_COMPLETED',
    'RUN_FAILED',
    'RUN_CANCELLED',
    'RUN_RESUMED',
    'TASK_STARTED',
    'TASK_COMPLETED',
    'TASK_FAILED',
    'TASK_SKIPPED',
    'REPAIR_STARTED',
    'CHECKPOINT_SAVED',
    'CHECKPOINT_LOADED',
  ];
  
  // Separate important and regular events
  const important = events.filter(
    e => importantTypes.includes(e.type) || e.level === 'error' || e.level === 'warning'
  );
  const regular = events.filter(
    e => !importantTypes.includes(e.type) && e.level !== 'error' && e.level !== 'warning'
  );
  
  // Always keep all important events
  const importantToKeep = important;
  
  // Calculate how many regular events we can keep
  const regularBudget = Math.max(0, maxEvents - importantToKeep.length);
  const regularToKeep = regular.slice(-regularBudget);
  
  // Merge and sort by timestamp
  const result = [...importantToKeep, ...regularToKeep].sort((a, b) => a.ts - b.ts);
  
  return result;
}

/**
 * Combined compaction and windowing for optimal memory usage.
 */
export function optimizeEventList(events: SwarmEvent[], maxEvents: number = 300): SwarmEvent[] {
  // First apply windowing to limit size
  const windowed = applyEventWindow(events, maxEvents * 2);
  
  // Then compact to reduce further
  const compacted = compactEvents(windowed, maxEvents);
  
  // Final window if still too large
  if (compacted.length > maxEvents) {
    return applyEventWindow(compacted, maxEvents);
  }
  
  return compacted;
}
