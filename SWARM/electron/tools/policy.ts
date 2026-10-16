// Command risk classification and approval policy.
import path from 'node:path';
import type { AutonomyMode, Risk } from '../../shared/types';

export interface CommandAssessment {
  risk: Risk;
  kind: 'command' | 'install' | 'network';
  reason: string;
}

const BLOCKED: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME|\*|[a-z]:\\?)(\s|$)/i, 'Recursive delete of a root or home directory'],
  [/\b(rd|rmdir)\s+\/s\b.*\b[a-z]:\\?(\s|$|")/i, 'Recursive delete of a drive root'],
  [/\bdel\s+.*\/s\b.*\b[a-z]:\\(\s|$|\*)/i, 'Recursive delete across a drive'],
  [/\bformat\s+[a-z]:/i, 'Formatting a drive'],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, 'Power state change'],
  [/\bmkfs(\.\w+)?\b|\bdd\s+if=/i, 'Raw disk write'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'Fork bomb'],
  [/\b(reg(\.exe)?\s+(delete|add)|bcdedit|diskpart|cipher\s+\/w|vssadmin|wbadmin)\b/i, 'System configuration change'],
  [/\bSet-ExecutionPolicy\b/i, 'Changing script execution policy'],
  [/(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|iex|Invoke-Expression|powershell|pwsh)\b/i, 'Piping downloaded code into a shell'],
  [/\b(powershell|pwsh)(\.exe)?\s+.*-(e|enc|encodedcommand)\s+/i, 'Encoded PowerShell command'],
  [/\bnet\s+(user|localgroup)\b.*\/(add|delete)/i, 'User account modification'],
  [/\b(schtasks\s+\/create|sc(\.exe)?\s+(create|delete|config))\b/i, 'System service or scheduled task change'],
  [/\b(takeown|icacls)\b/i, 'File ownership/ACL change'],
  [/\bRemove-Item\b.*-Recurse.*\s([a-z]:\\?|~|\$env:USERPROFILE|\$HOME)(\s|$|")/i, 'Recursive delete of a root or home directory'],
  [/\b(chmod|chown)\s+-R\s+\S+\s+\/(\s|$)/i, 'Recursive permission change on root'],
  [/\bgit\s+push\b.*(--force|-f)\b/i, 'Force push'],
  [/\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i, 'Publishing a package'],
];

const HIGH: [RegExp, string][] = [
  [/\bconnected\w*AndroidTest\b|\badb\b.*\b(install|uninstall|shell\s+(am|input|settings|pm))\b/i, 'Installs or interacts with software on an Android device'],
  [/\b(rm|del|erase|Remove-Item|winget|choco|scoop|msiexec)\b/i, 'Deletes files or installs software'],
  [/\brm\s+-[a-z]*r|\brd\s+\/s|\brmdir\s+\/s|\bdel\s+.*\/s|Remove-Item\b.*-Recurse/i, 'Recursive delete'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i, 'Destructive or remote git operation'],
  [/\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'Direct network download'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b/i, 'Global package install'],
  [/\bpip\s+install\b(?!.*(-r|--requirement))/i, 'Python package install'],
  [/\b(docker|kubectl|terraform|aws|az|gcloud)\b/i, 'Infrastructure tooling'],
];

const INSTALL = /\b(npm\s+(i|install|ci|add)|pnpm\s+(i|install|add)|yarn(\s+add|\s+install|\s*$)|pip\s+install|npx\s+(-y\s+)?create-|npm\s+create|pnpm\s+create|bun\s+(i|install|add))\b/i;
const NETWORK = /\bnpx\s+(?!tsc\b|vitest\b|eslint\b|prettier\b)/i;

export function assessCommand(command: string, projectRoot: string, extraBlocked: string[] = [], blockDangerous = true): CommandAssessment {
  const cmd = command.trim();
  for (const b of extraBlocked) if (b.trim() && cmd.toLowerCase().includes(b.trim().toLowerCase())) return { risk: 'blocked', kind: 'command', reason: `Matches blocked pattern "${b}"` };
  if (blockDangerous) for (const [re, why] of BLOCKED) if (re.test(cmd)) return { risk: 'blocked', kind: 'command', reason: why };
  // Absolute paths outside the project are high risk.
  const quoted = [...cmd.matchAll(/"([a-zA-Z]:\\[^"]*)"/g)].map((m) => m[1]);
  const unquoted = [...cmd.replace(/"[^"]*"/g, ' ').matchAll(/(?:^|\s)([a-zA-Z]:\\[^\s]*|\/(?:etc|usr|var|bin|home|Users)\/[^\s]*)/g)].map((m) => m[1]);
  const root = path.resolve(projectRoot).toLowerCase();
  for (const raw of [...quoted, ...unquoted]) {
    const p = raw.trim();
    const resolved = path.resolve(p).toLowerCase();
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return { risk: 'high', kind: 'command', reason: `References a path outside the project (${p})` };
  }
  if (/(^|[\s"'])\.\.[\\/]/.test(cmd)) return { risk: 'high', kind: 'command', reason: 'References parent directories outside the project' };
  for (const [re, why] of HIGH) if (re.test(cmd)) return { risk: 'high', kind: re.source.includes('curl') ? 'network' : 'command', reason: why };
  if (/\bdotnet\s+(restore|build|publish)\b|\bgradle(?:w(?:\.bat)?)?\s+.*\b(build|assemble\w*|test)\b|\bcargo\s+(build|install)\b/i.test(cmd)) return { risk: 'medium', kind: 'install', reason: 'Build tooling may restore or download dependencies' };
  if (INSTALL.test(cmd)) return { risk: 'medium', kind: 'install', reason: 'Installs dependencies from a package registry' };
  if (NETWORK.test(cmd)) return { risk: 'medium', kind: 'install', reason: 'npx may download and execute a package' };
  if (/\bgit\s+(commit|checkout|merge|rebase|branch\s+-d)/i.test(cmd)) return { risk: 'medium', kind: 'command', reason: 'Modifies git history or working tree' };
  return { risk: 'low', kind: 'command', reason: 'Project-local command' };
}

/** Whether an action at a given risk needs explicit user approval under an autonomy mode. */
export function needsApproval(risk: Risk, autonomy: AutonomyMode, autoApproved = false): boolean {
  if (risk === 'blocked') return false; // blocked is denied outright, never offered
  if (risk === 'high') return true;
  if (autonomy === 'manual') return !(autoApproved && risk === 'low');
  if (autonomy === 'assisted') return false;
  return false;
}

export function scrubbedEnv(scrub: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (scrub) for (const k of Object.keys(env)) if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(k) && !/^(PATH|PATHEXT)$/i.test(k)) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.CI = '1'; env.BROWSER = 'none'; env.FORCE_COLOR = '0'; env.NO_COLOR = '1';
  env.npm_config_yes = 'true'; env.npm_config_fund = 'false'; env.npm_config_audit = 'false'; env.npm_config_update_notifier = 'false';
  return env;
}
