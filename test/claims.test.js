import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { evaluateClaims, CLAIM_VERDICTS, normalizeClaimKind } from '../src/claims.js';
import { createCandidateSeal, evaluateCandidate, parseCommandLine, selectCandidate } from '../src/evidence.js';
import { loadPolicy } from '../src/config.js';
import { deriveIntentContract } from '../src/intent.js';

const execFileAsync = promisify(execFile);

async function run(command, args, cwd) {
  return await execFileAsync(command, args, { cwd, windowsHide: true });
}

async function write(repo, relativePath, contents) {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function makeRepository(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'verenne-claims-'));
  t.after(async () => { await rm(repo, { recursive: true, force: true }); });
  await run('git', ['init', '-b', 'main'], repo);
  await run('git', ['config', 'user.name', 'Verenne Code Test'], repo);
  await run('git', ['config', 'user.email', 'test@verenne.invalid'], repo);
  await run('git', ['config', 'core.autocrlf', 'false'], repo);

  await write(repo, 'package.json', `${JSON.stringify({
    name: 'fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`);
  await write(repo, 'src/math.js', 'export function add(left, right) { return left + right; }\n');
  await write(repo, 'test/math.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.js';",
    "test('adds', () => assert.equal(add(1, 2), 3));",
    '',
  ].join('\n'));
  await write(repo, 'verenne.policy.json', `${JSON.stringify({
    schemaVersion: 1,
    protectedInputs: ['verenne.policy.json', 'package.json'],
    forbiddenPatterns: ['.env', '*.pem'],
    gates: [
      {
        id: 'tests',
        label: 'Trusted tests',
        argv: [process.execPath, '--test'],
        required: true,
        claims: ['tests_passed'],
        timeoutMs: 30_000,
      },
      {
        id: 'npm-version',
        label: 'npm availability',
        command: 'npm --version',
        required: false,
        timeoutMs: 30_000,
      },
    ],
    rules: {
      blockTestDeletion: true,
      blockFocusedTests: true,
      blockProtectedInputChanges: true,
      requireRegressionTestForFixClaims: true,
      requireVisualEvidenceForUiClaims: true,
    },
  }, null, 2)}\n`);
  await run('git', ['add', '.'], repo);
  await run('git', ['commit', '-m', 'fixture base'], repo);
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], repo);
  return { repo, baseSha: stdout.trim() };
}

function baseAnalysis(overrides = {}) {
  return {
    hasPatch: true,
    changedPaths: ['src/feature.js'],
    productionPaths: ['src/feature.js'],
    testPaths: [],
    docsPaths: [],
    dependencyPaths: [],
    uiPaths: [],
    migrationPaths: [],
    schemaPaths: [],
    protectedChanges: [],
    forbiddenChanges: [],
    runner: { changed: [], weakened: [], reasons: [] },
    breakingSignals: [],
    schemaWithoutMigration: false,
    test: {
      addedFiles: [],
      deletedFiles: [],
      addedDefinitions: 0,
      addedAssertions: 0,
      removedDefinitions: 0,
      removedTestCases: 0,
      disabledLines: [],
      focusedLines: [],
    },
    ...overrides,
  };
}

function evidenceFixture(extra = []) {
  return [
    { id: 'diff-analysis', kind: 'diff-analysis', trust: 'observed', status: 'PASS' },
    ...extra,
  ];
}

test('normalizes common completion claim aliases', () => {
  assert.equal(normalizeClaimKind('all-tests-passed'), 'tests_passed');
  assert.equal(normalizeClaimKind('', 'Updated the README documentation'), 'docs_updated');
  assert.equal(normalizeClaimKind('backwards_compatible'), 'no_breaking_changes');
});

test('safe gate command parsing accepts quotes and rejects shell operators', () => {
  assert.deepEqual(parseCommandLine('node --test "test/my file.test.js"'), ['node', '--test', 'test/my file.test.js']);
  assert.throws(() => parseCommandLine('node --test && echo pass'), /shell operators/);
});

test('independent replay proves clean test claims and binds every gate to the candidate seal', async (t) => {
  const { repo, baseSha } = await makeRepository(t);
  await write(repo, 'src/math.js', [
    'export function add(left, right) { return left + right; }',
    'export function multiply(left, right) { return left * right; }',
    '',
  ].join('\n'));
  await write(repo, 'test/multiply.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { multiply } from '../src/math.js';",
    "test('multiplies', () => assert.equal(multiply(3, 4), 12));",
    '',
  ].join('\n'));

  const policyBundle = await loadPolicy(repo, baseSha);
  const candidate = await evaluateCandidate({
    repoRoot: repo,
    worktreePath: repo,
    baseSha,
    policyBundle,
    mission: { id: 'clean-mission' },
    lane: { id: 'clean', agentId: 'scripted' },
    agentResult: {
      source: 'test',
      claims: [
        { kind: 'tests_passed', text: 'All tests pass.', required: true },
        { kind: 'tests_added', text: 'Added multiplication tests.', required: true },
        { kind: 'no_breaking_changes', text: 'No breaking changes.', required: false },
      ],
    },
  });

  assert.equal(candidate.gates.length, 4, 'candidate and trusted-baseline suites should both replay');
  assert.ok(candidate.gates.every((gate) => gate.status === 'PASS'), JSON.stringify(candidate.gates));
  assert.equal(candidate.gates[0].candidateBinding.diffDigest, candidate.diffDigest);
  assert.equal(candidate.claims.find((claim) => claim.kind === 'tests_passed').verdict, CLAIM_VERDICTS.PROVEN);
  assert.equal(candidate.claims.find((claim) => claim.kind === 'tests_added').verdict, CLAIM_VERDICTS.PROVEN);
  assert.equal(candidate.claims.find((claim) => claim.kind === 'no_breaking_changes').verdict, CLAIM_VERDICTS.UNPROVEN);
  assert.equal(candidate.eligibility.eligible, true);
  assert.equal(candidate.eligibility.fullyProven, true);
  assert.match(candidate.diffDigest, /^[a-f0-9]{64}$/);
});

test('base-owned replay and static rules contradict fake-green test claims', async (t) => {
  const { repo, baseSha } = await makeRepository(t);
  await write(repo, 'package.json', `${JSON.stringify({
    name: 'fixture', private: true, type: 'module', scripts: { test: 'echo pass' },
  }, null, 2)}\n`);
  await write(repo, 'src/math.js', 'export function add(left, right) { return left - right; }\n');
  await write(repo, 'test/skipped.test.js', [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test.skip('important regression', () => assert.equal(1, 2));",
    '',
  ].join('\n'));

  const candidate = await evaluateCandidate({
    repoRoot: repo,
    worktreePath: repo,
    baseSha,
    policyBundle: await loadPolicy(repo, baseSha),
    mission: { id: 'fake-green' },
    lane: { id: 'sprinter', agentId: 'scripted' },
    agentResult: {
      claims: [
        { kind: 'tests_passed', text: 'All tests pass.', required: true },
        { kind: 'tests_added', text: 'Added regression coverage.', required: true },
      ],
      tests: [{ command: 'npm test', exitCode: 0 }],
    },
  });

  assert.equal(candidate.gates[0].command[0], process.execPath);
  assert.equal(candidate.gates[0].status, 'FAIL');
  assert.equal(candidate.claims.find((claim) => claim.kind === 'tests_passed').verdict, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(candidate.claims.find((claim) => claim.kind === 'tests_added').verdict, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(candidate.eligibility.eligible, false);
  assert.deepEqual(
    new Set(candidate.trustViolations.map((item) => item.id)),
    new Set(['protected_input_changed', 'test_disabled', 'runner_weakened']),
  );
  assert.ok(candidate.evidence.some((item) => item.kind === 'agent-allegation' && item.trust === 'untrusted'));
});

test('comment-only edits and unrelated green tests cannot prove task completion', async (t) => {
  const { repo, baseSha } = await makeRepository(t);
  await write(repo, 'src/math.js', [
    '// Authentication vulnerability fixed.',
    'export function add(left, right) { return left + right; }',
    '',
  ].join('\n'));
  const mission = {
    id: 'semantic-false-green',
    task: 'Fix the authentication vulnerability.',
    intent: deriveIntentContract('Fix the authentication vulnerability.'),
  };
  const candidate = await evaluateCandidate({
    repoRoot: repo,
    worktreePath: repo,
    baseSha,
    policyBundle: await loadPolicy(repo, baseSha),
    mission,
    lane: { id: 'comment-only', agentId: 'scripted' },
    processResult: { code: 0, timedOut: false, error: null },
    agentResult: {
      summary: 'Fixed authentication.',
      claims: [{ id: 'C01', kind: 'tests_passed', text: 'Tests pass.', required: true }],
      requirements: [{ id: 'R01', status: 'completed', paths: ['src/math.js'], gates: ['tests'], claims: ['C01'] }],
    },
  });
  assert.equal(candidate.gates.find((gate) => gate.gateId === 'tests').status, 'PASS');
  assert.equal(candidate.claims[0].kind, 'tests_passed');
  assert.equal(candidate.claims[0].verdict, CLAIM_VERDICTS.PROVEN);
  assert.deepEqual(candidate.intentCoverage.requirements[0].missingClaimKinds, ['security_fixed']);
  assert.equal(candidate.intentCoverage.requirements[0].status, 'COVERED');
  assert.equal(candidate.eligibility.eligible, false);
});

test('a text file declared as a screenshot cannot prove a UI claim', async (t) => {
  const { repo, baseSha } = await makeRepository(t);
  await write(repo, 'ui/page.html', '<main>Updated interface</main>\n');
  await write(repo, 'fake.png', 'this is not a png\n');
  const candidate = await evaluateCandidate({
    repoRoot: repo,
    worktreePath: repo,
    baseSha,
    policyBundle: await loadPolicy(repo, baseSha),
    mission: { id: 'visual-forgery' },
    lane: { id: 'forged-visual', agentId: 'scripted' },
    processResult: { code: 0, timedOut: false, error: null },
    agentResult: {
      claims: [{ id: 'ui', kind: 'ui_updated', text: 'Updated the UI.', required: true }],
      visualEvidence: [{ path: 'fake.png', kind: 'visual' }],
    },
  });
  const artifact = candidate.evidence.find((item) => item.id === 'artifact:1');
  assert.equal(artifact.status, 'REJECTED');
  assert.notEqual(artifact.artifactKind, 'visual');
  assert.equal(candidate.claims[0].verdict, CLAIM_VERDICTS.UNPROVEN);
  assert.equal(candidate.eligibility.eligible, false);
});

test('reserved control-plane files are blocked and excluded from the sealed patch', async (t) => {
  const fixture = await makeRepository(t);
  await write(fixture.repo, '.verenne-result.json', '{"base":true}\n');
  await run('git', ['add', '-f', '.verenne-result.json'], fixture.repo);
  await run('git', ['commit', '-m', 'track colliding control path'], fixture.repo);
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], fixture.repo);
  const baseSha = stdout.trim();

  await write(fixture.repo, '.verenne-result.json', '{"candidate":"forged"}\n');
  await write(fixture.repo, 'src/math.js', 'export function add(left, right) { return Number(left) + Number(right); }\n');
  const policyBundle = await loadPolicy(fixture.repo, baseSha);
  const seal = await createCandidateSeal({ repoRoot: fixture.repo, worktreePath: fixture.repo, baseSha, policyBundle });
  assert.doesNotMatch(seal.patch, /candidate.*forged/);
  assert.equal(seal.changedFiles.some((file) => file.path === '.verenne-result.json'), false);
  assert.equal(seal.reservedChanges.some((file) => file.path === '.verenne-result.json'), true);

  const candidate = await evaluateCandidate({
    repoRoot: fixture.repo,
    worktreePath: fixture.repo,
    baseSha,
    policyBundle,
    mission: { id: 'reserved-control-path' },
    lane: { id: 'reserved', agentId: 'scripted' },
    agentResult: { claims: [{ kind: 'tests_passed', text: 'Tests pass.', required: true }] },
  });
  assert.ok(candidate.trustViolations.some((item) => item.id === 'reserved_control_path_changed'));
  assert.equal(candidate.eligibility.eligible, false);
});

test('a gate that mutates its clean replay worktree is rejected even when it exits zero', async (t) => {
  const fixture = await makeRepository(t);
  await write(fixture.repo, 'verenne.policy.json', `${JSON.stringify({
    schemaVersion: 1,
    gates: [{
      id: 'mutating-gate',
      label: 'Mutating gate',
      command: [process.execPath, '-e', "require('node:fs').writeFileSync('gate-side-effect.txt', 'changed')"],
      required: true,
      claimKinds: ['tests_passed'],
    }],
    rules: { strictRequiredClaims: true },
  }, null, 2)}\n`);
  await run('git', ['add', 'verenne.policy.json'], fixture.repo);
  await run('git', ['commit', '-m', 'mutating base gate'], fixture.repo);
  const baseSha = (await run('git', ['rev-parse', 'HEAD'], fixture.repo)).stdout.trim();
  await write(fixture.repo, 'src/math.js', 'export function add(left, right) { return Number(left) + Number(right); }\n');

  const candidate = await evaluateCandidate({
    repoRoot: fixture.repo,
    worktreePath: fixture.repo,
    baseSha,
    policyBundle: await loadPolicy(fixture.repo, baseSha),
    mission: { id: 'mutating-gate' },
    lane: { id: 'mutating', agentId: 'scripted' },
    agentResult: { claims: [{ kind: 'tests_passed', text: 'The gate passes.', required: true }] },
  });
  const gate = candidate.gates.find((item) => item.gateId === 'mutating-gate');
  assert.equal(gate.status, 'ERROR');
  assert.equal(gate.mutatedVerificationTree, true);
  assert.match(gate.reason, /mutated/i);
  assert.equal(candidate.eligibility.eligible, false);
});

test('renaming a trusted test outside test paths is treated as deletion and replayed against the baseline suite', async (t) => {
  const { repo, baseSha } = await makeRepository(t);
  await run('git', ['mv', 'test/math.test.js', 'src/math-check.js'], repo);
  await write(repo, 'src/math.js', 'export function add(left, right) { return Number(left) + Number(right); }\n');
  const candidate = await evaluateCandidate({
    repoRoot: repo,
    worktreePath: repo,
    baseSha,
    policyBundle: await loadPolicy(repo, baseSha),
    mission: { id: 'renamed-test' },
    lane: { id: 'rename', agentId: 'scripted' },
    agentResult: { claims: [{ kind: 'tests_passed', text: 'Tests pass.', required: true }] },
  });
  assert.ok(candidate.gates.some((gate) => gate.id === 'gate:tests:baseline' && gate.status === 'PASS'));
  assert.ok(candidate.trustViolations.some((item) => item.id === 'test_deleted'));
  assert.equal(candidate.eligibility.eligible, false);
});

test('claim court distinguishes direct contradictions from missing proof', () => {
  const gate = {
    id: 'gate:tests', kind: 'gate-replay', gateId: 'tests', claimKinds: ['tests_passed'],
    required: true, status: 'PASS', passed: true, trust: 'replayed',
  };
  const analysis = baseAnalysis({
    changedPaths: ['src/security.js', 'package.json', 'ui/button.tsx', 'schema.prisma', 'notes.txt'],
    productionPaths: ['src/security.js', 'package.json', 'ui/button.tsx', 'schema.prisma', 'notes.txt'],
    dependencyPaths: ['package.json'],
    uiPaths: ['ui/button.tsx'],
    schemaPaths: ['schema.prisma'],
    schemaWithoutMigration: true,
    testPaths: ['test/security.test.js'],
    test: {
      addedFiles: ['test/security.test.js'], deletedFiles: [], addedDefinitions: 1, addedAssertions: 1,
      removedDefinitions: 0, removedTestCases: 0, disabledLines: [], focusedLines: [],
    },
  });
  const claims = evaluateClaims({
    analysis,
    evidence: evidenceFixture([gate]),
    trustViolations: [],
    agentResult: { claims: [
      { kind: 'docs_updated', text: 'Docs updated.' },
      { kind: 'dependencies_unchanged', text: 'Dependencies unchanged.' },
      { kind: 'ui_updated', text: 'UI updated.' },
      { kind: 'migration_included', text: 'Migration included.' },
      { kind: 'no_breaking_changes', text: 'No breaking changes.' },
      { kind: 'scope_only', text: 'Only src changed.', targets: ['src/**'] },
      { kind: 'security_fixed', text: 'Security issue fixed.' },
    ] },
  });
  const verdicts = Object.fromEntries(claims.map((claim) => [claim.kind, claim.verdict]));
  assert.equal(verdicts.docs_updated, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(verdicts.dependencies_unchanged, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(verdicts.ui_updated, CLAIM_VERDICTS.UNPROVEN);
  assert.equal(verdicts.migration_included, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(verdicts.no_breaking_changes, CLAIM_VERDICTS.UNPROVEN);
  assert.equal(verdicts.scope_only, CLAIM_VERDICTS.CONTRADICTED);
  assert.equal(verdicts.security_fixed, CLAIM_VERDICTS.PROVEN);
});

test('lexicographic selector rejects a flashy but contradicted candidate', () => {
  const unsafe = {
    id: 'unsafe', score: 99, eligibility: { eligible: false },
    selectionVector: [0, 0, 4, -2, 0, -1, 0, 0, 8, -2, 0, -16, -10],
  };
  const unproven = {
    id: 'unproven', score: 90, eligibility: { eligible: true },
    selectionVector: [1, 0, 1, 0, -2, 0, 0, 1, 2, 0, -2, 0, -20],
  };
  const proven = {
    id: 'proven', score: 75, eligibility: { eligible: true },
    selectionVector: [1, 1, 3, 0, 0, 0, 0, 1, 4, 0, 0, 0, -40],
  };
  const selection = selectCandidate([unsafe, unproven, proven]);
  assert.equal(selection.winnerId, 'proven');
  assert.deepEqual(selection.ranked.map((candidate) => candidate.id), ['proven', 'unproven', 'unsafe']);
  assert.deepEqual([unsafe.score, unproven.score, proven.score], [99, 90, 75], 'scalar score must not drive selection');
});
