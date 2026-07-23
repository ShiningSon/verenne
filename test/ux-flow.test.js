import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import {
  explainAdapterFailure,
  inspectAdapters,
  runAdapter,
} from '../src/adapters.js';
import {
  formatAdapterChoice,
  interactiveSession,
  readTaskInput,
  resolveSessionRepoRoot,
  selectAvailableAdapters,
} from '../src/terminal-ui.js';

function baseConfig() {
  return {
    defaultAgents: ['claude', 'codex', 'opencode'],
    concurrency: 3,
    runtime: {
      timeoutMs: 10_000,
      allowedEnv: ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'],
    },
    profiles: {
      frontier: {
        claude: { model: 'claude-opus-native-id', effort: 'max' },
        codex: { model: 'gpt-frontier-native-id', effort: 'xhigh' },
      },
    },
    adapters: {
      claude: { label: 'Claude Code', command: 'claude', args: [], stdin: 'prompt', modelArgs: ['--model', '{model}'], effortArgs: ['--effort', '{effort}'] },
      codex: { label: 'OpenAI Codex', command: 'codex', args: [], stdin: 'prompt', modelArgs: ['--model', '{model}'], effortArgs: ['--effort', '{effort}'] },
      opencode: { label: 'OpenCode', command: 'opencode', args: [], stdin: 'prompt', modelArgs: ['--model', '{model}'], variantArgs: ['--variant', '{variant}'] },
      gemini: { label: 'Gemini CLI', command: 'gemini', args: [], stdin: 'prompt', modelArgs: ['--model', '{model}'] },
      aider: { label: 'Aider', command: 'aider', args: [], stdin: 'prompt', modelArgs: ['--model', '{model}'] },
    },
  };
}

function captureStream() {
  let content = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      content += chunk.toString();
      callback();
    },
  });
  Object.defineProperty(stream, 'content', { get: () => content });
  return stream;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verenne-ux-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('adapter discovery checks every configured provider concurrently and ranks preferred installed agents first', async () => {
  const config = baseConfig();
  const rows = await inspectAdapters(config, {
    profile: 'frontier',
    commandExists: async () => true,
  });
  assert.deepEqual(rows.map((row) => row.id), ['claude', 'codex', 'opencode', 'gemini', 'aider']);
  assert.ok(rows.every((row) => row.available));
  assert.equal(rows[0].tuning.model, 'claude-opus-native-id');
  assert.equal(rows[1].tuning.effort, 'xhigh');
});

test('automatic selection fills unavailable defaults with ranked installed fallbacks', async () => {
  const config = baseConfig();
  const rows = await inspectAdapters(config, {
    profile: 'frontier',
    commandExists: async (command) => command !== 'claude' && command !== 'opencode',
  });
  const selected = selectAvailableAdapters(config, rows);
  assert.deepEqual(selected.map((row) => row.id), ['codex', 'gemini', 'aider']);
  const claude = rows.find((row) => row.id === 'claude');
  assert.match(claude.reason, /not found on PATH/i);
  assert.match(claude.reason, /install and sign in/i);
});

test('frontier choices clearly present model, effort, variant, and provider-native defaults', () => {
  assert.equal(formatAdapterChoice({
    id: 'codex', label: 'OpenAI Codex', tuning: { model: 'gpt-frontier-native-id', effort: 'xhigh' },
  }), 'OpenAI Codex — gpt-frontier-native-id · xhigh effort');
  assert.equal(formatAdapterChoice({ id: 'gemini', label: 'Gemini CLI', tuning: {} }), 'Gemini CLI — provider-native default');
  assert.equal(formatAdapterChoice({ id: 'opencode', label: 'OpenCode', tuning: { variant: 'thinking' } }), 'OpenCode — thinking variant');
});

test('adapter tuning is passed through byte-for-byte while the task stays on stdin', async (t) => {
  const worktreePath = await temporaryDirectory(t);
  const child = [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), input, mission: process.env.VERENNE_MISSION_ID })));",
  ].join('');
  const config = {
    runtime: baseConfig().runtime,
    adapters: {
      fixture: {
        label: 'Fixture Agent',
        command: process.execPath,
        args: ['-e', child],
        tuningPosition: 2,
        stdin: 'prompt',
        modelArgs: ['MODEL={model}'],
        effortArgs: ['EFFORT={effort}'],
        variantArgs: ['VARIANT={variant}'],
      },
    },
  };
  const prompt = 'Fix quoted input "exactly" & keep Unicode 한글.';
  const result = await runAdapter({
    config,
    adapterId: 'fixture',
    worktreePath,
    prompt,
    missionId: 'mission-ux',
    laneId: 'lane-ux',
    tuning: { model: 'provider/model:2026-07', effort: 'xhigh', variant: 'thinking-max' },
  });
  assert.equal(result.code, 0, result.stderr || result.error);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.argv, ['MODEL=provider/model:2026-07', 'EFFORT=xhigh', 'VARIANT=thinking-max']);
  assert.equal(observed.input, prompt);
  assert.equal(observed.mission, 'mission-ux');
  assert.equal(result.model, 'provider/model:2026-07');
});

test('prompt-file adapters receive only the file path in argv, never raw task text', async (t) => {
  const worktreePath = await temporaryDirectory(t);
  const prompt = 'Secret-looking task content must not enter argv.';
  const promptPath = path.join(worktreePath, 'task with spaces.md');
  await writeFile(promptPath, prompt, 'utf8');
  const child = "const fs = require('node:fs'); const p = process.argv[1]; process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), content: fs.readFileSync(p, 'utf8') }));";
  const config = {
    runtime: baseConfig().runtime,
    adapters: {
      fixture: {
        label: 'File Agent', command: process.execPath,
        args: ['-e', child, '{prompt_file}'],
      },
    },
  };
  const result = await runAdapter({ config, adapterId: 'fixture', worktreePath, prompt, promptPath, missionId: 'm', laneId: 'l' });
  assert.equal(result.code, 0, result.stderr || result.error);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.content, prompt);
  assert.deepEqual(observed.argv, [promptPath]);
  assert.doesNotMatch(observed.argv.join(' '), /Secret-looking task content/);
});

test('unsafe raw-prompt argv adapters are rejected with a migration instruction', async (t) => {
  const worktreePath = await temporaryDirectory(t);
  const config = {
    runtime: baseConfig().runtime,
    adapters: { unsafe: { label: 'Unsafe Agent', command: process.execPath, args: ['{prompt}'] } },
  };
  await assert.rejects(
    runAdapter({ config, adapterId: 'unsafe', worktreePath, prompt: 'do not leak me', missionId: 'm', laneId: 'l' }),
    /process arguments.*stdin.*prompt_file/i,
  );
});

test('provider failures include a concise next action without rewriting native errors', () => {
  const auth = explainAdapterFailure({ label: 'Claude Code' }, { code: 1, stderr: 'Authentication required' });
  assert.equal(auth.kind, 'authentication');
  assert.match(auth.nextStep, /sign in/i);
  const missing = explainAdapterFailure({ label: 'OpenAI Codex' }, { code: null, error: 'Executable not found in an absolute trusted PATH entry' });
  assert.equal(missing.kind, 'unavailable');
  assert.match(missing.nextStep, /doctor/i);
});

test('piped task input preserves multiline instructions and enforces a size limit', async () => {
  assert.equal(await readTaskInput(Readable.from(['First line\n', 'Second line\n'])), 'First line\nSecond line');
  await assert.rejects(readTaskInput(Readable.from(['12345']), 4), /safety limit/i);
});

test('interactive startup asks for a repository when launched elsewhere and accepts a quoted path', async () => {
  const output = captureStream();
  Object.defineProperty(output, 'isTTY', { value: true });
  const calls = [];
  const selected = path.resolve('/fixture/repo with spaces');
  const input = Readable.from([`"${selected}"\n`]);
  Object.defineProperty(input, 'isTTY', { value: true });
  const result = await resolveSessionRepoRoot({
    input,
    output,
    cwd: path.resolve('/fixture/outside'),
    findRepoRoot: async (candidate) => {
      calls.push(candidate);
      if (candidate === selected) return selected;
      throw new Error('outside repository');
    },
  });
  assert.equal(result, selected);
  assert.deepEqual(calls, [path.resolve('/fixture/outside'), selected]);
  assert.match(output.content, /No Git project is open/i);
  assert.match(output.content, /Project folder/i);
  assert.match(output.content, /Opened/i);
});

test('an explicit valid repo bypasses selection in both TTY and non-TTY sessions', async () => {
  const cwd = path.resolve('/fixture/outside');
  const requested = path.join('nested', 'repo');
  const resolvedRequest = path.resolve(cwd, requested);
  const canonical = path.resolve('/fixture/canonical/repo');
  for (const interactive of [true, false]) {
    const output = captureStream();
    const calls = [];
    const result = await resolveSessionRepoRoot({
      input: Readable.from([]),
      output,
      interactive,
      repoRoot: requested,
      cwd,
      findRepoRoot: async (candidate) => { calls.push(candidate); return canonical; },
    });
    assert.equal(result, canonical);
    assert.deepEqual(calls, [resolvedRequest]);
    assert.doesNotMatch(output.content, /Project folder/i);
  }
});

test('mixed TTY startup never opens a prompt', async () => {
  for (const [inputTTY, outputTTY] of [[true, false], [false, true], [false, false]]) {
    const input = Readable.from(['must not be consumed']);
    const output = captureStream();
    Object.defineProperty(input, 'isTTY', { value: inputTTY });
    Object.defineProperty(output, 'isTTY', { value: outputTTY });
    await assert.rejects(resolveSessionRepoRoot({
      input,
      output,
      cwd: path.resolve('/fixture/outside'),
      findRepoRoot: async () => { throw new Error('outside repository'); },
    }), /--repo <path>/i);
    assert.doesNotMatch(output.content, /Project folder/i);
  }
});

test('blank interactive project selection exits without loading config or running agents', async () => {
  const input = Readable.from(['\n']);
  const output = captureStream();
  Object.defineProperty(input, 'isTTY', { value: true });
  Object.defineProperty(output, 'isTTY', { value: true });
  let downstreamCalls = 0;
  const result = await interactiveSession({
    input,
    output,
    cwd: path.resolve('/fixture/outside'),
    findRepoRoot: async () => { throw new Error('outside repository'); },
    loadConfig: async () => { downstreamCalls += 1; return baseConfig(); },
    inspectAdapters: async () => { downstreamCalls += 1; return []; },
    runMission: async () => { downstreamCalls += 1; },
  });
  assert.equal(result, null);
  assert.equal(downstreamCalls, 0);
  assert.match(output.content, /No project selected; nothing was changed/i);
});

test('interactive repository selection retries invalid input without initializing folders', async () => {
  const output = captureStream();
  const cwd = path.resolve('/fixture/outside');
  const invalid = path.resolve(cwd, 'plain-folder');
  const selected = path.resolve(cwd, 'repo');
  const calls = [];
  const answers = ['plain-folder', 'repo'];
  const result = await resolveSessionRepoRoot({
    input: Readable.from([]),
    output,
    interactive: true,
    cwd,
    createInterface: () => ({
      question: async () => answers.shift(),
      close() {},
    }),
    findRepoRoot: async (candidate) => {
      calls.push(candidate);
      if (candidate === selected) return selected;
      throw new Error('outside repository');
    },
  });
  assert.equal(result, selected);
  assert.deepEqual(calls, [cwd, invalid, selected]);
  assert.match(output.content, /Not a Git repository/i);
});

test('noninteractive startup outside Git gives an actionable repo option', async () => {
  await assert.rejects(resolveSessionRepoRoot({
    input: Readable.from([]),
    output: captureStream(),
    interactive: false,
    cwd: path.resolve('/fixture/outside'),
    findRepoRoot: async () => { throw new Error('outside repository'); },
  }), /inside a repository.*--repo <path>/i);
});

test('an explicit invalid repo fails once instead of opening a selection loop', async () => {
  const output = captureStream();
  let calls = 0;
  await assert.rejects(resolveSessionRepoRoot({
    input: Readable.from(['unused\n']),
    output,
    interactive: true,
    repoRoot: 'missing-repo',
    cwd: path.resolve('/fixture/outside'),
    findRepoRoot: async () => { calls += 1; throw new Error('outside repository'); },
  }), /Cannot open Git project.*existing Git repository/i);
  assert.equal(calls, 1);
  assert.doesNotMatch(output.content, /Project folder/i);
});

test('noninteractive zero-command flow starts immediately without a confirmation prompt', async () => {
  const config = baseConfig();
  const output = captureStream();
  const calls = [];
  const mission = { id: 'm1', candidates: [], decision: { status: 'NO_WINNER', reasons: ['Fixture result.'] } };
  const result = await interactiveSession({
    input: Readable.from(['Implement the release-quality change.']),
    output,
    interactive: false,
    findRepoRoot: async () => '/fixture/repo',
    loadConfig: async () => config,
    inspectAdapters: async (_config, _ids, options) => inspectAdapters(config, { ...options, commandExists: async () => true }),
    runMission: async (options) => { calls.push(options); return { mission }; },
  });
  assert.equal(result.mission, mission);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'Implement the release-quality change.');
  assert.equal(calls[0].profile, 'frontier');
  assert.deepEqual(calls[0].agents, ['claude', 'codex', 'opencode']);
  assert.doesNotMatch(output.content, /Convene|\[Y\/n\]|confirm/i);
  assert.match(output.content, /provider-native model access/i);
  assert.match(output.content, /Evidence replay complete/i);
});

test('zero-config flow stops before asking for work and gives install guidance when no agent exists', async () => {
  const config = baseConfig();
  const output = captureStream();
  let invoked = false;
  const result = await interactiveSession({
    input: Readable.from(['this task should not be consumed']),
    output,
    interactive: false,
    findRepoRoot: async () => '/fixture/repo',
    loadConfig: async () => config,
    inspectAdapters: async (_config, _ids, options) => inspectAdapters(config, { ...options, commandExists: async () => false }),
    runMission: async () => { invoked = true; },
  });
  assert.equal(result, null);
  assert.equal(invoked, false);
  assert.match(output.content, /No supported agent CLI/i);
  assert.match(output.content, /install and sign in/i);
  assert.match(output.content, /verenne doctor/i);
});
