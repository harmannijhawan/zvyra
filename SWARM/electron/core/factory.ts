import type { PlatformType } from '../../shared/types';

/** Conservative, local admission rule: uncertain work retains the full planner. */
export function isSmallChange(objective: string): boolean {
  return objective.length <= 600 && /\b(fix|change|rename|adjust|correct|update)\b/i.test(objective)
    && !/\b(architecture|migrat\w*|rewrite|entire|authentication|payment|security|database|multi\w*|research)\b/i.test(objective);
}

export function requiredEvidence(target: PlatformType): string[] {
  switch (target) {
    case 'web': return ['browser'];
    case 'android': return ['mobile_build', 'mobile_emulator'];
    case 'ios': return ['mobile_build'];
    case 'windows': case 'macos': case 'linux': case 'desktop': return ['desktop_launch'];
    case 'cli': return ['cli_help'];
    case 'api': case 'backend': return ['service_start', 'endpoint_tests'];
    default: return ['build'];
  }
}

export function missingEvidence(target: PlatformType, gates: { id: string; status: string }[]): string[] {
  return requiredEvidence(target).filter(id => !gates.some(g => g.id === id && g.status === 'passed'));
}
