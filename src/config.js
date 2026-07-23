import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, readJson, sha256, stableStringify, writeJson } from './utils.js';
import { git } from './git.js';
import { commandExists, resolveTrustedExecutable } from './process.js';

export const CONFIG_FILE = 'verenne.config.json';
export const POLICY_FILE = 'verenne.policy.json';
export const STATE_DIR = '.verenne';

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  defaultMode: 'arena',
  defaultAgents: ['claude', 'codex', 'opencode'],
  concurrency: 3,
  autoDiscoverGates: true,
  context: {
    maxBytes: 120000,
    maxFiles: 24,
    include: ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'],
  },
  runtime: {
    kind: 'process',
    timeoutMs: 900000,
    allowedEnv: [
      'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
      'TEMP', 'TMP', 'HOME', 'USERPROFILE',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    ],
  },
  profiles: {
    frontier: {
      claude: { model: 'opus', effort: 'max' },
      codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
      opencode: {},
      gemini: { model: 'pro' },
      aider: { effort: 'high' },
    },
  },
  adapters: {
    claude: {
      label: 'Claude Code',
      command: 'claude',
      args: ['-p', 'Follow the complete task instructions provided on stdin.', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      stdin: 'prompt',
      allowedEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
      modelArgs: ['--model', '{model}'],
      effortArgs: ['--effort', '{effort}'],
      result: 'stdout',
    },
    codex: {
      label: 'OpenAI Codex',
      command: 'codex',
      args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--json', '-'],
      tuningPosition: 0,
      modelArgs: ['--model', '{model}'],
      effortArgs: ['--config', 'model_reasoning_effort={effort}'],
      stdin: 'prompt',
      allowedEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
      result: 'stdout',
    },
    opencode: {
      label: 'OpenCode',
      command: 'opencode',
      args: ['run', '--format', 'json', 'Implement the attached task instructions exactly.', '--file', '{prompt_file}'],
      tuningPosition: 1,
      modelArgs: ['--model', '{model}'],
      variantArgs: ['--variant', '{variant}'],
      allowedEnv: ['OPENROUTER_API_KEY'],
      result: 'stdout',
    },
    gemini: {
      label: 'Gemini CLI',
      command: 'gemini',
      args: ['-p', 'Follow the complete task instructions provided on stdin.', '--output-format', 'json'],
      stdin: 'prompt',
      allowedEnv: ['GEMINI_API_KEY'],
      modelArgs: ['--model', '{model}'],
      result: 'stdout',
    },
    aider: {
      label: 'Aider',
      command: 'aider',
      args: ['--yes-always', '--no-auto-commits', '--no-dirty-commits', '--message-file', '{prompt_file}'],
      tuningPosition: 0,
      modelArgs: ['--model', '{model}'],
      effortArgs: ['--reasoning-effort', '{effort}'],
      allowedEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'],
      result: 'stdout',
    },
  },
});

export const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 1,
  bootstrap: 'auto',
  protectedInputs: [
    'verenne.policy.json',
    'verenne.config.json',
  ],
  verificationInputs: [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'deno.json',
    'deno.jsonc',
    'vitest.config.*',
    'vite.config.*',
    'jest.config.*',
    'playwright.config.*',
    'cypress.config.*',
    'karma.conf.*',
    'pytest.ini',
    'pyproject.toml',
    'setup.cfg',
    'tox.ini',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'Gemfile',
    'Rakefile',
    'gradlew',
    'gradlew.bat',
    'gradle/wrapper/**',
    'mvnw',
    'mvnw.cmd',
    '.mvn/wrapper/**',
    'scripts/**',
    '*test*runner*',
    'conftest.py',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    '.pnpmfile.cjs',
    '.cargo/config',
    '.cargo/config.toml',
    'Cargo.lock',
    'go.sum',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
    'pytest.py',
    'pytest/**',
    'node_modules/**',
  ],
  forbiddenPatterns: ['.env', '*.pem', '*.key', 'id_rsa', 'credentials.json'],
  gates: [],
  rules: {
    blockTestDeletion: true,
    blockFocusedTests: true,
    blockProtectedInputChanges: true,
    requireRegressionTestForFixClaims: true,
    requireVisualEvidenceForUiClaims: true,
    strictRequiredClaims: true,
    strictIntentCoverage: true,
    requirePositiveReplay: true,
  },
  scoring: {
    gates: 45,
    claims: 25,
    trust: 15,
    scope: 10,
    efficiency: 5,
  },
});

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (!base || typeof base !== 'object') return extra ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base[key] ?? {}, value)
      : value;
  }
  return result;
}

export async function loadConfig(repoRoot) {
  const filePath = path.join(repoRoot, CONFIG_FILE);
  const userConfig = await readJson(filePath, {});
  return deepMerge(DEFAULT_CONFIG, userConfig);
}

export async function loadPolicy(repoRoot, baseSha) {
  let raw;
  let source = baseSha ? 'built-in-defaults' : 'working-tree';
  let trusted = Boolean(baseSha);

  if (baseSha) {
    const result = await git(['show', `${baseSha}:${POLICY_FILE}`], { cwd: repoRoot, allowFailure: true });
    if (result.code === 0) {
      raw = result.stdout;
      source = `git:${baseSha.slice(0, 12)}`;
      trusted = true;
    }
  }

  if (raw === undefined && !baseSha) {
    try {
      raw = await readFile(path.join(repoRoot, POLICY_FILE), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const supplied = raw === undefined ? {} : JSON.parse(raw);
  const policy = deepMerge(DEFAULT_POLICY, supplied);
  policy.bootstrap = policy.bootstrap === false
    ? []
    : policy.bootstrap === 'auto'
      ? await discoverBootstrap(repoRoot, baseSha)
      : Array.isArray(policy.bootstrap) ? policy.bootstrap : [];
  if ((policy.gates ?? []).length === 0) {
    policy.gates = await discoverGates(repoRoot, baseSha);
  }
  const commands = [...(policy.bootstrap ?? []), ...(policy.gates ?? [])].flatMap((item) => {
    const argv = Array.isArray(item.command) ? item.command : Array.isArray(item.argv) ? item.argv : [];
    const command = argv[0] ?? (typeof item.command === 'string' && !/\s/.test(item.command) ? item.command : null);
    return command ? [command] : [];
  });
  const toolchain = [];
  for (const command of [...new Set(commands)]) {
    if (String(command).includes('/') || String(command).includes('\\')) continue;
    try {
      const executable = resolveTrustedExecutable(command, process.env, repoRoot);
      toolchain.push({ command, executable, digest: sha256(await readFile(executable)) });
    } catch {
      // Missing tools become explicit bootstrap/gate errors during replay.
    }
  }
  return {
    policy,
    trusted,
    source,
    digest: sha256(stableStringify(policy)),
    toolchain,
  };
}

export async function discoverBootstrap(repoRoot, baseSha) {
  if (await baseFileExists(repoRoot, baseSha, 'pnpm-lock.yaml')) {
    return [{ id: 'pnpm-install', label: 'Install locked pnpm dependencies', command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], required: true, timeoutMs: 900_000 }];
  }
  if (await baseFileExists(repoRoot, baseSha, 'yarn.lock')) {
    return [{ id: 'yarn-install', label: 'Install locked Yarn dependencies', command: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'], required: true, timeoutMs: 900_000 }];
  }
  if (await baseFileExists(repoRoot, baseSha, 'bun.lock') || await baseFileExists(repoRoot, baseSha, 'bun.lockb')) {
    return [{ id: 'bun-install', label: 'Install locked Bun dependencies', command: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], required: true, timeoutMs: 900_000 }];
  }
  if (await baseFileExists(repoRoot, baseSha, 'package-lock.json') || await baseFileExists(repoRoot, baseSha, 'npm-shrinkwrap.json')) {
    return [{ id: 'npm-ci', label: 'Install locked npm dependencies', command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], required: true, timeoutMs: 900_000 }];
  }
  if (await baseFileExists(repoRoot, baseSha, 'package.json')) {
    const packageJson = await readBaseJson(repoRoot, baseSha, 'package.json');
    const dependencyCount = Object.keys(packageJson?.dependencies ?? {}).length + Object.keys(packageJson?.devDependencies ?? {}).length + Object.keys(packageJson?.optionalDependencies ?? {}).length;
    if (dependencyCount > 0) {
      return [{ id: 'npm-install-unlocked', label: 'Install npm dependencies without creating a lockfile', command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], required: true, timeoutMs: 900_000 }];
    }
  }
  return [];
}

async function baseFileExists(repoRoot, baseSha, filePath) {
  if (!baseSha) return exists(path.join(repoRoot, filePath));
  const result = await git(['cat-file', '-e', `${baseSha}:${filePath}`], { cwd: repoRoot, allowFailure: true });
  return result.code === 0;
}

async function readBaseJson(repoRoot, baseSha, filePath) {
  if (baseSha) {
    const result = await git(['show', `${baseSha}:${filePath}`], { cwd: repoRoot, allowFailure: true });
    if (result.code === 0) return JSON.parse(result.stdout);
  }
  return await readJson(path.join(repoRoot, filePath), null);
}

export async function discoverGates(repoRoot, baseSha) {
  const gates = [];
  const listed = baseSha
    ? await git(['ls-tree', '-r', '--name-only', baseSha], { cwd: repoRoot, allowFailure: true })
    : await git(['ls-files'], { cwd: repoRoot, allowFailure: true });
  const basePaths = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (await baseFileExists(repoRoot, baseSha, 'package.json')) {
    const packageJson = await readBaseJson(repoRoot, baseSha, 'package.json');
    const manager = await baseFileExists(repoRoot, baseSha, 'bun.lock') || await baseFileExists(repoRoot, baseSha, 'bun.lockb') ? 'bun'
      : await baseFileExists(repoRoot, baseSha, 'pnpm-lock.yaml') ? 'pnpm'
      : await baseFileExists(repoRoot, baseSha, 'yarn.lock') ? 'yarn'
        : 'npm';
    const scripts = packageJson?.scripts ?? {};
    const command = (name) => manager === 'yarn' ? [manager, name]
      : manager === 'pnpm' || manager === 'bun' ? [manager, 'run', name]
        : [manager, name === 'test' ? 'test' : 'run', ...(name === 'test' ? [] : [name])];
    for (const [id, label] of [['test', 'Tests'], ['lint', 'Lint'], ['typecheck', 'Type check'], ['build', 'Build']]) {
      if (typeof scripts[id] === 'string' && scripts[id].trim()) gates.push({ id, label, command: command(id), required: id === 'test' || id === 'build', timeoutMs: 600_000, discovered: true });
    }
  }
  if (await baseFileExists(repoRoot, baseSha, 'deno.json') || await baseFileExists(repoRoot, baseSha, 'deno.jsonc')) {
    gates.push({ id: 'deno-test', label: 'Deno tests', command: ['deno', 'test'], required: true, timeoutMs: 600_000, discovered: true });
  }
  if (await baseFileExists(repoRoot, baseSha, 'go.mod')) {
    gates.push({ id: 'go-test', label: 'Go tests', command: ['go', 'test', './...'], required: true, timeoutMs: 600_000, discovered: true });
  }
  if (await baseFileExists(repoRoot, baseSha, 'Cargo.toml')) {
    gates.push({ id: 'cargo-test', label: 'Cargo tests', command: ['cargo', 'test', '--all'], required: true, timeoutMs: 600_000, discovered: true });
  }
  if (await baseFileExists(repoRoot, baseSha, 'pytest.ini') || await baseFileExists(repoRoot, baseSha, 'pyproject.toml') || await baseFileExists(repoRoot, baseSha, 'setup.cfg')) {
    const python = process.platform === 'win32' && await commandExists('py') ? ['py', '-3']
      : await commandExists('python3') ? ['python3']
        : ['python'];
    gates.push({ id: 'python-test', label: 'Python tests', command: [...python, '-m', 'pytest'], required: true, timeoutMs: 600_000, discovered: true });
  }
  if (basePaths.some((filePath) => /(?:^|\/)[^/]+\.(?:sln|csproj)$/i.test(filePath))) {
    gates.push({ id: 'dotnet-test', label: '.NET tests', command: ['dotnet', 'test', '--nologo'], required: true, timeoutMs: 900_000, discovered: true });
  }
  if (await baseFileExists(repoRoot, baseSha, 'gradlew') || await baseFileExists(repoRoot, baseSha, 'gradlew.bat')) {
    gates.push({ id: 'gradle-test', label: 'Gradle tests', command: [process.platform === 'win32' ? './gradlew.bat' : './gradlew', 'test', '--no-daemon'], required: true, timeoutMs: 900_000, discovered: true });
  } else if (await baseFileExists(repoRoot, baseSha, 'pom.xml')) {
    const wrapper = process.platform === 'win32' ? './mvnw.cmd' : './mvnw';
    const hasWrapper = await baseFileExists(repoRoot, baseSha, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
    gates.push({ id: 'maven-test', label: 'Maven tests', command: [hasWrapper ? wrapper : 'mvn', 'test', '--batch-mode'], required: true, timeoutMs: 900_000, discovered: true });
  }
  if (await baseFileExists(repoRoot, baseSha, 'Gemfile') && await baseFileExists(repoRoot, baseSha, 'spec')) {
    gates.push({ id: 'ruby-test', label: 'Ruby specs', command: ['bundle', 'exec', 'rspec'], required: true, timeoutMs: 600_000, discovered: true });
  }
  return gates;
}

export async function prepareRuntimeExcludes(repoRoot) {
  const gitPath = (await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: repoRoot })).stdout.trim();
  const excludePath = path.resolve(repoRoot, gitPath);
  let excludes = '';
  try { excludes = await readFile(excludePath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const requiredExcludes = [`/${STATE_DIR}/`, '/.verenne-result.json'];
  const missingExcludes = requiredExcludes.filter((entry) => !excludes.split(/\r?\n/).includes(entry));
  if (missingExcludes.length) {
    await ensureDir(path.dirname(excludePath));
    await writeFile(excludePath, `${excludes}${excludes && !excludes.endsWith('\n') ? '\n' : ''}${missingExcludes.join('\n')}\n`, 'utf8');
  }
}

export async function initializeProject(repoRoot, options = {}) {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  const policyPath = path.join(repoRoot, POLICY_FILE);
  const statePath = path.join(repoRoot, STATE_DIR);
  const created = [];

  if (!await exists(configPath) || options.force) {
    await writeJson(configPath, DEFAULT_CONFIG);
    created.push(CONFIG_FILE);
  }
  if (!await exists(policyPath) || options.force) {
    await writeJson(policyPath, DEFAULT_POLICY);
    created.push(POLICY_FILE);
  }

  await writeJson(path.join(statePath, 'README.json'), {
    note: 'Runtime state generated by Verenne Code. Safe to remove when no rallies are active.',
    schemaVersion: 1,
  });

  await prepareRuntimeExcludes(repoRoot);

  return { created, configPath, policyPath, statePath };
}
