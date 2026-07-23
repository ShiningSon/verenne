import { CLAIM_VERDICTS, evaluateClaims } from './claims.js';
import { collectCandidateEvidence } from './evidence.js';
import { evaluateIntentCoverage } from './intent.js';

const SEVERITY_WEIGHT = Object.freeze({ critical: 8, high: 4, medium: 2, low: 1 });

function claimCounts(claims) {
  return {
    proven: claims.filter((claim) => claim.verdict === CLAIM_VERDICTS.PROVEN).length,
    contradicted: claims.filter((claim) => claim.verdict === CLAIM_VERDICTS.CONTRADICTED).length,
    unproven: claims.filter((claim) => claim.verdict === CLAIM_VERDICTS.UNPROVEN).length,
    requiredProven: claims.filter((claim) => claim.required && claim.verdict === CLAIM_VERDICTS.PROVEN).length,
    requiredContradicted: claims.filter((claim) => claim.required && claim.verdict === CLAIM_VERDICTS.CONTRADICTED).length,
    requiredUnproven: claims.filter((claim) => claim.required && claim.verdict === CLAIM_VERDICTS.UNPROVEN).length,
    requiredTotal: claims.filter((claim) => claim.required).length,
  };
}

function gateCounts(gates) {
  return {
    passed: gates.filter((gate) => gate.status === 'PASS').length,
    failed: gates.filter((gate) => gate.status === 'FAIL').length,
    errored: gates.filter((gate) => gate.status === 'ERROR').length,
    requiredPassed: gates.filter((gate) => gate.required && gate.status === 'PASS').length,
    requiredFailed: gates.filter((gate) => gate.required && gate.status === 'FAIL').length,
    requiredErrored: gates.filter((gate) => gate.required && gate.status === 'ERROR').length,
    requiredTotal: gates.filter((gate) => gate.required).length,
  };
}

function riskWeight(violations) {
  return violations.reduce((sum, item) => sum + (SEVERITY_WEIGHT[item.severity] ?? 1), 0);
}

function componentScore(numerator, denominator, emptyValue = 0) {
  return denominator === 0 ? emptyValue : Math.max(0, Math.min(1, numerator / denominator));
}

export function scoreCandidate({ claims, gates, trustViolations, stats, policy }) {
  const claimSummary = claimCounts(claims);
  const gateSummary = gateCounts(gates);
  const weights = {
    gates: 45,
    claims: 25,
    trust: 15,
    scope: 10,
    efficiency: 5,
    ...(policy?.scoring ?? {}),
  };
  const claimQuality = componentScore(
    claimSummary.proven - claimSummary.contradicted,
    Math.max(1, claims.length),
  );
  const gateQuality = componentScore(gateSummary.passed, Math.max(1, gates.length));
  const trustQuality = Math.max(0, 1 - riskWeight(trustViolations) / 12);
  const scopeQuality = trustViolations.some((item) => item.id === 'forbidden_path_changed' || item.id === 'protected_input_changed') ? 0 : 1;
  const changedLines = (stats?.additions ?? 0) + (stats?.deletions ?? 0);
  const efficiencyQuality = 1 / (1 + changedLines / 500);
  const breakdown = {
    gates: gateQuality * weights.gates,
    claims: claimQuality * weights.claims,
    trust: trustQuality * weights.trust,
    scope: scopeQuality * weights.scope,
    efficiency: efficiencyQuality * weights.efficiency,
  };
  return {
    total: Math.round(Object.values(breakdown).reduce((sum, value) => sum + value, 0) * 10) / 10,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, Math.round(value * 10) / 10])),
    claimSummary,
    gateSummary,
    risk: riskWeight(trustViolations),
  };
}

function candidateIdentity(lane, agentResult, seal) {
  const agentId = lane?.agentId ?? lane?.adapterId ?? lane?.agent ?? agentResult?.agentId ?? agentResult?.adapterId ?? 'agent';
  const id = String(lane?.id ?? lane?.laneId ?? agentResult?.candidateId ?? `${agentId}-${seal.diffDigest.slice(0, 8)}`);
  return {
    id,
    label: String(lane?.label ?? lane?.name ?? agentResult?.label ?? id),
    agentId: String(agentId),
  };
}

function eligibilityFor({ claims, gates, trustViolations, analysis, intentCoverage, policy, processResult }) {
  const claimSummary = claimCounts(claims);
  const gateSummary = gateCounts(gates);
  const critical = trustViolations.filter((item) => item.severity === 'critical');
  const reasons = [];
  if (!analysis.hasPatch) reasons.push('Candidate produced no mergeable patch.');
  if (processResult?.timedOut) reasons.push('The coding agent timed out before completing its work.');
  if (processResult?.error) reasons.push(`The coding agent could not complete: ${processResult.error}`);
  if (processResult && processResult.code !== 0) reasons.push(`The coding agent exited unsuccessfully (${processResult.code ?? 'no exit code'}).`);
  if (critical.length > 0) reasons.push(`${critical.length} critical trust violation(s).`);
  if (policy?.rules?.requirePositiveReplay !== false && gateSummary.passed === 0) {
    reasons.push('No trusted verification gate passed for this patch.');
  }
  if (gateSummary.requiredFailed > 0) reasons.push(`${gateSummary.requiredFailed} required gate(s) failed.`);
  if (gateSummary.requiredErrored > 0) reasons.push(`${gateSummary.requiredErrored} required gate(s) could not run.`);
  if (claimSummary.requiredContradicted > 0) reasons.push(`${claimSummary.requiredContradicted} required claim(s) were contradicted.`);
  if (claimSummary.requiredTotal === 0) reasons.push('No required acceptance claim was declared.');
  if (intentCoverage.requiredMissing.length > 0) reasons.push(`Required intent items explicitly incomplete: ${intentCoverage.requiredMissing.join(', ')}.`);
  if (policy?.rules?.strictIntentCoverage !== false && intentCoverage.requiredUnevidenced.length > 0) {
    reasons.push(`Required intent items lack observed delivery evidence: ${intentCoverage.requiredUnevidenced.join(', ')}.`);
  }
  if (policy?.rules?.strictRequiredClaims !== false && claimSummary.requiredUnproven > 0) {
    reasons.push(`${claimSummary.requiredUnproven} required claim(s) remain unproven under strict policy.`);
  }

  const eligible = reasons.length === 0;
  const fullyProven = eligible
    && gateSummary.passed > 0
    && gateSummary.requiredFailed === 0
    && gateSummary.requiredErrored === 0
    && claimSummary.requiredUnproven === 0
    && claimSummary.requiredContradicted === 0
    && intentCoverage.requiredUnevidenced.length === 0;
  return { eligible, fullyProven, reasons };
}

function buildSelectionVector({ eligibility, claims, gates, trustViolations, stats, intentCoverage }) {
  const claimSummary = claimCounts(claims);
  const gateSummary = gateCounts(gates);
  const changedLines = (stats?.additions ?? 0) + (stats?.deletions ?? 0);
  return [
    eligibility.eligible ? 1 : 0,
    eligibility.fullyProven ? 1 : 0,
    -intentCoverage.requiredUnevidenced.length,
    -intentCoverage.requiredMissing.length,
    intentCoverage.counts.evidenced,
    intentCoverage.counts.covered,
    -intentCoverage.counts.unreported,
    claimSummary.requiredProven,
    -claimSummary.requiredContradicted,
    -claimSummary.requiredUnproven,
    -gateSummary.requiredFailed,
    -gateSummary.requiredErrored,
    gateSummary.requiredPassed,
    claimSummary.proven,
    -claimSummary.contradicted,
    -claimSummary.unproven,
    -riskWeight(trustViolations),
    -changedLines,
  ];
}

export async function evaluateCandidate({
  repoRoot,
  worktreePath,
  baseSha,
  policyBundle,
  agentResult = {},
  mission = {},
  lane = {},
  artifactDir,
  processResult,
  signal,
}) {
  if (!repoRoot || !worktreePath || !baseSha) throw new Error('evaluateCandidate requires repoRoot, worktreePath, and baseSha.');
  const policy = policyBundle?.policy ?? policyBundle ?? {};
  const collected = await collectCandidateEvidence({
    repoRoot,
    worktreePath,
    baseSha,
    policyBundle,
    agentResult,
    mission,
    lane,
    artifactDir,
    signal,
  });
  const claims = evaluateClaims({
    agentResult,
    evidence: collected.evidence,
    analysis: collected.analysis,
    trustViolations: collected.trustViolations,
    policy,
    mission,
  });
  const intentCoverage = evaluateIntentCoverage(mission.intent, agentResult, collected, claims);
  const eligibility = eligibilityFor({
    claims,
    gates: collected.gates,
    trustViolations: collected.trustViolations,
    analysis: collected.analysis,
    intentCoverage,
    policy,
    processResult,
  });
  const scoreResult = scoreCandidate({
    claims,
    gates: collected.gates,
    trustViolations: collected.trustViolations,
    stats: collected.seal.stats,
    intentCoverage,
    policy,
  });
  const identity = candidateIdentity(lane, agentResult, collected.seal);
  const selectionVector = buildSelectionVector({
    eligibility,
    claims,
    intentCoverage,
    gates: collected.gates,
    trustViolations: collected.trustViolations,
    stats: collected.seal.stats,
  });

  return {
    ...identity,
    worktreePath,
    baseSha: collected.seal.baseSha,
    headSha: collected.seal.headSha,
    diffDigest: collected.seal.diffDigest,
    sealDigest: collected.seal.sealDigest,
    policyDigest: collected.seal.policyDigest,
    stats: collected.seal.stats,
    changedFiles: collected.seal.changedFiles,
    gates: collected.gates,
    claims,
    intentCoverage,
    claimCounts: scoreResult.claimSummary,
    evidence: collected.evidence,
    trustViolations: collected.trustViolations,
    eligibility,
    eligibilityStatus: eligibility.eligible ? 'ELIGIBLE' : 'BLOCKED',
    score: scoreResult.total,
    scoreBreakdown: scoreResult.breakdown,
    summary: {
      claims: scoreResult.claimSummary,
      gates: scoreResult.gateSummary,
      risk: scoreResult.risk,
    },
    selectionVector,
  };
}

export function compareSelectionVectors(left = [], right = []) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = Number(left[index] ?? 0);
    const b = Number(right[index] ?? 0);
    if (a !== b) return a > b ? -1 : 1;
  }
  return 0;
}

export function selectCandidate(candidates = []) {
  const ranked = [...candidates]
    .sort((left, right) => compareSelectionVectors(left.selectionVector, right.selectionVector)
      || String(left.id).localeCompare(String(right.id)))
    .map((candidate, index) => ({ ...candidate, selectionRank: index + 1 }));
  const winner = ranked.find((candidate) => candidate.eligibility?.eligible) ?? null;
  const noWinnerReason = winner
    ? null
    : candidates.length === 0
      ? 'No candidates were evaluated.'
      : 'Every candidate was ineligible after independent replay.';
  const reasons = winner
    ? [`${winner.label} is the highest-ranked eligible patch after trusted gate replay and claim review.`]
    : [noWinnerReason];
  return {
    status: winner ? 'READY' : 'NO_WINNER',
    selectedCandidateId: winner?.id ?? null,
    reasons,
    winner,
    winnerId: winner?.id ?? null,
    ranked,
    noWinnerReason,
  };
}
