import { matchesPathPattern } from './evidence.js';

export const CLAIM_VERDICTS = Object.freeze({
  PROVEN: 'PROVEN',
  CONTRADICTED: 'CONTRADICTED',
  UNPROVEN: 'UNPROVEN',
});

const KIND_ALIASES = new Map([
  ['test_passed', 'tests_passed'],
  ['tests_pass', 'tests_passed'],
  ['all_tests_pass', 'tests_passed'],
  ['all_tests_passed', 'tests_passed'],
  ['test_added', 'tests_added'],
  ['added_tests', 'tests_added'],
  ['documentation_updated', 'docs_updated'],
  ['readme_updated', 'docs_updated'],
  ['dependency_unchanged', 'dependencies_unchanged'],
  ['deps_unchanged', 'dependencies_unchanged'],
  ['dependency_updated', 'dependencies_updated'],
  ['deps_updated', 'dependencies_updated'],
  ['no_breaking_change', 'no_breaking_changes'],
  ['backwards_compatible', 'no_breaking_changes'],
  ['backward_compatible', 'no_breaking_changes'],
  ['visual_updated', 'ui_updated'],
  ['interface_updated', 'ui_updated'],
  ['security_fix', 'security_fixed'],
  ['vulnerability_fixed', 'security_fixed'],
  ['migration_added', 'migration_included'],
  ['migrations_added', 'migration_included'],
  ['only_changed', 'scope_only'],
  ['scope', 'scope_only'],
  ['lint_passes', 'lint_passed'],
  ['typecheck_passes', 'typecheck_passed'],
  ['build_passes', 'build_passed'],
  ['implemented', 'feature_implemented'],
  ['fixed', 'bug_fixed'],
]);

export function normalizeClaimKind(kind, text = '') {
  let value = String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (KIND_ALIASES.has(value)) value = KIND_ALIASES.get(value);
  if (value) return value;

  const sentence = String(text ?? '').toLowerCase();
  if (/(?:all\s+)?tests?\s+(?:are\s+)?pass/.test(sentence)) return 'tests_passed';
  if (/(?:added|wrote|created)\s+(?:new\s+)?tests?/.test(sentence)) return 'tests_added';
  if (/(?:docs?|documentation|readme).*(?:updated|added)|(?:updated|added).*(?:docs?|documentation|readme)/.test(sentence)) return 'docs_updated';
  if (/dependenc(?:y|ies).*(?:unchanged|not changed)|no\s+dependenc(?:y|ies)\s+changes?/.test(sentence)) return 'dependencies_unchanged';
  if (/no\s+breaking\s+changes?|backwards?\s+compatible/.test(sentence)) return 'no_breaking_changes';
  if (/(?:ui|interface|screen|page).*(?:updated|implemented|built)|(?:updated|implemented|built).*(?:ui|interface|screen|page)/.test(sentence)) return 'ui_updated';
  if (/(?:security|vulnerability|injection|xss|csrf).*(?:fixed|resolved|patched)|(?:fixed|resolved|patched).*(?:security|vulnerability|injection|xss|csrf)/.test(sentence)) return 'security_fixed';
  if (/migration.*(?:included|added|created)/.test(sentence)) return 'migration_included';
  return 'unknown';
}

function stringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(stringArray);
  return [String(value)].filter(Boolean);
}

export function normalizeClaims(agentResult = {}) {
  const supplied = Array.isArray(agentResult.claims) ? agentResult.claims : [];
  if (supplied.length === 0) {
    return [{
      id: 'claim-1',
      kind: 'task_completed',
      text: agentResult.summary || 'Agent reported completion without structured claims.',
      required: true,
      targets: [],
      source: agentResult.source ?? 'agent-result',
    }];
  }
  return supplied.map((claim, index) => {
    const value = typeof claim === 'string' ? { text: claim } : claim ?? {};
    return {
      ...value,
      id: String(value.id ?? `claim-${index + 1}`),
      kind: normalizeClaimKind(value.kind, value.text),
      text: String(value.text ?? value.kind ?? `Claim ${index + 1}`),
      required: value.required === true || value.importance === 'required',
      targets: [...new Set([
        ...stringArray(value.targets),
        ...stringArray(value.paths),
        ...stringArray(value.files),
        ...stringArray(value.scope),
      ])],
      source: value.source ?? agentResult.source ?? 'agent-result',
    };
  });
}

function gateEvidence(evidence) {
  return evidence.filter((item) => item.kind === 'gate-replay');
}

function gateMatches(gate, claimKind, pattern) {
  const declared = (gate.claimKinds ?? []).map((kind) => normalizeClaimKind(kind));
  if (declared.includes(claimKind)) return true;
  const searchable = `${gate.gateId ?? ''} ${gate.gateKind ?? ''} ${gate.label ?? ''}`;
  return pattern.test(searchable);
}

function gateSignal(evidence, claimKind, pattern) {
  const matched = gateEvidence(evidence).filter((gate) => gateMatches(gate, claimKind, pattern));
  return {
    matched,
    passed: matched.filter((gate) => gate.status === 'PASS'),
    failed: matched.filter((gate) => gate.status === 'FAIL'),
    errored: matched.filter((gate) => gate.status === 'ERROR'),
  };
}

function explicitlyLinkedGateSignal(evidence, claimKind) {
  const matched = gateEvidence(evidence).filter((gate) => (
    (gate.claimKinds ?? []).map((kind) => normalizeClaimKind(kind)).includes(claimKind)
  ));
  return {
    matched,
    passed: matched.filter((gate) => gate.status === 'PASS'),
    failed: matched.filter((gate) => gate.status === 'FAIL'),
    errored: matched.filter((gate) => gate.status === 'ERROR'),
  };
}

function relevantViolations(trustViolations, ids) {
  return trustViolations.filter((item) => ids.includes(item.id));
}

function evidenceIds(items) {
  return [...new Set(items.flatMap((item) => item.evidenceIds ?? [item.id]).filter(Boolean))];
}

function decision(verdict, reason, evidence = [], counterEvidence = []) {
  return {
    verdict,
    reason,
    evidenceIds: evidenceIds(evidence),
    counterEvidenceIds: evidenceIds(counterEvidence),
  };
}

function proven(reason, evidence = []) {
  return decision(CLAIM_VERDICTS.PROVEN, reason, evidence);
}

function contradicted(reason, counterEvidence = []) {
  return decision(CLAIM_VERDICTS.CONTRADICTED, reason, [], counterEvidence);
}

function unproven(reason, evidence = [], counterEvidence = []) {
  return decision(CLAIM_VERDICTS.UNPROVEN, reason, evidence, counterEvidence);
}

function diffEvidence(evidence) {
  return evidence.filter((item) => item.id === 'diff-analysis');
}

function visualEvidence(evidence) {
  return evidence.filter((item) => item.kind === 'artifact' && item.artifactKind === 'visual' && item.status === 'PASS');
}

function requiredGateSignal(evidence) {
  const matched = gateEvidence(evidence).filter((gate) => gate.required);
  return {
    matched,
    passed: matched.filter((gate) => gate.status === 'PASS'),
    failed: matched.filter((gate) => gate.status === 'FAIL'),
    errored: matched.filter((gate) => gate.status === 'ERROR'),
  };
}

function evaluateTestsPassed(context) {
  const tampering = relevantViolations(context.trustViolations, ['test_deleted', 'test_cases_removed', 'test_disabled', 'test_focused', 'runner_weakened']);
  if (tampering.length > 0) return contradicted('The test result is invalidated by deleted, disabled, focused, or weakened tests.', tampering);
  const gates = gateSignal(context.evidence, 'tests_passed', /(?:^|\b)(?:test|tests|pytest|jest|vitest|mocha)(?:\b|$)/i);
  if (gates.failed.length > 0) return contradicted('An independently replayed test gate failed.', gates.failed);
  if (gates.passed.length > 0) return proven('A base-owned test gate passed in a fresh verification worktree.', gates.passed);
  return unproven('No successful independent test replay is bound to this candidate.', gates.errored);
}

function evaluateTestsAdded(context) {
  const tampering = relevantViolations(context.trustViolations, ['test_deleted', 'test_disabled', 'test_focused', 'runner_weakened']);
  if (tampering.length > 0) return contradicted('The added-test claim is undermined by deleted, disabled, focused, or weakened tests.', tampering);
  const test = context.analysis.test;
  if (test.addedDefinitions > 0 && test.addedAssertions > 0) {
    return proven(`The diff adds ${test.addedDefinitions} test definition(s) and ${test.addedAssertions} assertion signal(s).`, diffEvidence(context.evidence));
  }
  if (test.addedDefinitions > 0) return unproven('Test definitions changed, but no assertion signal was found.', diffEvidence(context.evidence));
  return contradicted('No added test definition was found in the candidate diff.', diffEvidence(context.evidence));
}

function evaluateDocsUpdated(context) {
  return context.analysis.docsPaths.length > 0
    ? proven(`Documentation changed: ${context.analysis.docsPaths.join(', ')}.`, diffEvidence(context.evidence))
    : contradicted('The candidate diff contains no documentation change.', diffEvidence(context.evidence));
}

function evaluateDependenciesUnchanged(context) {
  return context.analysis.dependencyPaths.length === 0
    ? proven('The complete candidate diff contains no dependency manifest or lockfile change.', diffEvidence(context.evidence))
    : contradicted(`Dependency inputs changed: ${context.analysis.dependencyPaths.join(', ')}.`, diffEvidence(context.evidence));
}

function evaluateDependenciesUpdated(context) {
  return context.analysis.dependencyPaths.length > 0
    ? proven(`Dependency inputs changed: ${context.analysis.dependencyPaths.join(', ')}.`, diffEvidence(context.evidence))
    : contradicted('The candidate diff contains no dependency manifest or lockfile change.', diffEvidence(context.evidence));
}

function evaluateUiUpdated(context) {
  if (context.analysis.uiPaths.length === 0) return contradicted('The candidate diff contains no recognized UI change.', diffEvidence(context.evidence));
  const artifacts = visualEvidence(context.evidence);
  const gates = gateSignal(context.evidence, 'ui_updated', /(?:ui|visual|browser|e2e|playwright|cypress)/i);
  if (gates.failed.length > 0) return contradicted('An independently replayed UI or browser gate failed.', gates.failed);
  if (artifacts.length === 0) return unproven('UI code changed, but no candidate-bound visual artifact was supplied.', diffEvidence(context.evidence));
  if (gates.passed.length === 0) return unproven('A genuine visual artifact exists, but no base-owned UI or browser gate passed.', artifacts, gates.errored);
  return proven('The UI diff has a validated image or video artifact and a passing base-owned UI gate.', [...diffEvidence(context.evidence), ...artifacts, ...gates.passed]);
}

function evaluateSecurityFixed(context) {
  const tampering = relevantViolations(context.trustViolations, ['test_deleted', 'test_disabled', 'test_focused', 'runner_weakened']);
  if (tampering.length > 0) return contradicted('Security proof is invalidated by test tampering.', tampering);
  const security = gateSignal(context.evidence, 'security_fixed', /(?:security|audit|sast|vulnerability)/i);
  if (security.failed.length > 0) return contradicted('An independently replayed security gate failed.', security.failed);
  if (security.passed.length > 0) return proven('A base-owned security gate passed in a fresh verification worktree.', security.passed);

  const tests = gateSignal(context.evidence, 'tests_passed', /(?:^|\b)(?:test|tests|pytest|jest|vitest|mocha)(?:\b|$)/i);
  if (tests.failed.length > 0) return contradicted('The regression test gate failed for the claimed security fix.', tests.failed);
  const regressionAdded = context.analysis.test.addedDefinitions > 0 && context.analysis.test.addedAssertions > 0;
  if (regressionAdded && tests.passed.length > 0 && context.analysis.productionPaths.length > 0) {
    return proven('Production code changed and a new regression test passed independently.', [...diffEvidence(context.evidence), ...tests.passed]);
  }
  return unproven('A security claim requires a passing security gate or a new passing regression test.', [...tests.passed, ...diffEvidence(context.evidence)]);
}

function evaluateMigrationIncluded(context) {
  if (context.analysis.migrationPaths.length > 0) {
    return proven(`Migration artifacts changed: ${context.analysis.migrationPaths.join(', ')}.`, diffEvidence(context.evidence));
  }
  if (context.analysis.schemaPaths.length > 0) {
    return contradicted('Schema files changed without a migration artifact.', diffEvidence(context.evidence));
  }
  return contradicted('The candidate diff contains no recognized migration artifact.', diffEvidence(context.evidence));
}

function evaluateNoBreakingChanges(context) {
  if (context.analysis.breakingSignals.length > 0) {
    return contradicted(`The diff removes ${context.analysis.breakingSignals.length} public-surface signal(s).`, diffEvidence(context.evidence));
  }
  const contract = gateSignal(context.evidence, 'no_breaking_changes', /(?:contract|compat|api|schema)/i);
  if (contract.failed.length > 0) return contradicted('An independently replayed compatibility gate failed.', contract.failed);
  if (contract.passed.length > 0) return proven('A base-owned compatibility gate passed with no static breaking signal.', [...diffEvidence(context.evidence), ...contract.passed]);
  return unproven('No breaking removal was detected, but absence of a compatibility gate is not proof of compatibility.', diffEvidence(context.evidence));
}

function evaluateScopeOnly(context, claim) {
  if (claim.targets.length === 0) return unproven('The scope claim did not declare allowed paths or patterns.');
  const unexpected = context.analysis.changedPaths.filter((filePath) => !claim.targets.some((pattern) => matchesPathPattern(filePath, pattern)));
  if (unexpected.length > 0) return contradicted(`Changes fall outside the claimed scope: ${unexpected.join(', ')}.`, diffEvidence(context.evidence));
  return proven('Every changed file matches the declared scope.', diffEvidence(context.evidence));
}

function evaluateQualityGate(context, claimKind, pattern, label) {
  const gates = gateSignal(context.evidence, claimKind, pattern);
  if (gates.failed.length > 0) return contradicted(`An independently replayed ${label} gate failed.`, gates.failed);
  if (gates.passed.length > 0) return proven(`A base-owned ${label} gate passed in a fresh verification worktree.`, gates.passed);
  return unproven(`No successful independent ${label} replay is bound to this candidate.`, gates.errored);
}

function evaluateBugFixed(context) {
  const gates = requiredGateSignal(context.evidence);
  if (gates.failed.length > 0) return contradicted('A required verification gate failed.', gates.failed);
  const regressionAdded = context.analysis.test.addedDefinitions > 0 && context.analysis.test.addedAssertions > 0;
  const tests = gateSignal(context.evidence, 'tests_passed', /(?:^|\b)(?:test|tests|pytest|jest|vitest|mocha)(?:\b|$)/i);
  if (regressionAdded && tests.passed.length > 0) return proven('A new regression test passed independently.', [...diffEvidence(context.evidence), ...tests.passed]);
  return unproven('A bug-fix claim requires a new independently passing regression test.', [...diffEvidence(context.evidence), ...gates.passed]);
}

function evaluateFeatureImplemented(context) {
  if (context.analysis.productionPaths.length === 0) return contradicted('No production code change was found.', diffEvidence(context.evidence));
  const gates = explicitlyLinkedGateSignal(context.evidence, 'feature_implemented');
  if (gates.failed.length > 0) return contradicted('A required verification gate failed.', gates.failed);
  if (gates.matched.length > 0 && gates.passed.length === gates.matched.length) {
    return proven('Production code changed and every base-owned gate explicitly linked to this feature passed.', [...diffEvidence(context.evidence), ...gates.passed]);
  }
  const regressionAdded = context.analysis.test.addedDefinitions > 0 && context.analysis.test.addedAssertions > 0;
  const tests = gateSignal(context.evidence, 'tests_passed', /(?:^|\b)(?:test|tests|pytest|jest|vitest|mocha)(?:\b|$)/i);
  if (regressionAdded && tests.failed.length === 0 && tests.passed.length > 0) {
    return proven('Production code changed and newly added acceptance-test signals passed independent replay.', [...diffEvidence(context.evidence), ...tests.passed]);
  }
  return unproven('A generic feature claim requires a base-owned gate whose claimKinds explicitly includes feature_implemented.', [...diffEvidence(context.evidence), ...gates.passed], gates.errored);
}

function evaluateOneClaim(context, claim) {
  switch (claim.kind) {
    case 'tests_passed': return evaluateTestsPassed(context);
    case 'tests_added': return evaluateTestsAdded(context);
    case 'docs_updated': return evaluateDocsUpdated(context);
    case 'dependencies_unchanged': return evaluateDependenciesUnchanged(context);
    case 'dependencies_updated': return evaluateDependenciesUpdated(context);
    case 'ui_updated': return evaluateUiUpdated(context);
    case 'security_fixed': return evaluateSecurityFixed(context);
    case 'migration_included': return evaluateMigrationIncluded(context);
    case 'no_breaking_changes': return evaluateNoBreakingChanges(context);
    case 'scope_only': return evaluateScopeOnly(context, claim);
    case 'build_passed': return evaluateQualityGate(context, claim.kind, /(?:build|compile)/i, 'build');
    case 'lint_passed': return evaluateQualityGate(context, claim.kind, /(?:lint|eslint|ruff|clippy)/i, 'lint');
    case 'typecheck_passed': return evaluateQualityGate(context, claim.kind, /(?:typecheck|type-check|tsc|mypy|pyright)/i, 'typecheck');
    case 'bug_fixed': return evaluateBugFixed(context);
    case 'feature_implemented': return evaluateFeatureImplemented(context);
    case 'task_completed': {
      return unproven('Generic task completion is never proof. Declare specific required claims and link each intent requirement to their claim IDs.');
    }
    default: return unproven(`No deterministic proof rule is registered for claim kind ${JSON.stringify(claim.kind)}.`);
  }
}

export function evaluateClaims({ agentResult, evidence = [], analysis = {}, trustViolations = [], policy = {}, mission = {} }) {
  const context = { evidence, analysis, trustViolations, policy, mission };
  return normalizeClaims(agentResult).map((claim) => ({
    ...claim,
    ...evaluateOneClaim(context, claim),
  }));
}
