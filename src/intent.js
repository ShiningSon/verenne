import { sha256, stableStringify, tokenize } from './utils.js';

const OPTIONAL = /\b(?:optional|optionally|nice[- ]to[- ]have|if possible|may|could)\b|(?:선택|가능하면|되면|여유가 있다면)/iu;
const STOP_WORDS = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'into', 'for', 'are', 'should', 'must', 'will', '하게', '하도록', '그리고', '으로', '에서', '것을', '있도록']);

function cleanCriterion(value) {
  return String(value ?? '')
    .replace(/^\s*(?:[-*+] |\d+[.)]\s*|\[[ xX]\]\s*)/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function criterionLines(task) {
  const raw = String(task ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split('\n').map(cleanCriterion).filter(Boolean);
  if (lines.length > 1) return lines;
  const sentences = raw.split(/(?<=[.!?。！？])\s+/u).map(cleanCriterion).filter(Boolean);
  return sentences.length ? sentences : [raw];
}

export function deriveIntentContract(task, options = {}) {
  const seen = new Set();
  const source = [...criterionLines(task), ...(options.criteria ?? []).map(cleanCriterion)].filter((text) => {
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const requirements = source.map((text, index) => ({
    id: `R${String(index + 1).padStart(2, '0')}`,
    text,
    required: !OPTIONAL.test(text),
    keywords: tokenize(text).filter((word) => !STOP_WORDS.has(word)).slice(0, 12),
  }));
  const contract = {
    schemaVersion: 1,
    task: String(task ?? '').trim(),
    requirements,
    requiredCount: requirements.filter((item) => item.required).length,
  };
  contract.digest = sha256(stableStringify(contract));
  return contract;
}

function normalizedStatus(value) {
  const status = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (['complete', 'completed', 'done', 'implemented', 'satisfied', 'pass', 'passed'].includes(status)) return 'COVERED';
  if (['blocked', 'missing', 'not-done', 'failed', 'unsupported', 'partial'].includes(status)) return 'MISSING';
  return 'UNREPORTED';
}

function fuzzyMatch(requirement, entry) {
  const id = String(entry?.id ?? entry?.requirementId ?? '');
  if (id && id.toLowerCase() === requirement.id.toLowerCase()) return true;
  const text = String(entry?.text ?? entry?.requirement ?? entry?.summary ?? '').toLowerCase();
  if (!text) return false;
  const hits = requirement.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
  return hits >= Math.min(2, Math.max(1, requirement.keywords.length));
}

function values(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.flatMap(values) : [String(value)];
}

const OUTCOME_CLAIMS = new Set([
  'bug_fixed', 'security_fixed', 'feature_implemented', 'docs_updated', 'ui_updated',
  'migration_included', 'dependencies_updated', 'no_breaking_changes', 'tests_added',
  'tests_passed', 'build_passed', 'lint_passed', 'typecheck_passed',
]);

function expectedClaimKinds(requirement) {
  const text = String(requirement.text ?? '').toLowerCase();
  const expected = new Set();
  const security = /security|vulnerab|auth(?:entication|orization)?\s+(?:bug|flaw|issue)|injection|xss|csrf|보안|취약/u.test(text);
  if (security) expected.add('security_fixed');
  else if (/\bfix(?:ed)?\b|\bbug\b|\berror\b|race|crash|오류|버그|고치/u.test(text)) expected.add('bug_fixed');
  if (/\b(?:ui|interface|screen|page|frontend)\b|화면|인터페이스|프론트/u.test(text)) expected.add('ui_updated');
  if (/\b(?:docs?|documentation|readme|guide)\b|문서|가이드/u.test(text)) expected.add('docs_updated');
  if (/dependenc|package|lockfile|의존성|패키지/u.test(text)) expected.add('dependencies_updated');
  if (/migration|schema|마이그레이션|스키마/u.test(text)) expected.add('migration_included');
  if (/without (?:changing|breaking)|no breaking|backward|compatib|preserve|unchanged|변경\s*없이|호환|유지/u.test(text)) expected.add('no_breaking_changes');
  if (/\b(?:add|write|create).{0,20}(?:test|coverage)|regression test|테스트.{0,12}(?:추가|작성)|회귀\s*테스트/u.test(text)) expected.add('tests_added');
  else if (/\btests?\b|테스트/u.test(text)) expected.add('tests_passed');
  if (/\bbuild(?:s| must)?\s+(?:pass|succeed)|빌드.{0,12}(?:통과|성공)/u.test(text)) expected.add('build_passed');
  if (/\blint\b|린트/u.test(text)) expected.add('lint_passed');
  if (/type.?check|타입\s*검사/u.test(text)) expected.add('typecheck_passed');
  const domainSpecific = [...expected].some((kind) => ['ui_updated', 'docs_updated', 'dependencies_updated', 'migration_included', 'tests_added', 'tests_passed'].includes(kind));
  if (!domainSpecific && /\b(?:add|implement|build|create|refactor|support)\b|구현|기능|만들|추가|리팩터/u.test(text)) expected.add('feature_implemented');
  return [...expected];
}

export function evaluateIntentCoverage(contract, agentResult = {}, evidence = {}, evaluatedClaims = []) {
  const declared = Array.isArray(agentResult.requirements)
    ? agentResult.requirements
    : Array.isArray(agentResult.acceptanceCriteria)
      ? agentResult.acceptanceCriteria
      : [];
  const gateIds = new Set((evidence.gates ?? []).filter((gate) => gate.status === 'PASS').flatMap((gate) => {
    // Replayed evidence has a suite-qualified id (for example
    // `gate:test:candidate`) and the immutable policy id in `gateId`. Keep
    // both aliases so intent links are stable across candidate/baseline
    // replay without trusting an agent-provided display id.
    const aliases = [gate.id, gate.gateId].filter(Boolean).map(String);
    for (const value of [...aliases]) {
      if (value.startsWith('gate:')) aliases.push(value.slice('gate:'.length));
      else aliases.push(`gate:${value}`);
      const suiteQualified = value.match(/^gate:(.+):(?:candidate|baseline)$/u);
      if (suiteQualified) aliases.push(suiteQualified[1], `gate:${suiteQualified[1]}`);
    }
    return aliases;
  }));
  const changed = new Set(evidence.analysis?.changedPaths ?? []);
  const requirements = (contract?.requirements ?? []).map((requirement) => {
    const entry = declared.find((candidate) => fuzzyMatch(requirement, candidate));
    const declaredStatus = normalizedStatus(entry?.status ?? entry?.verdict);
    const referencedPaths = (entry?.paths ?? entry?.files ?? []).map(String);
    const referencedGates = (entry?.gates ?? entry?.gateIds ?? []).map(String);
    const referencedClaims = values(entry?.claims ?? entry?.claimIds);
    const observedPaths = referencedPaths.filter((filePath) => changed.has(filePath));
    const observedGates = referencedGates.filter((gateId) => gateIds.has(gateId) || gateIds.has(`gate:${gateId}`));
    const linkedClaims = evaluatedClaims.filter((claim) => referencedClaims.includes(claim.id) && claim.required && claim.verdict === 'PROVEN');
    const expectedKinds = expectedClaimKinds(requirement);
    const outcomeClaims = linkedClaims.filter((claim) => OUTCOME_CLAIMS.has(claim.kind));
    const missingClaimKinds = expectedKinds.length
      ? expectedKinds.filter((kind) => !linkedClaims.some((claim) => claim.kind === kind))
      : outcomeClaims.length > 0 ? [] : ['specific_outcome_claim'];
    const provenClaims = linkedClaims.map((claim) => claim.id);
    const status = declaredStatus === 'MISSING'
      ? 'MISSING'
      : declaredStatus === 'COVERED' && (observedPaths.length > 0 || observedGates.length > 0) && missingClaimKinds.length === 0
        ? 'EVIDENCED'
        : declaredStatus;
    return {
      ...requirement,
      status,
      summary: entry?.summary ?? entry?.notes ?? null,
      paths: observedPaths,
      gates: observedGates,
      claims: provenClaims,
      declaredClaims: referencedClaims,
      expectedClaimKinds: expectedKinds,
      missingClaimKinds,
    };
  });
  const counts = {
    evidenced: requirements.filter((item) => item.status === 'EVIDENCED').length,
    covered: requirements.filter((item) => item.status === 'COVERED').length,
    missing: requirements.filter((item) => item.status === 'MISSING').length,
    unreported: requirements.filter((item) => item.status === 'UNREPORTED').length,
  };
  return {
    requirements,
    counts,
    requiredMissing: requirements.filter((item) => item.required && item.status === 'MISSING').map((item) => item.id),
    requiredUnreported: requirements.filter((item) => item.required && item.status === 'UNREPORTED').map((item) => item.id),
    requiredUnevidenced: requirements.filter((item) => item.required && item.status !== 'EVIDENCED').map((item) => item.id),
    score: requirements.length ? (counts.evidenced + counts.covered * 0.5) / requirements.length : 1,
  };
}
