import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { buildStepSummary, createSarif, runAction } from '../src/action.js';
import { APP_NAME, VERSION } from '../src/utils.js';
import { runProcess } from '../src/process.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verenne-action-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function git(args, cwd) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result;
}

function verification(status = 'READY') {
  const candidate = {
    id: 'working-tree',
    label: 'Pull request',
    score: 87,
    eligibilityStatus: status === 'READY' ? 'ELIGIBLE' : 'BLOCKED',
    claimCounts: { proven: 1, contradicted: 1, unproven: 0 },
    claims: [
      { id: 'claim-pass', kind: 'tests_passed', text: 'Tests pass', verdict: 'PROVEN', reason: 'Replay passed.' },
      { id: 'claim-fail', kind: 'docs_updated', text: 'Docs updated', verdict: 'CONTRADICTED', reason: 'No documentation diff.', required: true, path: 'README.md', line: 7 },
    ],
    gates: [
      { id: 'test', label: 'Tests', status: 'PASS', required: true },
      { id: 'lint', label: 'Lint', status: 'FAIL', required: true, reason: 'Lint errors remain.' },
    ],
    trustViolations: [{ id: 'runner-weakened', severity: 'critical', message: 'Test runner changed.', path: 'package.json' }],
    evidence: [],
    stats: { additions: 2, deletions: 1 },
  };
  return {
    mission: { id: 'verify-fixture', task: 'Verify fixture', title: 'Verify fixture', mode: 'verify', baseSha: 'a'.repeat(40), startedAt: '2026-01-01T00:00:00.000Z', tasks: [] },
    candidate,
    decision: {
      status,
      selectedCandidateId: status === 'READY' ? candidate.id : null,
      reasons: [status === 'READY' ? 'Evidence passed.' : 'Evidence blocked the patch.'],
      ranked: [candidate],
    },
  };
}

test('SARIF uses engine statuses and reason fields, defines rules, and drops unsafe paths', () => {
  const candidate = verification().candidate;
  candidate.claims.push({
    id: 'unsafe', kind: 'security_fixed', text: 'Unsafe path finding', verdict: 'CONTRADICTED',
    reason: 'No proof.', path: path.resolve(os.tmpdir(), 'secret.txt'),
  });
  const sarif = createSarif(candidate);
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, APP_NAME);
  assert.equal(run.tool.driver.semanticVersion, VERSION);
  assert.equal(run.results.length, 4, 'claim, unsafe claim, failed gate, and trust violation should be reported');
  assert.ok(run.tool.driver.rules.length >= 3);
  assert.match(run.results[0].message.text, /No documentation diff/);
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'README.md');
  assert.equal(run.results.find((result) => /Unsafe path/.test(result.message.text)).locations, undefined);
  assert.ok(run.results.some((result) => result.ruleId === 'gate-lint' && result.level === 'error'));
});

test('step summary counts PASS gates rather than the obsolete PASSED value', () => {
  const candidate = verification().candidate;
  const summary = buildStepSummary({
    verdict: 'BLOCKED',
    candidate,
    artifacts: { html: 'case.html', sarif: 'results.sarif' },
  });
  assert.match(summary, /1\/2 passed/);
  assert.match(summary, /No documentation diff/);
  assert.doesNotMatch(summary, /undefined/);
});

test('action writes a report bundle, SARIF, output contract, and GitHub summary', async (t) => {
  const root = await temporaryDirectory(t);
  const outputFile = path.join(root, 'github-output.txt');
  const summaryFile = path.join(root, 'github-summary.md');
  const eventFile = path.join(root, 'event.json');
  await writeFile(eventFile, JSON.stringify({ pull_request: { base: { sha: 'b'.repeat(40) }, body: '- Tests pass' } }), 'utf8');
  let observed;
  const stdout = { chunks: [], write(value) { this.chunks.push(value); } };
  const result = await runAction({
    env: {
      GITHUB_WORKSPACE: root,
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      INPUT_CLAIMS: 'pr-body',
      INPUT_OUTPUT: 'artifacts',
    },
    stdout,
    verify: async (options) => {
      observed = options;
      return verification('READY');
    },
  });

  assert.equal(result.verdict, 'VERIFIED');
  assert.equal(result.exitCode, 0);
  assert.equal(observed.base, 'b'.repeat(40));
  assert.equal(observed.claims[0].text, 'Tests pass');
  assert.equal(observed.claims[0].required, true);
  await readFile(result.artifacts.html, 'utf8');
  await readFile(result.artifacts.json, 'utf8');
  await readFile(result.artifacts.svg, 'utf8');
  const sarif = JSON.parse(await readFile(result.artifacts.sarif, 'utf8'));
  assert.equal(sarif.version, '2.1.0');

  const outputs = await readFile(outputFile, 'utf8');
  assert.match(outputs, /^verdict=VERIFIED$/m);
  assert.match(outputs, /^report-path=.*case\.html$/m);
  assert.match(outputs, /^sarif-path=.*results\.sarif$/m);
  assert.match(outputs, /^report-json-path=.*case\.json$/m);
  assert.match(outputs, /^share-card-path=.*verdict\.svg$/m);
  const summary = await readFile(summaryFile, 'utf8');
  assert.match(summary, new RegExp(`${APP_NAME} verdict: VERIFIED`));
  assert.match(summary, /1\/2 passed/);
  assert.ok(stdout.chunks.join('').includes('::error title=Contradicted agent claim::'));
});

test('a no-winner decision returns the documented blocked exit status', async (t) => {
  const root = await temporaryDirectory(t);
  const result = await runAction({
    env: { GITHUB_WORKSPACE: root, INPUT_OUTPUT: 'artifacts' },
    stdout: { write() {} },
    verify: async () => verification('NO_WINNER'),
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.exitCode, 2);
});

test('initial-push all-zero base resolves to the repository default branch', async (t) => {
  const root = await temporaryDirectory(t);
  const eventFile = path.join(root, 'push-event.json');
  await writeFile(eventFile, JSON.stringify({ before: '0'.repeat(40), repository: { default_branch: 'trunk' } }), 'utf8');
  let observedBase;
  await runAction({
    env: { GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: eventFile, INPUT_OUTPUT: 'artifacts' },
    stdout: { write() {} },
    verify: async (options) => {
      observedBase = options.base;
      return verification('READY');
    },
  });
  assert.equal(observedBase, 'origin/trunk');
});

test('action metadata declares every emitted artifact output and the packaged entrypoint', async () => {
  const metadata = await readFile(path.join(projectRoot, 'action.yml'), 'utf8');
  for (const output of ['verdict', 'proven', 'contradicted', 'unproven', 'report-path', 'sarif-path', 'report-json-path', 'share-card-path']) {
    assert.match(metadata, new RegExp(`^  ${output}:`, 'm'));
  }
  assert.match(metadata, /^  using: node24$/m);
  assert.match(metadata, /^  main: src\/action\.js$/m);
});

test('real Action verification links raw policy ids to suite-qualified replay evidence', async (t) => {
  const root = await temporaryDirectory(t);
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'test'), { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), '.verenne/\n', 'utf8');
  await writeFile(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'action-fixture', private: true, type: 'module' })}\n`, 'utf8');
  await writeFile(path.join(repo, 'src', 'value.js'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(repo, 'test', 'value.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.js';",
    "test('value is positive', () => assert.ok(value > 0));",
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'verenne.policy.json'), `${JSON.stringify({
    schemaVersion: 1,
    bootstrap: false,
    gates: [{ id: 'test', label: 'Tests', command: [process.execPath, '--test'], required: true, claimKinds: ['tests_passed'] }],
  }, null, 2)}\n`, 'utf8');
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Action Test'], repo);
  await git(['config', 'user.email', 'action@verenne.invalid'], repo);
  await git(['config', 'core.autocrlf', 'false'], repo);
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'base'], repo);
  const baseSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
  await writeFile(path.join(repo, 'src', 'value.js'), 'export const value = 2;\n', 'utf8');

  const eventFile = path.join(root, 'event-real.json');
  await writeFile(eventFile, JSON.stringify({
    pull_request: { base: { sha: baseSha }, body: '- Tests pass' },
    repository: { default_branch: 'main' },
  }), 'utf8');
  const result = await runAction({
    env: {
      GITHUB_WORKSPACE: repo,
      GITHUB_EVENT_PATH: eventFile,
      INPUT_CLAIMS: 'pr-body',
      INPUT_TASK: 'Tests pass',
      INPUT_OUTPUT: '.verenne/action-report',
    },
    stdout: { write() {} },
  });
  assert.equal(result.verdict, 'VERIFIED');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.mission.candidates[0].intentCoverage.requiredUnevidenced, []);
  assert.ok(result.mission.candidates[0].gates.some((gate) => gate.id === 'gate:test:candidate' && gate.status === 'PASS'));
});
