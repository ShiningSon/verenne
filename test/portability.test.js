import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { compileContext } from '../src/context.js';
import { missionDir } from '../src/state.js';
import { resolveTrustedExecutable, runProcess } from '../src/process.js';
import { readAgentResult, runAdapter } from '../src/adapters.js';
import { workingTreeSeal } from '../src/git.js';
import { loadPolicy, prepareRuntimeExcludes } from '../src/config.js';
import { runBootstrapSteps } from '../src/bootstrap.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function temporaryDirectory(t, prefix = 'verenne-portability-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.equal(isInside(os.tmpdir(), directory), true, 'test cleanup must stay inside the OS temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function git(args, cwd) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result;
}

test('npm artifact is zero-dependency, contains its public essentials, and exposes one portable bin', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.dependencies ?? {}, {}, 'the one-line CLI should not download a runtime dependency tree');
  assert.equal(packageJson.scripts?.preinstall, undefined, 'install-time scripts are unnecessary and reduce trust');
  assert.equal(packageJson.scripts?.install, undefined, 'install-time scripts are unnecessary and reduce trust');
  assert.equal(packageJson.scripts?.postinstall, undefined, 'install-time scripts are unnecessary and reduce trust');
  assert.match(packageJson.engines?.node ?? '', />=\s*20/);

  const bins = Object.entries(packageJson.bin ?? {});
  assert.equal(bins.length, 1, 'the package should expose one memorable command');
  const [binName, relativeBin] = bins[0];
  assert.match(binName, /^[a-z][a-z0-9-]*$/);
  const binSource = await readFile(path.join(projectRoot, relativeBin), 'utf8');
  assert.match(binSource, /^#!\/usr\/bin\/env node\r?\n/);

  for (const publicFile of ['README.md', 'LICENSE']) {
    const contents = await readFile(path.join(projectRoot, publicFile), 'utf8');
    assert.ok(contents.trim().length > 0, `${publicFile} must ship in the npm artifact`);
  }

  const packed = await runProcess('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 2_000_000,
  });
  assert.equal(packed.code, 0, packed.stderr || packed.error);
  const manifest = JSON.parse(packed.stdout)[0];
  const paths = new Set(manifest.files.map((file) => file.path.replaceAll('\\', '/')));
  assert.ok(paths.has('README.md'));
  assert.ok(paths.has('LICENSE'));
  assert.ok(paths.has(relativeBin.replace(/^\.\//, '').replaceAll('\\', '/')));
  assert.ok([...paths].every((file) => !file.startsWith('test/') && !file.startsWith('work/')));
});

test('trusted executable lookup ignores candidate-controlled PATH entries', async (t) => {
  const candidate = await temporaryDirectory(t);
  const realGit = resolveTrustedExecutable('git');
  const fakeName = process.platform === 'win32' ? 'git.EXE' : 'git';
  const fakeGit = path.join(candidate, fakeName);
  await writeFile(fakeGit, process.platform === 'win32' ? 'not an executable\r\n' : '#!/bin/sh\nexit 97\n', 'utf8');
  if (process.platform !== 'win32') await chmod(fakeGit, 0o755);

  const env = {
    PATH: [candidate, path.dirname(realGit)].join(path.delimiter),
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
  };
  assert.equal(path.resolve(resolveTrustedExecutable('git', env, candidate)), path.resolve(realGit));
  assert.throws(
    () => resolveTrustedExecutable('definitely-not-a-real-verenne-command', { PATH: '.' }, candidate),
    /absolute trusted PATH entry/,
  );
});

test('native process runner preserves Unicode, spaces, shell metacharacters, and stdin without a shell', async () => {
  const argv = ['space value', '한글', '100%', 'left&right', '"quoted"', '<tag>', 'semi;colon'];
  const input = 'prompt with %PATH% & $(not-executed) | 한글\n';
  const child = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), input })));",
  ].join('');
  const result = await runProcess(process.execPath, ['-e', child, ...argv], { input, timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr || result.error);
  assert.deepEqual(JSON.parse(result.stdout), { argv, input });
});

test('agent adapters receive task-scoped metadata without inheriting unrelated host secrets', async (t) => {
  const worktreePath = await temporaryDirectory(t);
  const prompt = 'Implement "quoted" behavior safely & keep 한글 intact.';
  const secretName = `VERENNE_UNRELATED_SECRET_${process.pid}`;
  process.env[secretName] = 'must-not-reach-the-agent';
  const child = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, env: process.env })));",
  ].join('');
  const config = {
    runtime: {
      timeoutMs: 10_000,
      allowedEnv: ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'],
    },
    adapters: {
      fixture: { command: process.execPath, args: ['-e', child], stdin: 'prompt' },
    },
  };

  try {
    const result = await runAdapter({
      config,
      adapterId: 'fixture',
      worktreePath,
      prompt,
      promptPath: path.join(worktreePath, 'prompt with spaces.md'),
      missionId: 'mission-scope-sentinel',
      laneId: 'lane-scope-sentinel',
    });
    assert.equal(result.code, 0, result.stderr || result.error);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.input, prompt);
    assert.equal(observed.env[secretName], undefined);
    assert.ok(Object.values(observed.env).includes('mission-scope-sentinel'));
    assert.ok(Object.values(observed.env).includes('lane-scope-sentinel'));
  } finally {
    delete process.env[secretName];
  }
});

test('agent result contracts fail closed on oversized collections and files', async (t) => {
  const worktree = await temporaryDirectory(t, 'verenne-result-contract-');
  const contractPath = path.join(worktree, '.verenne-result.json');
  await writeFile(contractPath, JSON.stringify({ claims: Array.from({ length: 201 }, (_, index) => ({ id: `C${index}` })) }), 'utf8');
  const tooMany = await readAgentResult(worktree, { stdout: '', stderr: '' });
  assert.match(tooMany.source, /invalid/);
  assert.match(tooMany.contractError, /200-item limit/);

  await writeFile(contractPath, `{"summary":"${'x'.repeat(2_000_001)}"}`, 'utf8');
  const tooLarge = await readAgentResult(worktree, { stdout: '', stderr: '' });
  assert.match(tooLarge.source, /invalid/);
  assert.match(tooLarge.contractError, /2 MB limit/);
});

test('candidate dependency bootstrap uses an isolated home without host registry credentials', async (t) => {
  const worktree = await temporaryDirectory(t, 'verenne-bootstrap-env-');
  const previous = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = 'VERENNE_TEST_TOKEN_MUST_NOT_LEAK';
  try {
    const bootstrap = await runBootstrapSteps([{
      id: 'inspect-environment',
      command: [process.execPath, '-e', "process.stdout.write(JSON.stringify({token:process.env.NPM_TOKEN,home:process.env.HOME,registry:process.env.NPM_CONFIG_REGISTRY}))"],
    }], worktree, { credentials: false });
    assert.equal(bootstrap.ok, true);
    const observed = JSON.parse(bootstrap.results[0].stdout);
    assert.equal(observed.token, undefined);
    assert.equal(observed.registry, 'https://registry.npmjs.org/');
    assert.notEqual(path.resolve(observed.home), path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? worktree));
    assert.equal(bootstrap.results[0].credentialMode, 'isolated');
  } finally {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
  }
});

test('process runner bounds output and terminates timed-out process trees', async () => {
  const noisy = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], {
    maxOutputBytes: 256,
    timeoutMs: 5_000,
  });
  assert.equal(noisy.code, 0);
  assert.equal(noisy.outputTruncated, true);
  assert.ok(Buffer.byteLength(noisy.stdout) <= 256);

  const hanging = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 120 });
  assert.equal(hanging.timedOut, true);
  assert.ok(hanging.durationMs < 3_000, `timeout took ${hanging.durationMs}ms`);
});

test('parent integrity seal detects ignored-file and common Git metadata changes', async (t) => {
  const repo = await temporaryDirectory(t, 'verenne-parent-seal-');
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Portability Test'], repo);
  await git(['config', 'user.email', 'portability@example.invalid'], repo);
  await writeFile(path.join(repo, '.gitignore'), '.env\n', 'utf8');
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n', 'utf8');
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'base'], repo);
  await writeFile(path.join(repo, '.env'), 'TOKEN=one\n', 'utf8');
  const before = await workingTreeSeal(repo);
  await writeFile(path.join(repo, '.env'), 'TOKEN=two\n', 'utf8');
  const ignoredChanged = await workingTreeSeal(repo);
  assert.notEqual(ignoredChanged, before);

  const common = (await git(['rev-parse', '--git-common-dir'], repo)).stdout.trim();
  await writeFile(path.resolve(repo, common, 'info', 'exclude'), '# parent metadata changed\n', 'utf8');
  const metadataChanged = await workingTreeSeal(repo);
  assert.notEqual(metadataChanged, ignoredChanged);
});

test('mission identifiers cannot traverse outside the repository state directory', () => {
  const repoRoot = path.join(os.tmpdir(), 'verenne-path-boundary');
  const normal = missionDir(repoRoot, 'mission-123');
  assert.equal(isInside(repoRoot, normal), true);
  assert.throws(() => missionDir(repoRoot, '../../outside'), /mission|identifier|invalid/i);
  assert.throws(() => missionDir(repoRoot, '..\\..\\outside'), /mission|identifier|invalid/i);
});

test('runtime excludes resolve through Git metadata for linked worktrees', async (t) => {
  const root = await temporaryDirectory(t, 'verenne-linked-worktree-');
  const repo = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  await mkdir(repo);
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Portability Test'], repo);
  await git(['config', 'user.email', 'portability@example.invalid'], repo);
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n', 'utf8');
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'base'], repo);
  await git(['worktree', 'add', '--detach', linked, 'HEAD'], repo);
  try {
    await prepareRuntimeExcludes(linked);
    const gitPath = (await git(['rev-parse', '--git-path', 'info/exclude'], linked)).stdout.trim();
    const contents = await readFile(path.resolve(linked, gitPath), 'utf8');
    assert.match(contents, /^\/.verenne\/$/m);
    assert.match(contents, /^\/.verenne-result\.json$/m);
  } finally {
    await git(['worktree', 'remove', '--force', linked], repo);
  }
});

test('candidate-added policy cannot replace immutable defaults or base-discovered gates', async (t) => {
  const repo = await temporaryDirectory(t, 'verenne-policy-base-');
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Portability Test'], repo);
  await git(['config', 'user.email', 'portability@example.invalid'], repo);
  await writeFile(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'policy-fixture', private: true, scripts: { test: 'node --test' },
  })}\n`, 'utf8');
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'base without policy'], repo);
  const baseSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
  await writeFile(path.join(repo, 'verenne.policy.json'), `${JSON.stringify({
    gates: [{ id: 'candidate-bypass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }],
    rules: { strictRequiredClaims: false },
  })}\n`, 'utf8');

  const bundle = await loadPolicy(repo, baseSha);
  assert.equal(bundle.source, 'built-in-defaults');
  assert.equal(bundle.trusted, true);
  assert.ok(bundle.policy.gates.some((gate) => gate.id === 'test'));
  assert.equal(bundle.policy.gates.some((gate) => gate.id === 'candidate-bypass'), false);
  assert.equal(bundle.policy.rules.strictRequiredClaims, true);
});

test('context compilation never follows a tracked symlink outside the repository', { skip: process.platform === 'win32' }, async (t) => {
  const sandbox = await temporaryDirectory(t);
  const repo = path.join(sandbox, 'repo');
  await mkdir(repo);
  const secret = 'VERENNE_CONTEXT_ESCAPE_SENTINEL';
  await writeFile(path.join(sandbox, 'outside-secret.txt'), secret, 'utf8');
  await symlink('../outside-secret.txt', path.join(repo, 'linked.txt'));

  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Portability Test'], repo);
  await git(['config', 'user.email', 'portability@example.invalid'], repo);
  await git(['add', '--', 'linked.txt'], repo);
  await git(['commit', '-m', 'track an external symlink fixture'], repo);

  const destination = path.join(repo, '.verenne-test', 'context.md');
  const result = await compileContext(repo, 'linked secret', {
    context: { include: ['linked.txt'], maxFiles: 4, maxBytes: 8_000 },
  }, destination);
  const context = await readFile(destination, 'utf8');
  assert.doesNotMatch(context, new RegExp(secret));
  assert.ok(!result.files.includes('linked.txt'), 'external symlink content must be omitted from the agent context');
});
