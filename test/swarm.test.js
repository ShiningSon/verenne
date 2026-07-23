import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { applyMissionWinner, runMission } from '../src/mission.js';
import { runProcess } from '../src/process.js';
import { CONFIG_FILE, POLICY_FILE, STATE_DIR } from '../src/config.js';

async function command(executable, args, cwd, allowFailure = false) {
  const result = await runProcess(executable, args, { cwd, timeoutMs: 60_000, maxOutputBytes: 4_000_000 });
  if (!allowFailure) assert.equal(result.code, 0, result.stderr || result.error || `${executable} ${args.join(' ')} failed`);
  return result;
}

async function git(args, cwd, allowFailure = false) {
  return await command('git', args, cwd, allowFailure);
}

async function cleanupWorktrees(repo) {
  const listed = await git(['worktree', 'list', '--porcelain'], repo, true);
  if (listed.code !== 0) return;
  const worktrees = listed.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const worktree of worktrees.reverse()) {
    if (path.resolve(worktree) === path.resolve(repo)) continue;
    await git(['worktree', 'remove', '--force', worktree], repo, true);
  }
  await git(['worktree', 'prune'], repo, true);
}

function fakeAgentSource() {
  return String.raw`
import fs from 'node:fs';
import path from 'node:path';

const lane = process.env.VERENNE_LANE_ID || '';
const root = process.cwd();
const source = path.join(root, 'src');
let changedPath = '';
fs.mkdirSync(source, { recursive: true });
const need = (file) => {
  if (!fs.existsSync(path.join(source, file))) {
    console.error('Missing verified dependency: ' + file);
    process.exit(41);
  }
};

if (lane.includes('bad-root')) {
  fs.writeFileSync(path.join(root, '.env'), 'LEAK=blocked\n');
} else if (lane.includes('foundation')) {
  changedPath = 'src/foundation.js';
  fs.writeFileSync(path.join(source, 'foundation.js'), 'export const foundation = "verified";\n');
} else if (lane.includes('left')) {
  changedPath = 'src/left.js';
  need('foundation.js');
  fs.writeFileSync(path.join(source, 'left.js'), 'export const left = "left";\n');
} else if (lane.includes('right')) {
  changedPath = 'src/right.js';
  need('foundation.js');
  fs.writeFileSync(path.join(source, 'right.js'), 'export const right = "right";\n');
} else if (lane.includes('finish')) {
  changedPath = 'src/finish.js';
  need('foundation.js');
  need('left.js');
  need('right.js');
  fs.writeFileSync(path.join(source, 'finish.js'), [
    'export { foundation } from "./foundation.js";',
    'export { left } from "./left.js";',
    'export { right } from "./right.js";',
    '',
  ].join('\n'));
} else if (lane.includes('child')) {
  fs.writeFileSync(path.join(root, 'child-should-not-run.txt'), 'unsafe downstream execution\n');
} else {
  console.error('Unknown fake lane: ' + lane);
  process.exit(42);
}

fs.writeFileSync(path.join(root, '.verenne-result.json'), JSON.stringify({
  summary: 'Implemented ' + lane,
  claims: [{ id: 'node-feature', kind: 'feature_implemented', text: 'Implemented the assigned swarm node.', required: true }],
  requirements: [{ id: 'R01', status: 'completed', paths: [changedPath], gates: ['test'], claims: ['node-feature'] }],
  tests: [],
  visualEvidence: [],
  openRisks: [],
}, null, 2));
console.log('completed ' + lane);
`;
}

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'verenne-swarm-test-'));
  const repo = path.join(root, 'repository with spaces');
  const fakeAgent = path.join(root, 'fake-agent.mjs');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'test'), { recursive: true });
  await writeFile(fakeAgent, fakeAgentSource(), 'utf8');
  await writeFile(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'swarm-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(repo, 'src', 'base.js'), 'export const base = true;\n', 'utf8');
  await writeFile(path.join(repo, 'test', 'base.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { base } from '../src/base.js';",
    "test('base remains valid', () => assert.equal(base, true));",
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, CONFIG_FILE), `${JSON.stringify({
    schemaVersion: 1,
    defaultAgents: ['fake'],
    concurrency: 2,
    adapters: {
      fake: {
        label: 'Deterministic test agent',
        command: process.execPath,
        args: [fakeAgent],
        stdin: 'prompt',
        result: 'stdout',
        timeoutMs: 30_000,
      },
    },
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(repo, POLICY_FILE), `${JSON.stringify({
    schemaVersion: 1,
    protectedInputs: [POLICY_FILE],
    forbiddenPatterns: ['.env'],
    gates: [{ id: 'test', label: 'Tests', command: [process.execPath, '--test'], required: true, claimKinds: ['feature_implemented'], timeoutMs: 30_000 }],
    rules: { strictRequiredClaims: true },
  }, null, 2)}\n`, 'utf8');

  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Verenne Test'], repo);
  await git(['config', 'user.email', 'test@verenne.local'], repo);
  await git(['add', '--all'], repo);
  await git(['commit', '--no-gpg-sign', '-m', 'fixture'], repo);

  t.after(async () => {
    await cleanupWorktrees(repo);
    await rm(root, { recursive: true, force: true });
  });
  return repo;
}

async function eventLog(repo, missionId) {
  const raw = await readFile(path.join(repo, STATE_DIR, 'missions', missionId, 'events.ndjson'), 'utf8');
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('swarm composes sealed dependency contributions and exposes one apply-ready integrated winner', async (t) => {
  const repo = await createRepository(t);
  const tasks = [
    { id: 'foundation', title: 'Foundation', task: 'Add the shared foundation.', dependsOn: [], agent: 'fake' },
    { id: 'left', title: 'Left branch', task: 'Build the left branch.', dependsOn: ['foundation'], agent: 'fake' },
    { id: 'right', title: 'Right branch', task: 'Build the right branch.', dependsOn: ['foundation'], agent: 'fake' },
    { id: 'finish', title: 'Finish', task: 'Join both branches.', dependsOn: ['left', 'right'], agent: 'fake' },
  ];
  const { mission } = await runMission({
    repoRoot: repo,
    task: 'Build a verified four-node feature.',
    mode: 'swarm',
    agents: ['fake'],
    tasks,
  });

  assert.equal(mission.status, 'ready');
  assert.equal(mission.decision.status, 'READY');
  assert.equal(mission.swarm.status, 'READY');
  assert.deepEqual(mission.swarm.topology, ['foundation', 'left', 'right', 'finish']);
  assert.ok(mission.swarm.tasks.every((item) => item.status === 'ELIGIBLE'));
  const winner = mission.candidates.find((candidate) => candidate.id === mission.decision.selectedCandidateId);
  assert.ok(winner, 'the mission must select the final integrated candidate');
  assert.equal(winner.id, 'swarm-integrated');
  assert.equal(winner.role, 'swarm-integration');
  assert.equal(winner.eligibilityStatus, 'ELIGIBLE');
  assert.equal(winner.sourceCandidateIds.length, tasks.length);
  assert.ok(winner.patchFile);

  const finish = mission.candidates.find((candidate) => candidate.taskId === 'finish');
  assert.deepEqual(finish.contribution.inheritedTaskIds, ['foundation', 'left', 'right']);
  assert.equal(finish.integration.applied.length, 3);

  const events = await eventLog(repo, mission.id);
  assert.ok(events.some((event) => event.type === 'swarm.integration.patch.applied' && event.taskId === 'finish'));
  assert.ok(events.some((event) => event.type === 'swarm.final.integration.completed'));
  assert.ok(events.some((event) => event.type === 'swarm.final.verification.completed'));

  const applied = await applyMissionWinner({ repoRoot: repo, missionId: mission.id });
  assert.equal(applied.candidateId, winner.id);
  for (const file of ['foundation.js', 'left.js', 'right.js', 'finish.js']) {
    assert.match(await readFile(path.join(repo, 'src', file), 'utf8'), /export/);
  }
});

test('swarm never launches a dependent node when an upstream contribution is ineligible', async (t) => {
  const repo = await createRepository(t);
  const { mission } = await runMission({
    repoRoot: repo,
    task: 'Reject unsafe upstream work before downstream execution.',
    mode: 'swarm',
    agents: ['fake'],
    tasks: [
      { id: 'bad-root', title: 'Unsafe root', task: 'Make an unsafe change.', dependsOn: [], agent: 'fake' },
      { id: 'child', title: 'Must not run', task: 'Consume the unsafe change.', dependsOn: ['bad-root'], agent: 'fake' },
    ],
  });

  assert.equal(mission.status, 'blocked');
  assert.equal(mission.decision.status, 'NO_WINNER');
  assert.equal(mission.decision.selectedCandidateId, null);
  assert.equal(mission.swarm.status, 'BLOCKED');
  assert.equal(mission.swarm.tasks.find((item) => item.taskId === 'bad-root').status, 'BLOCKED_VERIFICATION');
  assert.equal(mission.swarm.tasks.find((item) => item.taskId === 'child').status, 'BLOCKED_DEPENDENCY');
  assert.equal(mission.candidates.some((candidate) => candidate.taskId === 'child'), false);

  const events = await eventLog(repo, mission.id);
  assert.equal(events.some((event) => event.type === 'agent.started' && event.taskId === 'child'), false);
  assert.ok(events.some((event) => event.type === 'swarm.node.blocked' && event.taskId === 'child'));
  await assert.rejects(
    applyMissionWinner({ repoRoot: repo, missionId: mission.id }),
    /no evidence-approved winner/i,
  );
});
