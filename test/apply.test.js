import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { capturePatch } from '../src/git.js';
import { applyMissionWinner } from '../src/mission.js';
import { createMissionState, missionDir, saveMission } from '../src/state.js';
import { sha256 } from '../src/utils.js';

const execFileAsync = promisify(execFile);

async function git(repo, args) {
  return await execFileAsync('git', args, { cwd: repo, windowsHide: true });
}

async function repository(t) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'verenne-apply-'));
  t.after(async () => { await rm(repo, { recursive: true, force: true }); });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Verenne Apply Test']);
  await git(repo, ['config', 'user.email', 'apply@verenne.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, '.gitignore'), '.verenne/\nignored-output.txt\n', 'utf8');
  await writeFile(path.join(repo, 'README.md'), '# Fixture\n', 'utf8');
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', 'base']);
  const { stdout } = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, baseSha: stdout.trim() };
}

async function installMission(repo, baseSha, patch, changedFiles) {
  const mission = await createMissionState(repo, {
    id: 'apply-fixture',
    title: 'Apply fixture',
    task: 'Apply an ignored but explicitly sealed artifact.',
    mode: 'arena',
    baseRef: 'HEAD',
    baseSha,
  });
  const patchFile = path.join('lanes', 'winner', 'candidate.patch');
  const absolutePatch = path.join(missionDir(repo, mission.id), patchFile);
  await mkdir(path.dirname(absolutePatch), { recursive: true });
  await writeFile(absolutePatch, patch, 'utf8');
  mission.status = 'ready';
  mission.candidates = [{
    id: 'winner',
    label: 'Winner',
    patchFile,
    diffDigest: sha256(patch),
    changedFiles,
  }];
  mission.decision = { status: 'READY', selectedCandidateId: 'winner' };
  await saveMission(repo, mission);
  return mission;
}

test('commit apply preserves the exact seal for an explicitly force-tracked ignored addition', async (t) => {
  const { repo, baseSha } = await repository(t);
  const outputPath = path.join(repo, 'ignored-output.txt');
  await writeFile(outputPath, 'sealed generated output\n', 'utf8');
  await git(repo, ['add', '-f', '-N', '--', 'ignored-output.txt']);
  const patch = await capturePatch(repo, baseSha);
  assert.match(patch, /sealed generated output/);
  await git(repo, ['reset', '--', 'ignored-output.txt']);
  await unlink(outputPath);

  const mission = await installMission(repo, baseSha, patch, [{ status: 'A', path: 'ignored-output.txt' }]);
  const applied = await applyMissionWinner({ repoRoot: repo, missionId: mission.id, commit: true });
  assert.match(applied.commitSha, /^[a-f0-9]{40}$/);
  assert.equal((await git(repo, ['show', 'HEAD:ignored-output.txt'])).stdout, 'sealed generated output\n');
  assert.equal((await git(repo, ['status', '--porcelain'])).stdout.trim(), '');
  assert.equal(await readFile(outputPath, 'utf8'), 'sealed generated output\n');
});
