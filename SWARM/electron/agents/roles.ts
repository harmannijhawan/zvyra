import type { AgentRole } from '../../shared/types';
import type { Purpose } from '../router/router';

export interface RoleDef {
  role: AgentRole;
  name: string;
  title: string;
  purpose: Purpose;
  tools: ('fs' | 'terminal' | 'browser' | 'web')[];
  description: string;
}

export const ROLES: Record<AgentRole, RoleDef> = {
  manager: { role: 'manager', name: 'Manager', title: 'Planning & Orchestration', purpose: 'plan', tools: [], description: 'Understands the objective, decides which agents are needed, manages dependencies.' },
  planner: { role: 'planner', name: 'Planner', title: 'Task Graph', purpose: 'plan', tools: [], description: 'Turns the brief into an executable task graph and identifies parallel work.' },
  researcher: { role: 'researcher', name: 'Researcher', title: 'Web Research', purpose: 'research', tools: ['web'], description: 'Searches the web, reads sources, extracts cited findings.' },
  designer: { role: 'designer', name: 'Designer', title: 'UI/UX Design', purpose: 'design', tools: [], description: 'Creates the design system, layouts and component specs.' },
  architect: { role: 'architect', name: 'Architect', title: 'System Architecture', purpose: 'architecture', tools: ['fs'], description: 'Chooses the stack, file layout, API contract and project commands.' },
  coder: { role: 'coder', name: 'Coder', title: 'Development', purpose: 'code', tools: ['fs', 'terminal'], description: 'Writes and edits project files and runs project commands.' },
  tester: { role: 'tester', name: 'Tester', title: 'Testing & QA', purpose: 'test', tools: ['terminal', 'browser'], description: 'Installs, builds, runs tests, starts the app and verifies it in a browser.' },
  reviewer: { role: 'reviewer', name: 'Reviewer', title: 'Code & UX Review', purpose: 'review', tools: ['fs'], description: 'Reviews the implementation for defects and requirement gaps.' },
  optimizer: { role: 'optimizer', name: 'Optimizer', title: 'Performance', purpose: 'code', tools: ['fs', 'terminal'], description: 'Improves performance and code quality without changing behavior.' },
  vision: { role: 'vision', name: 'Vision QA', title: 'Visual Inspection', purpose: 'vision', tools: ['browser'], description: 'Inspects screenshots and layout measurements for visual defects.' },
  finalizer: { role: 'finalizer', name: 'Finalizer', title: 'Verification & Delivery', purpose: 'summarize', tools: ['fs'], description: 'Verifies completion, writes the report and summarizes artifacts.' },
};

export const ACTION_PROTOCOL = `You act ONLY through action tags. SWARM executes each action for real on the user's machine and returns the results to you.

<write path="relative/path.ext">
complete file content
</write>
<edit path="relative/path.ext">
<find>exact existing text (a few unique lines)</find>
<replace>replacement text</replace>
</edit>
<read path="relative/path.ext"/>
<list path="."/>
<search pattern="regex" glob="src/**/*.ts"/>  (find symbols, imports and usages before editing; glob and path are optional)
<run>single non-interactive shell command</run>
<computer>{"action":"screenshot"}</computer>
Computer interaction uses the same capture and native input backend as Mobile Remote PC. Observe the desktop, act on returned image coordinates, then observe and verify. Normal actions proceed with Native interaction enabled; consequential actions use the existing approval queue.
<message to="manager|researcher|planner|architect|designer|coder|tester|reviewer|vision|finalizer|all" type="FINDING|REQUEST|HANDOFF|TEST_FAILURE|DESIGN_FEEDBACK|ESCALATION|STATUS">short note for another agent</message>
<done>short summary of what you changed</done>

Rules:
- Paths are relative to the project root. Never use absolute paths.
- Write COMPLETE files. Never use placeholders such as "...", "rest unchanged" or TODO stubs.
- The shell is Windows cmd.exe. Do not start long-running servers (SWARM starts the app itself). Do not run "npm install" — declare dependencies in package.json; the Tester installs them.
- Other agents work in parallel. Only touch files in your scope unless a fix requires otherwise.
- Prefer at most 6 files per response; you will get further turns with the results.
- Finish with <done> once your task is fully implemented.`;
