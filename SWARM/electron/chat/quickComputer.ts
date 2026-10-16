import type { PcAction, ComputerObservation } from '../computer/service';

export interface QuickComputerRequest { actions: PcAction[]; acknowledgement: string; label: string; kind: 'open' | 'navigate' | 'observe' | 'inspect'; application?: string; url?: string }
const applications: Record<string, PcAction & { action: 'open_application' }> = Object.fromEntries(
  Object.entries({ chrome: 'chrome', 'google chrome': 'chrome', browser: 'chrome', 'the browser': 'chrome', edge: 'edge', 'microsoft edge': 'edge', notepad: 'notepad', 'vs code': 'vscode', vscode: 'vscode', 'visual studio code': 'vscode', explorer: 'explorer', 'file explorer': 'explorer' })
    .map(([name, application]) => [name, { action: 'open_application', application, intent: `Open ${name}`, risk: 'normal' }])
) as Record<string, PcAction & { action: 'open_application' }>;

/** Only unambiguous, single-purpose requests bypass model planning. All execution
 * still passes through the shared permission/approval/observation PC service. */
export function quickComputerRequest(text: string): QuickComputerRequest | null {
  const normalized = text.trim().replace(/^(?:(?:hey\s+)?swarm[,!]?\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/i, '').replace(/(?:\s+please)?[.!?]*$/i, '').trim();
  const open = normalized.match(/^(?:open|launch|start)\s+(?:the\s+)?(.+)$/i);
  const app = open && applications[open[1].toLowerCase()];
  if (app) return { kind: 'open', actions: [app], application: app.application, label: `Opening ${open![1]}`, acknowledgement: `I'll open ${open![1]} now.` };
  const visit = normalized.match(/^(?:go to|navigate to|visit|open)\s+(https?:\/\/\S+)$/i);
  if (visit) {
    let url: URL; try { url = new URL(visit[1]); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { kind: 'navigate', url: url.href, label: 'Opening the website', acknowledgement: `I'll open ${url.hostname} in the browser.`, actions: [
      { action: 'open_application', application: 'chrome', intent: 'Open the browser', risk: 'normal' },
      { action: 'hotkey', keys: ['ctrl', 'l'], intent: 'Select the browser address bar', risk: 'normal' },
      { action: 'type', text: url.href, intent: 'Enter the requested website URL', risk: 'normal' },
      { action: 'key', key: 'enter', intent: 'Navigate to the requested website', risk: 'normal' },
    ] };
  }
  if (/^(?:take|capture)(?:\s+a)?\s+screenshot(?:\s+(?:of\s+)?(?:my|the)\s+(?:pc|computer|desktop|screen))?$/i.test(normalized)) return { kind: 'observe', acknowledgement: "I'll take a screenshot.", label: 'Taking a screenshot', actions: [{ action: 'screenshot', intent: 'Take the requested screenshot', risk: 'normal' }] };
  return null;
}

export function quickComputerInspection(text: string): QuickComputerRequest | null {
  const request = text.replace(/\b(?:do not|don't|without)\s+(?:click(?:ing)?(?:\s+or\s+typ(?:e|ing))?|typ(?:e|ing)|interact(?:ing)?)[^.]*\.?/gi, '');
  if (!/\b(?:pc|computer|desktop|screen|screenshot)\b/i.test(request) || !/\b(?:check|look|inspect|read|tell|what|describe)\b/i.test(request)) return null;
  if (/\b(?:fix|change|navigate|click|type|build|create|install|delete|close|launch|start|go to|open\s+(?:the\s+)?(?:browser|chrome|edge|app|project))\b/i.test(request)) return null;
  return { kind: 'inspect', acknowledgement: "I'll take a look at the actual PC screen.", label: 'Inspecting the PC', actions: [{ action: 'screenshot', intent: 'Observe the PC to answer the user without making changes', risk: 'normal' }] };
}

export function quickComputerResult(request: QuickComputerRequest, observation: ComputerObservation) {
  if (request.kind === 'observe') return 'Here is the current PC screen.';
  if (request.kind === 'navigate') return `Opened the browser and entered ${request.url}. The latest PC observation is attached.`;
  const names: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', vscode: 'VS Code', explorer: 'File Explorer', notepad: 'Notepad' };
  const name = names[request.application ?? ''] ?? request.application;
  return `Launched ${name}.${observation.activeWindow ? ` The active window is “${observation.activeWindow}”.` : ' The latest PC observation is attached.'}`;
}
