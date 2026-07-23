import path from 'node:path';
import os from 'node:os';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { runProcess } from './process.js';
import { ensureDir, normalizePath, sha256, slug } from './utils.js';

export async function git(args, options = {}) {
  const result = await runProcess('git', args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: options.maxOutputBytes ?? 8_000_000,
    env: options.env,
  });
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.code ?? result.error}):\n${result.stderr || result.stdout}`);
  }
  return result;
}

export async function findRepoRoot(startPath = process.cwd()) {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd: startPath, allowFailure: true });
  if (result.code !== 0) throw new Error(`${startPath} is not inside a Git repository.`);
  return path.resolve(result.stdout.trim());
}

export async function resolveBase(repoRoot, ref = 'HEAD') {
  const result = await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot });
  return result.stdout.trim();
}

export async function currentHead(repoRoot) {
  return (await git(['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
}

export async function repositoryFingerprint(repoRoot) {
  const common = (await git(['rev-parse', '--git-common-dir'], { cwd: repoRoot })).stdout.trim();
  return sha256(path.resolve(repoRoot, common)).slice(0, 12);
}

export async function createWorktree(repoRoot, missionId, laneId, baseSha) {
  const fingerprint = await repositoryFingerprint(repoRoot);
  const root = path.join(os.tmpdir(), 'vrn', fingerprint);
  const missionKey = sha256(String(missionId)).slice(0, 10);
  const laneKey = sha256(String(laneId)).slice(0, 10);
  const worktreePath = path.join(root, missionKey, laneKey);
  await ensureDir(root);

  const existing = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (existing.stdout.split(/\r?\n/).some((line) => line === `worktree ${worktreePath}`)) {
    return worktreePath;
  }

  await git(['worktree', 'add', '--detach', worktreePath, baseSha], { cwd: repoRoot, timeoutMs: 180_000 });
  return worktreePath;
}

export function worktreeCacheRoot() {
  return path.resolve(os.tmpdir(), 'vrn');
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function removeManagedWorktree(repoRoot, worktreePath, options = {}) {
  const resolved = path.resolve(worktreePath);
  if (!isWithin(worktreeCacheRoot(), resolved)) throw new Error('Refusing to remove a worktree outside the Verenne cache.');
  const args = ['worktree', 'remove'];
  if (options.force === true) args.push('--force');
  args.push(resolved);
  const result = await git(args, { cwd: repoRoot, allowFailure: options.allowFailure === true, timeoutMs: 180_000 });
  return result.code === 0;
}

export async function getChangedFiles(worktreePath, baseSha) {
  await git(['add', '-N', '--', '.'], { cwd: worktreePath, allowFailure: true });
  const result = await git(['diff', '--name-status', '-z', '--find-renames', baseSha, '--'], { cwd: worktreePath });
  const fields = result.stdout.split('\0').filter((value) => value !== '');
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], similarity: status.slice(1), oldPath: normalizePath(fields[index++]), path: normalizePath(fields[index++]) });
    } else {
      files.push({ status: status[0], path: normalizePath(fields[index++]) });
    }
  }
  return files;
}

export async function getDiffStats(worktreePath, baseSha) {
  await git(['add', '-N', '--', '.'], { cwd: worktreePath, allowFailure: true });
  const numstat = await git(['diff', '--numstat', baseSha, '--'], { cwd: worktreePath });
  let additions = 0;
  let deletions = 0;
  const files = [];
  for (const line of numstat.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const [added, removed, ...parts] = line.split('\t');
    const filePath = parts.join('\t');
    const numericAdded = Number.parseInt(added, 10);
    const numericRemoved = Number.parseInt(removed, 10);
    if (Number.isFinite(numericAdded)) additions += numericAdded;
    if (Number.isFinite(numericRemoved)) deletions += numericRemoved;
    files.push({ path: normalizePath(filePath), additions: Number.isFinite(numericAdded) ? numericAdded : null, deletions: Number.isFinite(numericRemoved) ? numericRemoved : null });
  }
  return { additions, deletions, files };
}

export async function capturePatch(worktreePath, baseSha) {
  await git(['add', '-N', '--', '.'], { cwd: worktreePath, allowFailure: true });
  // Runtime state and the agent result contract are control-plane files, not
  // candidate output. Exclude them even when a repository happens to track a
  // colliding path so they can never enter a sealed/applicable patch.
  const result = await git([
    'diff', '--binary', '--full-index', baseSha, '--', '.',
    ':(exclude).verenne-result.json', ':(exclude).verenne/**',
  ], { cwd: worktreePath, maxOutputBytes: 40_000_000 });
  return result.stdout;
}

export async function readBaseFile(repoRoot, baseSha, filePath) {
  const result = await git(['show', `${baseSha}:${normalizePath(filePath)}`], { cwd: repoRoot, allowFailure: true });
  return result.code === 0 ? result.stdout : null;
}

export async function readCandidateFile(worktreePath, filePath) {
  try { return await readFile(path.join(worktreePath, filePath), 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function getTrackedFiles(repoRoot) {
  const result = await git(['ls-files', '-z'], { cwd: repoRoot });
  return result.stdout.split('\0').filter(Boolean).map(normalizePath);
}

export async function statusSummary(worktreePath) {
  const result = await git(['status', '--porcelain=v1'], { cwd: worktreePath });
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

/** Fingerprint main-worktree state so a provider that escapes its lane is detected and disqualified. */
export async function workingTreeSeal(repoRoot) {
  const [status, working, staged, head, refs, commonResult, gitDirResult, ignored] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot }),
    git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], { cwd: repoRoot, maxOutputBytes: 40_000_000 }),
    git(['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', '--'], { cwd: repoRoot, maxOutputBytes: 40_000_000 }),
    git(['rev-parse', 'HEAD'], { cwd: repoRoot }),
    git(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags'], { cwd: repoRoot }),
    git(['rev-parse', '--git-common-dir'], { cwd: repoRoot }),
    git(['rev-parse', '--git-dir'], { cwd: repoRoot }),
    git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'], {
      cwd: repoRoot,
      maxOutputBytes: 40_000_000,
    }),
  ]);
  const untracked = [];
  for (const entry of status.stdout.split('\0').filter(Boolean)) {
    if (!entry.startsWith('?? ')) continue;
    const relative = entry.slice(3);
    const resolved = path.resolve(repoRoot, relative);
    const inside = path.relative(repoRoot, resolved);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      untracked.push(`${relative}:outside`);
      continue;
    }
    try {
      const metadata = await lstat(resolved);
      if (metadata.isSymbolicLink()) {
        untracked.push(`${relative}:symlink:${await readlink(resolved)}`);
      } else if (metadata.isFile() && metadata.size <= 8_000_000) {
        untracked.push(`${relative}:file:${metadata.mode}:${sha256(await readFile(resolved))}`);
      } else {
        untracked.push(`${relative}:${metadata.size}:${metadata.mtimeMs}:${metadata.mode}`);
      }
    } catch (error) {
      untracked.push(`${relative}:unreadable:${error.code ?? error.message}`);
    }
  }
  const commonDir = path.resolve(repoRoot, commonResult.stdout.trim());
  const gitDir = path.resolve(repoRoot, gitDirResult.stdout.trim());
  const metadata = [];
  const fingerprintMetadata = async (target, label, depth = 0) => {
    if (depth > 4 || metadata.length > 2_000) return;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        metadata.push(`${label}:symlink:${await readlink(target)}`);
      } else if (info.isDirectory()) {
        const names = (await readdir(target)).sort();
        for (const name of names) await fingerprintMetadata(path.join(target, name), `${label}/${name}`, depth + 1);
      } else if (info.isFile() && info.size <= 8_000_000) {
        metadata.push(`${label}:file:${info.mode}:${sha256(await readFile(target))}`);
      } else {
        metadata.push(`${label}:${info.size}:${info.mtimeMs}:${info.mode}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') metadata.push(`${label}:unreadable:${error.code ?? error.message}`);
    }
  };
  await fingerprintMetadata(path.join(commonDir, 'config'), 'git/config');
  await fingerprintMetadata(path.join(commonDir, 'hooks'), 'git/hooks');
  await fingerprintMetadata(path.join(commonDir, 'info'), 'git/info');
  await fingerprintMetadata(path.join(commonDir, 'packed-refs'), 'git/packed-refs');
  await fingerprintMetadata(path.join(gitDir, 'config.worktree'), 'git/config.worktree');
  for (const relative of ignored.stdout.split('\0').filter(Boolean).sort()) {
    const normalized = normalizePath(relative).replace(/^\.\//, '').replace(/\/$/, '');
    // Mission state is intentionally written by Verenne while providers run;
    // it must not be mistaken for an escaped provider write in the parent.
    if (normalized === '.verenne' || normalized.startsWith('.verenne/') || normalized === '.verenne-result.json') continue;
    const resolved = path.resolve(repoRoot, relative);
    const relation = path.relative(repoRoot, resolved);
    if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      metadata.push(`ignored/${relative}:outside`);
      continue;
    }
    await fingerprintMetadata(resolved, `ignored/${normalized}`);
  }
  if (ignored.outputTruncated) metadata.push('ignored-list:truncated');
  return sha256([head.stdout, refs.stdout, status.stdout, ignored.stdout, working.stdout, staged.stdout, ...untracked.sort(), ...metadata.sort()].join('\0'));
}
