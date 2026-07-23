import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from '../src/cli.js';
import { CONFIG_FILE, POLICY_FILE, STATE_DIR } from '../src/config.js';
import { APP_NAME, VERSION } from '../src/utils.js';
import { runProcess } from '../src/process.js';
import { normalizeAgents } from '../src/mission.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const [binName, relativeBin] = Object.entries(packageJson.bin)[0];
const binPath = path.join(projectRoot, relativeBin);

async function temporaryDirectory(t, prefix = 'verenne-cli-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function runCli(args, options = {}) {
  return await runProcess(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
  });
}

async function git(args, cwd) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.error || `git ${args.join(' ')} failed`);
  return result;
}

test('argument parser handles repeated values, equals syntax, negation, and the positional boundary', () => {
  assert.deepEqual(parseArgs([
    'run', '--agent=claude', '--agent', 'codex', '--no-open', '--task', 'fix it', '--', '--literal', 'tail',
  ]), {
    positional: ['run', '--literal', 'tail'],
    flags: { agent: ['claude', 'codex'], open: false, task: 'fix it' },
  });
});

test('common short help and version switches are supported', () => {
  assert.equal(parseArgs(['-h']).flags.help, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('CLI help and version work outside a Git repository and use the installed command name', async (t) => {
  const outsideGit = await temporaryDirectory(t);
  const help = await runCli(['--help'], { cwd: outsideGit });
  assert.equal(help.code, 0, help.stderr || help.error);
  assert.match(help.stdout, new RegExp(APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(help.stdout, new RegExp(`\\b${binName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} demo\\b`));

  const version = await runCli(['--version'], { cwd: outsideGit });
  assert.equal(version.code, 0, version.stderr || version.error);
  assert.equal(version.stdout.trim(), packageJson.version);
  assert.equal(version.stdout.trim(), VERSION);
});

test('usage mistakes are concise and do not expose local stack traces by default', async (t) => {
  const outsideGit = await temporaryDirectory(t);
  const result = await runCli(['definitely-not-a-command'], { cwd: outsideGit });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command/);
  assert.doesNotMatch(result.stderr, /(?:file:\/\/\/|src[\\/]cli\.js|\n\s+at\s)/);
});

test('init is one command, works in paths with spaces and Unicode, and is idempotent', async (t) => {
  const root = await temporaryDirectory(t);
  const repo = path.join(root, 'repo with spaces 한글');
  await mkdir(repo);
  await git(['init', '-b', 'main'], repo);

  const first = await runCli(['init', '--repo', repo]);
  assert.equal(first.code, 0, first.stderr || first.error);
  assert.match(first.stdout, /initialized/i);
  await readFile(path.join(repo, CONFIG_FILE), 'utf8');
  await readFile(path.join(repo, POLICY_FILE), 'utf8');
  const exclude = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude.replaceAll('\\', '/'), new RegExp(`/${STATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

  const second = await runCli(['init', '--repo', repo]);
  assert.equal(second.code, 0, second.stderr || second.error);
  assert.match(second.stdout, /already exists/i);
});

test('a locally packed artifact supports the promised no-global-install npx path', async (t) => {
  const root = await temporaryDirectory(t, 'verenne-npx-');
  const packed = await runProcess('npm', ['pack', '--pack-destination', root, '--json'], {
    cwd: projectRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 2_000_000,
  });
  assert.equal(packed.code, 0, packed.stderr || packed.error);
  const tarball = path.join(root, JSON.parse(packed.stdout)[0].filename);
  const consumer = path.join(root, 'consumer project');
  await mkdir(consumer);

  const install = await runProcess('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--prefix', consumer, tarball,
  ], { cwd: consumer, timeoutMs: 60_000, maxOutputBytes: 2_000_000 });
  assert.equal(install.code, 0, install.stderr || install.error);

  const npx = await runProcess('npx', ['--no-install', binName, '--version'], {
    cwd: consumer,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  });
  assert.equal(npx.code, 0, npx.stderr || npx.error);
  assert.equal(npx.stdout.trim(), packageJson.version);
});

test('agent auto-selection keeps only detected adapters up to the concurrency limit', async () => {
  const config = {
    concurrency: 1,
    runtime: { allowedEnv: ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT'] },
    adapters: {
      first: { label: 'First fixture', command: process.execPath, args: ['--version'], stdin: 'prompt' },
      second: { label: 'Second fixture', command: process.execPath, args: ['--version'], stdin: 'prompt' },
    },
  };
  assert.deepEqual(await normalizeAgents(config, [], false), ['first']);
  assert.deepEqual(await normalizeAgents(config, ['second'], false), ['second']);
});

test('run --json emits one machine-readable document and exits 2 for no winner', async (t) => {
  const repo = await temporaryDirectory(t, 'verenne-cli-json-');
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'CLI Test'], repo);
  await git(['config', 'user.email', 'cli@verenne.invalid'], repo);
  await writeFile(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  await writeFile(path.join(repo, CONFIG_FILE), `${JSON.stringify({
    schemaVersion: 1,
    adapters: {
      fixture: {
        label: 'Failing fixture', command: process.execPath,
        args: ['-e', 'process.exit(7)'], stdin: 'prompt', timeoutMs: 10_000,
      },
    },
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(repo, POLICY_FILE), `${JSON.stringify({ schemaVersion: 1, bootstrap: false, gates: [] }, null, 2)}\n`, 'utf8');
  await git(['add', '--all'], repo);
  await git(['commit', '-m', 'fixture'], repo);

  try {
    const result = await runCli(['run', 'Produce no patch.', '--repo', repo, '--agents', 'fixture', '--json'], { timeoutMs: 60_000 });
    assert.equal(result.code, 2, result.stderr || result.error);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.mission.decision.status, 'NO_WINNER');
    assert.equal(parsed.mission.status, 'blocked');
    assert.doesNotMatch(result.stdout, /Verenne Code mission/i);
  } finally {
    await runCli(['clean', 'latest', '--repo', repo, '--force'], { timeoutMs: 30_000 });
  }
});
