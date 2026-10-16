// Evidence-based delivery status. Every level is derived from operations that actually ran
// (quality gates, file changes); a model finishing its response or a task being marked complete is never evidence.
import type { EvidenceItem, PlatformType, QualityGate, ReadinessReport, Task } from '../../shared/types';
import { requiredEvidence } from './factory';

const gate = (gates: QualityGate[], id: string) => gates.find(g => g.id === id);
const detail = (g?: QualityGate) => (g?.detail ?? '').split('\n')[0].slice(0, 160);

function fromGates(gates: QualityGate[], ids: string[], label: string): EvidenceItem {
  const present = ids.map(id => gate(gates, id)).filter((g): g is QualityGate => !!g);
  const failed = present.find(g => g.status === 'failed');
  if (failed) return { status: 'failed', evidence: `${failed.label} failed${detail(failed) ? `: ${detail(failed)}` : ''}` };
  const passed = present.filter(g => g.status === 'passed');
  if (passed.length) return { status: 'verified', evidence: passed.map(g => `${g.label}: ${detail(g) || 'passed'}`).join('; ') };
  const skipped = present.find(g => g.status === 'skipped');
  return { status: 'not_run', evidence: skipped ? `${label} not run: ${detail(skipped) || 'skipped'}` : `${label} not run` };
}

export function computeReadiness(input: { target: PlatformType | null | undefined; objective: string; gates: QualityGate[]; tasks: Task[] }): ReadinessReport {
  const { gates, tasks } = input;
  const writers = tasks.filter(t => ['code', 'repair', 'optimize', 'agent_request'].includes(t.kind));
  const files = [...new Set(writers.flatMap(t => t.filesTouched))];
  const implemented: EvidenceItem = files.length
    ? { status: writers.some(t => t.kind === 'code' && t.status === 'completed') ? 'verified' : 'failed', evidence: `${files.length} file(s) written${writers.some(t => t.kind === 'code' && t.status === 'failed') ? '; an implementation task did not finish' : ''}` }
    : { status: 'not_run', evidence: 'No files were written' };

  const build = gate(gates, 'build');
  const typecheck = gate(gates, 'typecheck');
  const buildApplicable = [build, typecheck, gate(gates, 'mobile_build'), gate(gates, 'desktop_package')].some(g => g && g.status !== 'skipped');
  // "No build step" is only not-applicable when the gate actually inspected the project and found none.
  const noBuildStep = build?.status === 'skipped' && /no build step/i.test(build.detail ?? '') && (!typecheck || /no typescript/i.test(typecheck.detail ?? ''));
  const buildVerified: EvidenceItem = buildApplicable
    ? fromGates(gates, ['typecheck', 'build', 'mobile_build', 'desktop_package'], 'Build')
    : noBuildStep ? { status: 'not_applicable', evidence: 'Project has no build or typecheck step' }
      : { status: 'not_run', evidence: build ? `Build not run: ${detail(build) || 'skipped'}` : 'Build not run' };

  const testsVerified = fromGates(gates, ['unit', 'endpoint_tests', 'cli_exit_codes'], 'Automated tests');

  const required = requiredEvidence((input.target ?? 'web') as PlatformType);
  const runtimeGates = [...new Set([...required, 'server', 'browser', 'console', 'responsive', 'desktop_launch', 'mobile_emulator', 'service_start', 'cli_help'])];
  const runtime = fromGates(gates, runtimeGates, 'Runtime check');
  const missingRequired = required.filter(id => gate(gates, id)?.status !== 'passed');
  const runtimeVerified: EvidenceItem = runtime.status === 'verified' && missingRequired.length
    ? { status: 'not_run', evidence: `Required runtime evidence missing: ${missingRequired.join(', ')}` }
    : runtime;

  const review = gate(gates, 'review');
  const securityReviewed: EvidenceItem = review?.status === 'passed'
    ? { status: 'verified', evidence: `Automated model code review passed (not a security audit): ${detail(review)}` }
    : review?.status === 'failed' ? { status: 'failed', evidence: `Code review found blocking issues: ${detail(review)}` }
      : { status: 'not_run', evidence: 'No security or code review ran' };

  const deployRequested = /\b(deploy\w*|publish\w* (?:to|on)|host(?:ed|ing)? (?:on|at)|go live|production url)\b/i.test(input.objective);
  const deploymentVerified: EvidenceItem = deployRequested
    ? { status: 'not_run', evidence: 'Deployment was requested but SWARM has no deployment verification step' }
    : { status: 'not_applicable', evidence: 'Deployment was not requested' };

  const levels: [string, EvidenceItem][] = [['Implementation', implemented], ['Build', buildVerified], ['Tests', testsVerified], ['Runtime', runtimeVerified], ['Security review', securityReviewed], ['Deployment', deploymentVerified]];
  const missing = levels.filter(([, e]) => e.status === 'failed' || e.status === 'not_run').map(([name, e]) => `${name}: ${e.status === 'failed' ? 'failed' : 'not verified'} — ${e.evidence}`);
  return { implemented, buildVerified, testsVerified, runtimeVerified, securityReviewed, deploymentVerified, productionReady: missing.length === 0, missing, computedAt: Date.now() };
}

const MARK: Record<EvidenceItem['status'], string> = { verified: 'verified', failed: 'FAILED', not_run: 'not verified', not_applicable: 'n/a' };

/** One line for events/notifications: what is actually known. */
export function readinessHeadline(r: ReadinessReport): string {
  const parts = [`implemented ${MARK[r.implemented.status]}`, `build ${MARK[r.buildVerified.status]}`, `tests ${MARK[r.testsVerified.status]}`, `runtime ${MARK[r.runtimeVerified.status]}`];
  return `${parts.join(', ')}. ${r.productionReady ? 'All applicable checks verified.' : 'Production readiness not yet established.'}`;
}

export function readinessMarkdown(r: ReadinessReport): string {
  const row = (name: string, e: EvidenceItem) => `| ${name} | ${MARK[e.status]} | ${e.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220)} |`;
  return `| Level | Status | Evidence |\n|---|---|---|\n${[
    row('Implemented', r.implemented), row('Build verified', r.buildVerified), row('Tests verified', r.testsVerified),
    row('Runtime verified', r.runtimeVerified), row('Security reviewed', r.securityReviewed), row('Deployment verified', r.deploymentVerified),
  ].join('\n')}\n\n**Production readiness:** ${r.productionReady ? 'every applicable level has verification evidence.' : `not yet established.\n${r.missing.map(m => `- ${m}`).join('\n')}`}`;
}
