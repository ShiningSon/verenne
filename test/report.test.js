import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { APP_NAME } from '../src/utils.js';
import { createReport, createReportBundle, createShareCard, redactForShare } from '../src/report.js';
import { createReportServer, startReportServer } from '../src/server.js';

function fixture() {
  return {
    id: 'mission-demo-01',
    title: 'Add per-user rate limiting without changing authentication',
    status: 'completed',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    startedAt: '2026-07-23T01:00:00.000Z',
    endedAt: '2026-07-23T01:10:18.000Z',
    repoRoot: 'C:\\Users\\demo\\secret-repository',
    token: 'ghp_supersecretcredential123456789',
    tasks: [
      { id: 'T1', title: 'Threat model', status: 'completed' },
      { id: 'T2A', title: 'Candidate A implementation', status: 'completed', dependsOn: ['T1'] },
      { id: 'T2B', title: 'Candidate B implementation', status: 'completed', dependsOn: ['T1'] },
      { id: 'T3', title: 'Independent verification', status: 'running', dependsOn: ['T2A', 'T2B'] },
    ],
    agents: [
      { id: 'planner', label: 'Atlas', status: 'completed', cost: 0.5, durationMs: 90_000 },
      { id: 'builder', label: 'Forge', status: 'running', cost: 1.2, durationMs: 330_000 },
      { id: 'verifier', label: 'Sentry', status: 'active', cost: 1.04, durationMs: 198_000 },
    ],
    events: [
      { id: 'E1', agentId: 'planner', taskId: 'T1', type: 'plan', summary: 'Mapped required behavior', observedAt: '2026-07-23T01:00:20.000Z' },
      { id: 'E2', agentId: 'builder', taskId: 'T2B', type: 'edit', summary: 'Implemented candidate B', observedAt: '2026-07-23T01:03:20.000Z' },
      { id: 'E3', agentId: 'builder', taskId: 'T3', type: 'handoff', summary: 'Relayed immutable context packet', observedAt: '2026-07-23T01:06:20.000Z' },
      { id: 'E4', agentId: 'verifier', taskId: 'T3', type: 'verify', summary: 'Replayed trusted test gate', observedAt: '2026-07-23T01:08:20.000Z' },
    ],
    worktrees: [
      { id: 'WT-A', label: 'candidate/a', status: 'clean', headSha: 'aaaaaaaaaa', additions: 142, deletions: 18 },
      { id: 'WT-B', label: 'candidate/b', status: 'clean', headSha: 'bbbbbbbbbb', additions: 121, deletions: 11 },
    ],
    candidates: [
      { id: 'A', label: 'Fast patch', eligibility: 'blocked', additions: 142, deletions: 18, filesChanged: 9, passedGates: 3, failedGates: 1, cost: 1.9, durationMs: 420_000, disqualifications: ['protected test command changed'] },
      { id: 'B', label: 'Verified patch', eligibility: 'eligible', headSha: 'bbbbbbbbbbbbbbbb', additions: 121, deletions: 11, filesChanged: 7, passedGates: 5, failedGates: 0, cost: { value: 2.74, kind: 'exact' }, durationMs: 618_000 },
    ],
    claims: [
      { id: 'C1', candidateId: 'A', rawText: 'All tests pass', verdict: 'contradicted', rationale: 'The test command was narrowed.', counterEvidenceIds: ['EV1'], remedy: 'Restore and replay the base-owned command.' },
      { id: 'C2', candidateId: 'B', rawText: 'The limiter preserves authentication behavior', verdict: 'proven', rationale: 'Independent regression gates passed.', evidenceIds: ['EV2'] },
      { id: 'C3', candidateId: 'B', rawText: 'Documentation is complete', verdict: 'unproven', rationale: 'No documentation gate was supplied.' },
    ],
    evidence: [
      { id: 'EV1', kind: 'diff', summary: 'package test script changed from full suite to one test' },
      { id: 'EV2', kind: 'gate', summary: 'base-owned authentication regression suite passed' },
    ],
    decision: {
      selectedCandidateId: 'B',
      comparisonReasons: ['B was the only eligible candidate without a trust violation.'],
    },
    receipt: { signatureStatus: 'verified', digest: 'abc123' },
  };
}

test('creates a terminal-first, accessible single-file mission dashboard', () => {
  const html = createReport(fixture());
  assert.match(html, /<!doctype html>/i);
  assert.match(html, new RegExp(APP_NAME));
  assert.match(html, /class="session-shell"/);
  assert.match(html, /class="execution-stream"/);
  assert.match(html, /id="task-composer"/);
  assert.match(html, /Sessions and mission DAG/);
  assert.match(html, /Agent and evidence context/);
  assert.match(html, /id="arena-drawer"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /aurora-border/);
  assert.match(html, /id="context-tab-lanes" role="tab" tabindex="0"/);
  assert.match(html, /id="context-tab-diff" role="tab" tabindex="-1"/);
  assert.match(html, /event\.key === 'ArrowRight'/);
  assert.match(html, /function isolateBackground\(container\)/);
  assert.match(html, /modalState && event\.key === 'Tab'/);
  assert.match(html, /@media\(max-width:920px\)/);
  assert.match(html, /grid-template-columns:minmax\(180px,205px\) minmax\(0,1fr\)/);
  assert.doesNotMatch(html, /<script\s+src=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*href=/i);
  const executableScripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\btype=["'](?:application\/json|image\/svg\+xml)["']/i.test(match[1]))
    .map((match) => match[2]);
  assert.ok(executableScripts.length > 0);
  for (const source of executableScripts) assert.doesNotThrow(() => new Script(source));
});

test('renders candidate comparison, claim filters, DAG, lanes and evidence inspector hooks', () => {
  const html = createReport(fixture());
  assert.match(html, /Verified patch earned merge/);
  assert.match(html, /Evidence-based candidate comparison/);
  assert.match(html, /data-claim-filter="contradicted"/);
  assert.match(html, /data-claim-verdict="proven"/);
  assert.match(html, /data-inspect="claim:C1"/);
  assert.match(html, /data-context-panel="lanes"/);
  assert.match(html, /data-context-panel="diff"/);
  assert.match(html, /data-context-panel="proof"/);
  assert.match(html, /Ctrl\+Enter to dispatch|SNAPSHOT/);
});

test('share-safe mode removes secrets and local paths before embedding data', () => {
  const input = fixture();
  input.events.push({ id: 'E5', agentId: 'builder', type: 'command', summary: 'Used Bearer abcdefghijklmnopqrstuvwxyz', command: 'tool --token sk-abcdefghijklmnopqrstuvwxyz C:\\Users\\demo\\private\\file.js' });
  input.title = 'Safe title </script><script>alert(1)</script>';
  const html = createReport(input);
  assert.doesNotMatch(html, /ghp_supersecretcredential/);
  assert.doesNotMatch(html, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(html, /C:\\Users\\demo/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\[redacted\]|\[secret\]|\[local-path\]/);
  assert.match(html, /\\u003c\/script\\u003e/);
});

test('redaction preserves shared structures without emitting false circular markers', () => {
  const shared = { id: 'same', summary: 'safe' };
  const result = redactForShare({ left: shared, right: shared });
  assert.deepEqual(result.left, result.right);
  assert.notEqual(result.right, '[circular]');
  const cyclic = { id: 'cycle' };
  cyclic.self = cyclic;
  assert.equal(redactForShare(cyclic).self, '[circular]');
});

test('share serialization omits private transport fields while preserving safe task text', () => {
  const safeTask = 'Add account lockout and keep the existing public API behavior';
  const redacted = redactForShare({
    task: safeTask,
    csrfToken: 'csrf-private-nonce',
    promptPath: 'C:\\Users\\demo\\prompt.md',
    apiKey: 'key-private-value',
    credentials: { password: 'hunter2' },
    notes: 'Compared /opt/private/repo/file.js, C:\\workspace\\secret.js, file:///tmp/private.js and \\\\server\\share\\private.txt',
  });
  assert.equal(redacted.task, safeTask);
  assert.equal(Object.hasOwn(redacted, 'csrfToken'), false);
  assert.equal(Object.hasOwn(redacted, 'promptPath'), false);
  assert.equal(redacted.apiKey, '[redacted]');
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /csrf-private-nonce|key-private-value|hunter2|prompt\.md|private\.txt|private\.js|C:\\\\workspace|\/opt\/private/);
  assert.match(serialized, /\[local-path\]/);
  const redactedTask = redactForShare({ task: 'Rotate AWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRSTUV and rerun tests' });
  assert.match(redactedTask.task, /Rotate AWS_SECRET_ACCESS_KEY=\[secret\] and rerun tests/);
  assert.doesNotMatch(redactedTask.task, /ABCDEFGHIJKLMNOPQRSTUV/);

  const html = createReport({ ...fixture(), csrfToken: 'input-csrf-secret', promptPath: '/tmp/private-prompt.md' }, {
    live: true,
    csrfToken: 'option-csrf-secret',
  });
  assert.doesNotMatch(html, /input-csrf-secret|option-csrf-secret|private-prompt|"csrfToken"|"promptPath"/);
});

test('keeps repeated claim and evidence IDs scoped to their candidates and infers dashboard context', () => {
  const input = {
    id: 'scoped-records',
    title: 'Implement the requested behavior',
    status: 'completed',
    candidates: [
      {
        id: 'A', label: 'Candidate A', taskId: 'implementation', stats: { additions: 12, deletions: 3, changedPaths: ['src/a.js', 'test/a.test.js'] },
        claims: [{ id: 'claim-1', text: 'Candidate A behavior', verdict: 'PROVEN', evidenceIds: ['gate-1'] }],
        evidence: [{ id: 'gate-1', kind: 'gate', summary: 'Candidate A replay passed' }],
      },
      {
        id: 'B', label: 'Candidate B', taskId: 'implementation', winner: true, stats: { additions: 20, deletions: 4, filesChanged: 3 },
        claims: [{ id: 'claim-1', text: 'Candidate B behavior', verdict: 'PROVEN', evidenceIds: ['gate-1'] }],
        evidence: [{ id: 'gate-1', kind: 'gate', summary: 'Candidate B replay passed' }],
      },
    ],
    decision: { selectedCandidateId: 'B' },
  };
  const bundle = createReportBundle(input);
  assert.deepEqual(bundle.data.claims.map((claim) => claim.id), ['A:claim-1', 'B:claim-1']);
  assert.deepEqual(bundle.data.evidence.map((item) => item.id), ['A:gate-1', 'B:gate-1']);
  assert.deepEqual(bundle.data.claims.map((claim) => claim.candidateId), ['A', 'B']);
  assert.deepEqual(bundle.data.claims.map((claim) => claim.evidenceIds[0]), ['A:gate-1', 'B:gate-1']);
  assert.equal(bundle.data.worktrees.length, 2);
  assert.deepEqual(bundle.data.worktrees.map((worktree) => worktree.label), ['Candidate A', 'Candidate B']);
  assert.equal(bundle.data.tasks.length, 1);
  assert.equal(bundle.data.tasks[0].status, 'verified');
  assert.match(bundle.html, /Candidate A behavior/);
  assert.match(bundle.html, /Candidate B behavior/);
  assert.match(bundle.html, /2 files/);
  assert.match(bundle.html, /3 files/);
  assert.match(bundle.html, /\+12/);
  assert.match(bundle.html, /-4/);
});

test('creates an accessible 1200x630 share card and a complete bundle', () => {
  const svg = createShareCard(fixture());
  assert.match(svg, /width="1200" height="630" viewBox="0 0 1200 630"/);
  assert.match(svg, /role="img" aria-labelledby="card-title card-desc"/);
  assert.match(svg, /<title id="card-title">/);
  assert.match(svg, /Verified patch earned merge/);
  assert.match(svg, /AGENTS RACE\. EVIDENCE DECIDES\./);
  assert.doesNotMatch(svg, /secret-repository|ghp_supersecret/);
  const bundle = createReportBundle(fixture());
  assert.match(bundle.html, /session-shell/);
  assert.match(bundle.svg, /<svg/);
  assert.equal(bundle.data.decision.winnerId, 'B');
  assert.equal(bundle.data.agents.length, 3);
});

test('serves live HTML, redacted state, SVG, command composer and health over loopback', async (context) => {
  const commands = [];
  const controller = await startReportServer({
    data: fixture(),
    onCommand: async (entry) => { commands.push(entry.command); return { missionId: 'mission-demo-01' }; },
  });
  context.after(() => controller.close());
  assert.match(controller.url, /^http:\/\/127\.0\.0\.1:/);

  const page = await fetch(`${controller.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const csrfCookie = page.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(csrfCookie ?? '', /^verenne_csrf=/);
  const html = await page.text();
  assert.match(html, /LIVE · Ctrl\+Enter to dispatch/);
  assert.doesNotMatch(html, /secret-repository|ghp_supersecret/);
  assert.doesNotMatch(html, /"csrfToken"|x-verenne-token/);

  const state = await (await fetch(`${controller.url}/api/state`)).json();
  assert.equal(state.revision, 0);
  assert.equal(state.data.id, 'mission-demo-01');
  assert.equal(state.data.token, '[secret]');

  const card = await fetch(`${controller.url}/share.svg`);
  assert.equal(card.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await card.text(), /width="1200" height="630"/);

  const command = await fetch(`${controller.url}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: csrfCookie },
    body: JSON.stringify({ command: 'Run the security verifier' }),
  });
  assert.equal(command.status, 202);
  assert.deepEqual(commands, ['Run the security verifier']);
  assert.equal(controller.revision, 1);
  controller.publish(fixture(), { reason: 'test' });
  assert.equal(controller.revision, 2);
  const health = await (await fetch(`${controller.url}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.revision, 2);
});

test('server refuses accidental non-loopback exposure', () => {
  assert.throws(() => createReportServer({ host: '0.0.0.0', data: fixture() }), /Refusing to expose/);
});
