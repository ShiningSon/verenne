import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { loadMission } from '../src/state.js';
import { runMission, verifyCurrentPatch } from '../src/mission.js';
import { createAbortError, runProcess } from '../src/process.js';
import { runBootstrapSteps } from '../src/bootstrap.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verenne-cancel-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function git(args, cwd) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result;
}

async function waitForFile(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processAlive(pid), false, `process ${pid} survived cancellation`);
}

async function initializeRepo(repo, files = {}) {
  await mkdir(repo, { recursive: true });
  for (const [relativePath, contents] of Object.entries({ 'README.md': '# cancellation fixture\n', ...files })) {
    const filePath = path.join(repo, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Cancellation Test'], repo);
  await git(['config', 'user.email', 'cancellation@example.invalid'], repo);
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'fixture'], repo);
}

test('process runner honors pre-abort without spawning and kills an active process tree', async (t) => {
  const preCancelled = new AbortController();
  preCancelled.abort(createAbortError('cancel before launch'));
  const skipped = await runProcess('this-command-must-not-be-resolved', [], { signal: preCancelled.signal });
  assert.equal(skipped.aborted, true);
  assert.equal(skipped.code, null);
  assert.match(skipped.error, /cancel before launch/i);

  const directory = await temporaryDirectory(t);
  const marker = path.join(directory, 'pids.json');
  const childProgram = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, nested: nested.pid }));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', childProgram, marker], {
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  await waitForFile(marker);
  const pids = JSON.parse(await readFile(marker, 'utf8'));
  controller.abort(createAbortError('operator cancelled'));
  const result = await running;

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /operator cancelled/i);
  await Promise.all([waitForProcessExit(pids.parent), waitForProcessExit(pids.nested)]);
});

test('mission cancellation reaches the provider, persists a cancelled state, and leaves no provider process', async (t) => {
  const directory = await temporaryDirectory(t);
  const repo = path.join(directory, 'repo');
  const markers = [path.join(directory, 'provider-a.json'), path.join(directory, 'provider-b.json')];
  const providerProgram = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const config = {
    defaultAgents: ['hanger-a', 'hanger-b'],
    concurrency: 2,
    adapters: {
      'hanger-a': {
        label: 'Cancellation fixture A',
        command: process.execPath,
        args: ['-e', providerProgram, markers[0]],
        stdin: 'prompt',
        timeoutMs: 30_000,
      },
      'hanger-b': {
        label: 'Cancellation fixture B',
        command: process.execPath,
        args: ['-e', providerProgram, markers[1]],
        stdin: 'prompt',
        timeoutMs: 30_000,
      },
    },
  };
  await initializeRepo(repo, {
    'verenne.config.json': `${JSON.stringify(config, null, 2)}\n`,
    'verenne.policy.json': `${JSON.stringify({ schemaVersion: 1, bootstrap: false, gates: [] }, null, 2)}\n`,
  });

  const controller = new AbortController();
  const missionPromise = runMission({
    id: 'cancelled-mission',
    repoRoot: repo,
    task: 'Wait until the operator cancels this fixture.',
    agents: ['hanger-a', 'hanger-b'],
    signal: controller.signal,
  });
  await Promise.all(markers.map((marker) => waitForFile(marker)));
  const pids = await Promise.all(markers.map(async (marker) => JSON.parse(await readFile(marker, 'utf8')).pid));
  controller.abort(createAbortError('cancel mission test'));
  await assert.rejects(missionPromise, (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');

  const mission = await loadMission(repo, 'cancelled-mission');
  assert.equal(mission.status, 'cancelled');
  assert.equal(mission.error.code, 'ABORT_ERR');
  assert.match(mission.error.message, /cancel mission test/i);
  await Promise.all(pids.map((pid) => waitForProcessExit(pid)));
});

test('bootstrap cancellation rejects immediately after terminating the active installer process', async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = path.join(directory, 'bootstrap.json');
  const installerProgram = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const controller = new AbortController();
  const bootstrap = runBootstrapSteps([{
    id: 'fixture-install',
    command: [process.execPath, '-e', installerProgram, marker],
    timeoutMs: 30_000,
  }], directory, { signal: controller.signal });
  await waitForFile(marker);
  const { pid } = JSON.parse(await readFile(marker, 'utf8'));
  controller.abort(createAbortError('cancel bootstrap test'));
  await assert.rejects(bootstrap, (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  await waitForProcessExit(pid);
});

test('verification gate cancellation is propagated instead of being converted into a failed gate', async (t) => {
  const directory = await temporaryDirectory(t);
  const repo = path.join(directory, 'repo');
  const marker = path.join(directory, 'gate.json');
  const gateProgram = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));",
    'setInterval(() => {}, 1000);',
  ].join('');
  const policy = {
    schemaVersion: 1,
    bootstrap: false,
    gates: [{
      id: 'hanging-tests',
      label: 'Hanging tests',
      command: [process.execPath, '-e', gateProgram, marker],
      claimKinds: ['tests_passed'],
      required: true,
      timeoutMs: 30_000,
    }],
  };
  await initializeRepo(repo, {
    'verenne.policy.json': `${JSON.stringify(policy, null, 2)}\n`,
  });
  await writeFile(path.join(repo, 'change.txt'), 'candidate change\n', 'utf8');

  const controller = new AbortController();
  const verification = verifyCurrentPatch({ repoRoot: repo, task: 'Tests pass.', signal: controller.signal });
  await waitForFile(marker);
  const { pid } = JSON.parse(await readFile(marker, 'utf8'));
  controller.abort(createAbortError('cancel verification test'));
  await assert.rejects(verification, (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  await waitForProcessExit(pid);
});
