import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  capturePatch,
  createWorktree,
  currentHead,
  getChangedFiles,
  getDiffStats,
  git,
  readBaseFile,
  readCandidateFile,
  workingTreeSeal,
} from './git.js';
import { POLICY_FILE } from './config.js';
import { createAbortError, isAbortError, resolveTrustedExecutable, runProcess, throwIfAborted } from './process.js';
import { runBootstrapSteps } from './bootstrap.js';
import { normalizePath, sha256, stableStringify } from './utils.js';

export const EVIDENCE_TRUST = Object.freeze({
  UNTRUSTED: 'untrusted',
  OBSERVED: 'observed',
  REPLAYED: 'replayed',
});

const INTERNAL_PATHS = new Set(['.verenne-result.json']);
const TEST_DEFINITION_RE = /(?:\b(?:test|it|describe)\s*\(|\bdef\s+test_[a-z0-9_]*\s*\(|\bfunc\s+Test[A-Z0-9_]*\s*\(|@Test\b|\#\[test\])/i;
const TEST_ASSERTION_RE = /(?:\bassert(?:ion)?\b|\bexpect\s*\(|\brequire\.|\bassert_eq!\s*\()/i;
const DISABLED_TEST_RE = /(?:\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|fit|fdescribe)\s*\(|\bpytest\.skip\s*\(|@Disabled\b|\#\[ignore\]|\bt\.Skip(?:f|Now)?\s*\()/i;
const FOCUSED_TEST_RE = /(?:\.only\s*\(|\b(?:fit|fdescribe)\s*\()/i;
const BREAKING_REMOVAL_RE = /^\s*(?:export\s+(?:default\s+)?|public\s+|module\.exports|exports\.|(?:async\s+)?(?:function|class|interface|type|enum)\s+[A-Za-z_$]|(?:app|router)\.(?:get|post|put|patch|delete)\s*\()/i;
const NOOP_RUNNER_RE = /(?:^|(?:&&|;|\s))(?:echo\s+(?:pass|ok|success)|true|exit\s+0|node\s+-e\s+["']?process\.exit\(0\))/i;

function withoutInternalFiles(files) {
  return files.filter((file) => !isInternalPath(file.path) || (file.oldPath && !isInternalPath(file.oldPath)));
}

export function isInternalPath(filePath) {
  const normalized = normalizePath(String(filePath ?? '')).replace(/^\.\//, '');
  return INTERNAL_PATHS.has(normalized) || normalized.startsWith('.verenne/');
}

export function isTestPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  const base = path.posix.basename(value);
  return /(^|\/)(?:test|tests|spec|specs|__tests__|e2e)(\/|$)/.test(value)
    || /(?:\.test|\.spec)\.[^.]+$/.test(base)
    || /(?:^test_.+|_test)\.py$/.test(base)
    || /_test\.go$/.test(base)
    || /(?:test|tests)\.(?:java|kt|rs|rb|php|cs)$/.test(base)
    || base.endsWith('.feature');
}

export function isDocsPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  const base = path.posix.basename(value);
  return /(^|\/)(?:docs?|documentation)(\/|$)/.test(value)
    || /^(?:readme|changelog|contributing|security)(?:\.|$)/.test(base)
    || /\.(?:md|mdx|rst|adoc)$/.test(base);
}

export function isDependencyPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  const base = path.posix.basename(value);
  return /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|pdm\.lock|requirements(?:-[^.]+)?\.txt|cargo\.toml|cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|composer\.(?:json|lock)|gemfile(?:\.lock)?)$/.test(base);
}

export function isUiPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  const base = path.posix.basename(value);
  return /(^|\/)(?:ui|views?|screens?|pages?|components?|frontend|web)(\/|$)/.test(value)
    || /\.(?:css|scss|sass|less|html|vue|svelte|tsx|jsx)$/.test(base);
}

export function isMigrationPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  return /(^|\/)(?:migrations?|db\/migrate|alembic\/versions|prisma\/migrations)(\/|$)/.test(value)
    || /(?:^|\/)[0-9]{6,}[_-].*\.(?:sql|py|js|ts|rb)$/.test(value);
}

export function isSchemaPath(filePath) {
  const value = normalizePath(String(filePath ?? '')).toLowerCase();
  return /(?:^|\/)(?:schema(?:\.prisma|\.sql|\.graphql)?|database\.sql)$/.test(value)
    || /(^|\/)(?:schemas?|models?)(\/|$)/.test(value) && /\.(?:sql|prisma|py|rb|ts|js)$/.test(value);
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function matchesPathPattern(filePath, pattern) {
  const value = normalizePath(String(filePath ?? '')).replace(/^\.\//, '');
  const supplied = normalizePath(String(pattern ?? '')).replace(/^\.\//, '');
  if (!supplied) return false;

  if (!supplied.includes('*') && !supplied.includes('?')) {
    if (value === supplied || value.endsWith(`/${supplied}`)) return true;
    if (supplied === '.env' && path.posix.basename(value).startsWith('.env')) return true;
    return false;
  }

  const marker = '\u0000';
  const source = escapeRegex(supplied)
    .replaceAll('**', marker)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll(marker, '.*');
  return new RegExp(`^(?:${source}|.*/${source})$`).test(value);
}

function parseDiffLines(diffText) {
  const added = [];
  const removed = [];
  let currentPath = null;

  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const candidatePath = line.slice(4).trim();
      currentPath = candidatePath === '/dev/null'
        ? null
        : normalizePath(candidatePath.replace(/^b\//, '').replace(/^"|"$/g, ''));
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff --git ') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) added.push({ path: currentPath, text: line.slice(1) });
    if (line.startsWith('-')) removed.push({ path: currentPath, text: line.slice(1) });
  }
  return { added, removed };
}

function normalizeRunner(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function commandLooksNarrower(before, after) {
  const base = normalizeRunner(before);
  const candidate = normalizeRunner(after);
  if (!base || !candidate || base === candidate) return false;
  if (NOOP_RUNNER_RE.test(candidate)) return true;
  if (candidate.length < Math.max(4, base.length * 0.6)) return true;
  if (candidate.startsWith(`${base} `)) {
    const suffix = candidate.slice(base.length).trim();
    if (/^(?:\.\/)?(?:test|tests|spec|specs)\//i.test(suffix) || /\.(?:test|spec)\.[a-z0-9]+(?:\s|$)/i.test(suffix)) return true;
  }
  return false;
}

async function analyzeRunnerChanges(repoRoot, worktreePath, baseSha, changedPaths) {
  const result = { changed: [], weakened: [], reasons: [] };
  if (!changedPaths.includes('package.json')) return result;

  const [baseRaw, candidateRaw] = await Promise.all([
    readBaseFile(repoRoot, baseSha, 'package.json'),
    readCandidateFile(worktreePath, 'package.json'),
  ]);
  if (baseRaw == null || candidateRaw == null) {
    result.changed.push('package.json');
    result.weakened.push('package.json');
    result.reasons.push('package.json or its test runner was removed.');
    return result;
  }

  try {
    const baseScripts = JSON.parse(baseRaw).scripts ?? {};
    const candidateScripts = JSON.parse(candidateRaw).scripts ?? {};
    const scriptNames = [...new Set([...Object.keys(baseScripts), ...Object.keys(candidateScripts)])]
      .filter((name) => name === 'test' || name.startsWith('test:'));

    for (const name of scriptNames) {
      const before = normalizeRunner(baseScripts[name]);
      const after = normalizeRunner(candidateScripts[name]);
      if (before === after) continue;
      result.changed.push(`scripts.${name}`);
      if (!after || commandLooksNarrower(before, after)) {
        result.weakened.push(`scripts.${name}`);
        result.reasons.push(`${name} changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}.`);
      }
    }
  } catch (error) {
    result.changed.push('package.json');
    result.weakened.push('package.json');
    result.reasons.push(`package.json is not valid JSON: ${error.message}`);
  }
  return result;
}

export async function analyzeCandidateDiff({ repoRoot, worktreePath, baseSha, changedFiles, diffText, policy }) {
  const files = withoutInternalFiles(changedFiles);
  const changedPaths = [...new Set(files.flatMap((file) => [file.path, file.oldPath]).filter(Boolean))];
  const parsed = parseDiffLines(diffText);
  const testAddedLines = parsed.added.filter((line) => line.path && isTestPath(line.path));
  const testRemovedLines = parsed.removed.filter((line) => line.path && isTestPath(line.path));
  const addedDefinitions = testAddedLines.filter((line) => TEST_DEFINITION_RE.test(line.text)).length;
  const addedAssertions = testAddedLines.filter((line) => TEST_ASSERTION_RE.test(line.text)).length;
  const removedDefinitions = testRemovedLines.filter((line) => TEST_DEFINITION_RE.test(line.text)).length;
  const disabledLines = testAddedLines.filter((line) => DISABLED_TEST_RE.test(line.text));
  const focusedLines = testAddedLines.filter((line) => FOCUSED_TEST_RE.test(line.text));
  const deletedTestFiles = files.filter((file) => (
    file.status === 'D' && isTestPath(file.path)
  ) || (
    file.status === 'R' && isTestPath(file.oldPath) && !isTestPath(file.path)
  )).map((file) => file.oldPath ?? file.path);
  const addedTestFiles = files.filter((file) => file.status !== 'D' && isTestPath(file.path)).map((file) => file.path);
  const removedTestCases = Math.max(0, removedDefinitions - addedDefinitions);
  const productionFiles = files.filter((file) => !isTestPath(file.path) && !isDocsPath(file.path));

  const protectedInputs = policy?.protectedInputs ?? [];
  const forbiddenPatterns = policy?.forbiddenPatterns ?? [];
  const protectedChanges = changedPaths.filter((filePath) => protectedInputs.some((pattern) => matchesPathPattern(filePath, pattern)));
  const forbiddenChanges = changedPaths.filter((filePath) => forbiddenPatterns.some((pattern) => matchesPathPattern(filePath, pattern)));
  const runner = await analyzeRunnerChanges(repoRoot, worktreePath, baseSha, changedPaths);

  const publicKey = (text) => text.match(/\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/)?.[1]
    ?? text.match(/\b(?:exports\.|module\.exports\s*=\s*)([A-Za-z_$][\w$]*)/)?.[1]
    ?? null;
  const addedPublicKeys = new Set(parsed.added.map((line) => publicKey(line.text)).filter(Boolean));
  const breakingSignals = parsed.removed
    .filter((line) => line.path && !isTestPath(line.path) && BREAKING_REMOVAL_RE.test(line.text))
    .filter((line) => !publicKey(line.text) || !addedPublicKeys.has(publicKey(line.text)))
    .map((line) => ({ path: line.path, text: line.text.trim().slice(0, 240) }));
  for (const file of productionFiles.filter((item) => item.status === 'D')) {
    breakingSignals.push({ path: file.path, text: 'Production file deleted.' });
  }

  const migrationPaths = changedPaths.filter(isMigrationPath);
  const schemaPaths = changedPaths.filter(isSchemaPath);

  return {
    hasPatch: files.length > 0,
    changedPaths,
    productionPaths: productionFiles.map((file) => file.path),
    testPaths: changedPaths.filter(isTestPath),
    docsPaths: changedPaths.filter(isDocsPath),
    dependencyPaths: changedPaths.filter(isDependencyPath),
    uiPaths: changedPaths.filter(isUiPath),
    migrationPaths,
    schemaPaths,
    protectedChanges,
    forbiddenChanges,
    test: {
      addedFiles: addedTestFiles,
      deletedFiles: deletedTestFiles,
      addedDefinitions,
      addedAssertions,
      removedDefinitions,
      removedTestCases,
      disabledLines: disabledLines.map((line) => ({ path: line.path, text: line.text.trim().slice(0, 240) })),
      focusedLines: focusedLines.map((line) => ({ path: line.path, text: line.text.trim().slice(0, 240) })),
    },
    runner,
    breakingSignals,
    schemaWithoutMigration: schemaPaths.length > 0 && migrationPaths.length === 0,
  };
}

function publicBinding(seal) {
  return {
    baseSha: seal.baseSha,
    headSha: seal.headSha,
    diffDigest: seal.diffDigest,
    policyDigest: seal.policyDigest,
    sealDigest: seal.sealDigest,
  };
}

export async function createCandidateSeal({ repoRoot, worktreePath, baseSha, policyBundle }) {
  // The git helpers intentionally refresh intent-to-add entries. Keep them
  // sequential so concurrent candidates never contend on this worktree's index.
  const headSha = await currentHead(worktreePath);
  const rawChangedFiles = await getChangedFiles(worktreePath, baseSha);
  const rawStats = await getDiffStats(worktreePath, baseSha);
  const patch = await capturePatch(worktreePath, baseSha);
  const diffResult = await git([
    'diff', '--unified=0', '--no-ext-diff', baseSha, '--', '.',
    ':(exclude).verenne-result.json', ':(exclude).verenne/**',
  ], {
    cwd: worktreePath,
    maxOutputBytes: 40_000_000,
  });
  const reservedChanges = rawChangedFiles.filter((file) => isInternalPath(file.path) || (file.oldPath && isInternalPath(file.oldPath)));
  const changedFiles = withoutInternalFiles(rawChangedFiles);
  const statFiles = rawStats.files.filter((file) => !isInternalPath(file.path));
  const stats = {
    additions: statFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: statFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    files: statFiles,
  };
  const policy = policyBundle?.policy ?? policyBundle ?? {};
  const policyDigest = policyBundle?.digest ?? sha256(stableStringify(policy));
  const diffDigest = sha256(patch);
  const sealDigest = sha256(stableStringify({ baseSha, headSha, diffDigest, policyDigest }));
  return {
    baseSha,
    headSha,
    diffDigest,
    policyDigest,
    sealDigest,
    changedFiles,
    reservedChanges,
    stats,
    patch,
    diffText: diffResult.stdout,
  };
}

function violation(id, severity, message, paths = [], evidenceIds = ['diff-analysis']) {
  return { id, severity, message, paths: [...new Set(paths)], evidenceIds };
}

export function detectTrustViolations({ analysis, policyBundle, policy }) {
  const violations = [];
  const rules = policy?.rules ?? {};
  if (policyBundle?.trusted === false) {
    violations.push(violation('policy_not_base_owned', 'high', 'The policy was not loaded from the base commit.', [POLICY_FILE], ['candidate-seal']));
  }
  if (analysis.protectedChanges.length > 0 && rules.blockProtectedInputChanges !== false) {
    violations.push(violation('protected_input_changed', 'critical', 'Candidate changed base-owned verification inputs.', analysis.protectedChanges));
  }
  if (analysis.test.deletedFiles.length > 0 && rules.blockTestDeletion !== false) {
    violations.push(violation('test_deleted', 'critical', 'Candidate deleted test files.', analysis.test.deletedFiles));
  }
  if (analysis.test.removedTestCases > 0 && rules.blockTestDeletion !== false) {
    violations.push(violation('test_cases_removed', 'high', `Candidate removed ${analysis.test.removedTestCases} test definition(s).`, analysis.testPaths));
  }
  if (analysis.test.disabledLines.length > 0 && rules.blockFocusedTests !== false) {
    violations.push(violation('test_disabled', 'critical', 'Candidate introduced skipped or ignored tests.', analysis.test.disabledLines.map((line) => line.path)));
  }
  if (analysis.test.focusedLines.length > 0 && rules.blockFocusedTests !== false) {
    violations.push(violation('test_focused', 'critical', 'Candidate introduced focused tests that narrow the suite.', analysis.test.focusedLines.map((line) => line.path)));
  }
  if (analysis.runner.weakened.length > 0) {
    violations.push(violation('runner_weakened', 'critical', `Candidate weakened the test runner: ${analysis.runner.reasons.join(' ')}`, ['package.json']));
  }
  if (analysis.forbiddenChanges.length > 0) {
    violations.push(violation('forbidden_path_changed', 'critical', 'Candidate changed files forbidden by policy.', analysis.forbiddenChanges));
  }
  if ((analysis.reservedChanges ?? []).length > 0) {
    violations.push(violation(
      'reserved_control_path_changed',
      'critical',
      'Candidate changed a Verenne control-plane path; reserved files are never included in a sealed patch.',
      analysis.reservedChanges.flatMap((file) => [file.oldPath, file.path]).filter(Boolean),
    ));
  }
  if (analysis.schemaWithoutMigration) {
    violations.push(violation('schema_without_migration', 'high', 'Schema changed without a migration artifact.', analysis.schemaPaths));
  }
  if (!analysis.hasPatch) {
    violations.push(violation('empty_patch', 'high', 'Candidate produced no mergeable changes.', []));
  }
  return violations;
}

function normalizeGate(gate, index) {
  const value = typeof gate === 'string' || Array.isArray(gate) ? { command: gate } : { ...(gate ?? {}) };
  const id = String(value.id ?? value.name ?? `gate-${index + 1}`);
  let command;
  let args;
  if (Array.isArray(value.argv)) {
    [command, ...args] = value.argv.map(String);
  } else if (Array.isArray(value.command)) {
    [command, ...args] = value.command.map(String);
  } else {
    command = value.command == null ? '' : String(value.command);
    args = Array.isArray(value.args) ? value.args.map(String) : [];
    if (command && args.length === 0 && /\s/.test(command.trim())) {
      const parsed = parseCommandLine(command);
      [command, ...args] = parsed;
    }
  }
  return {
    id,
    label: String(value.label ?? value.name ?? id),
    command,
    args,
    cwd: value.cwd == null ? '.' : String(value.cwd),
    env: value.env && typeof value.env === 'object' ? value.env : {},
    timeoutMs: Number.isFinite(value.timeoutMs) ? value.timeoutMs : 10 * 60_000,
    maxOutputBytes: Number.isFinite(value.maxOutputBytes) ? value.maxOutputBytes : 2_000_000,
    expectedExitCode: Number.isInteger(value.expectedExitCode) ? value.expectedExitCode : 0,
    required: value.required !== false,
    enabled: value.enabled !== false,
    kind: String(value.kind ?? value.type ?? ''),
    claimKinds: [...new Set([...(value.claims ?? []), ...(value.claimKinds ?? [])].map(String))],
  };
}

export function parseCommandLine(commandLine) {
  const input = String(commandLine ?? '').trim();
  if (!input) return [];
  if (/[\r\n;&|<>`]/.test(input)) {
    throw new Error('Gate command strings cannot contain shell operators; use an argv array.');
  }
  const tokens = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g;
  let match;
  let consumed = '';
  while ((match = pattern.exec(input)) !== null) {
    consumed += match[0];
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  }
  if (consumed.replace(/\s/g, '').length !== input.replace(/\s/g, '').length) throw new Error('Cannot safely parse gate command.');
  return tokens;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function executableOnPath(command, forbiddenRoot) {
  if (!command) return null;
  if (path.isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) return null;
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExtension = process.platform === 'win32' && path.extname(command);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const resolvedDirectory = path.resolve(directory.replace(/^"|"$/g, ''));
    if (forbiddenRoot && isWithin(forbiddenRoot, resolvedDirectory)) continue;
    for (const extension of hasExtension ? [''] : extensions) {
      const candidate = path.join(resolvedDirectory, `${command}${extension}`);
      try {
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function gateEnvironment(extra = {}) {
  const allowed = new Set(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP']);
  const result = { CI: '1', VERENNE_VERIFY: '1' };
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) && value != null) result[key] = value;
  for (const [key, value] of Object.entries(extra)) if (value != null) result[key] = String(value);
  return result;
}

function outputPreview(value, maximum = 12_000) {
  const text = String(value ?? '');
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n... output truncated in evidence preview ...`;
}

function windowsBatchInvocation(executable, args) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args, env: {} };
  // CreateProcess cannot launch .cmd/.bat files directly. Pass the structured
  // argv through an environment variable so no candidate-controlled value is
  // interpolated into PowerShell source code.
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '$spec = $env:VERENNE_BATCH_SPEC | ConvertFrom-Json',
    '$command = [string]$spec.command',
    '$arguments = @($spec.args | ForEach-Object { [string]$_ })',
    '& $command @arguments',
    'if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }',
  ].join('; ');
  return {
    executable: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    env: { VERENNE_BATCH_SPEC: JSON.stringify({ command: executable, args }) },
  };
}

async function runOneGate(gate, verificationPath, binding, suite = 'candidate', signal) {
  throwIfAborted(signal);
  const base = {
    id: `gate:${gate.id}:${suite}`,
    kind: 'gate-replay',
    trust: EVIDENCE_TRUST.REPLAYED,
    gateId: gate.id,
    gateKind: gate.kind,
    label: `${gate.label} (${suite === 'baseline' ? 'trusted baseline suite' : 'candidate suite'})`,
    required: gate.required,
    claimKinds: gate.claimKinds,
    command: [gate.command, ...gate.args],
    candidateBinding: binding,
  };
  if (!gate.enabled) return { ...base, status: 'SKIPPED', passed: false, reason: 'Gate disabled by base policy.' };
  if (!gate.command) return { ...base, status: 'ERROR', passed: false, reason: 'Gate has no command.' };

  const cwd = path.resolve(verificationPath, gate.cwd);
  if (!isWithin(verificationPath, cwd)) return { ...base, status: 'ERROR', passed: false, reason: 'Gate cwd escapes the verification worktree.' };
  try {
    const [rootRealPath, cwdRealPath] = await Promise.all([realpath(verificationPath), realpath(cwd)]);
    if (!isWithin(rootRealPath, cwdRealPath)) return { ...base, status: 'ERROR', passed: false, reason: 'Gate cwd resolves through a symlink outside the verification worktree.' };
  } catch (error) {
    return { ...base, status: 'ERROR', passed: false, reason: `Gate cwd cannot be resolved safely: ${error.message}` };
  }

  let executable = gate.command;
  if (path.isAbsolute(gate.command)) {
    executable = gate.command;
  } else if (gate.command.includes('/') || gate.command.includes('\\')) {
    executable = path.resolve(cwd, gate.command);
    if (!isWithin(verificationPath, executable)) return { ...base, status: 'ERROR', passed: false, reason: 'Gate executable escapes the verification worktree.' };
    try {
      if (!isWithin(await realpath(verificationPath), await realpath(executable))) return { ...base, status: 'ERROR', passed: false, reason: 'Gate executable resolves through a symlink outside the verification worktree.' };
    } catch (error) {
      return { ...base, status: 'ERROR', passed: false, reason: `Gate executable cannot be resolved safely: ${error.message}` };
    }
  } else {
    executable = await executableOnPath(gate.command, verificationPath) ?? gate.command;
  }

  const invocation = windowsBatchInvocation(executable, gate.args);
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'vrn-gate-home-'));
  const isolatedAppData = path.join(isolatedHome, 'appdata');
  const isolatedLocalAppData = path.join(isolatedHome, 'localappdata');
  await Promise.all([mkdir(isolatedAppData, { recursive: true }), mkdir(isolatedLocalAppData, { recursive: true })]);
  const treeBefore = await workingTreeSeal(verificationPath);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await runProcess(invocation.executable, invocation.args, {
      cwd,
      timeoutMs: gate.timeoutMs,
      maxOutputBytes: gate.maxOutputBytes,
      env: gateEnvironment({
        ...gate.env,
        ...invocation.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: isolatedAppData,
        LOCALAPPDATA: isolatedLocalAppData,
      }),
      signal,
    });
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
  if (result.aborted) throw createAbortError(result.abortReason);
  const endedAt = new Date().toISOString();
  const treeAfter = await workingTreeSeal(verificationPath);
  const mutated = treeAfter !== treeBefore;
  const passed = !mutated && !result.timedOut && result.error == null && result.code === gate.expectedExitCode;
  return {
    ...base,
    executable,
    status: result.timedOut || result.error || mutated ? 'ERROR' : passed ? 'PASS' : 'FAIL',
    passed,
    exitCode: result.code,
    expectedExitCode: gate.expectedExitCode,
    signal: result.signal,
    error: result.error,
    mutatedVerificationTree: mutated,
    reason: mutated ? 'The gate mutated its verification worktree; its result is not trusted.' : undefined,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
    durationMs: result.durationMs,
    startedAt,
    endedAt,
    stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr),
    stdout: outputPreview(result.stdout),
    stderr: outputPreview(result.stderr),
  };
}

async function verificationInputPlan({ repoRoot, baseSha, seal, policy }) {
  const listed = await git(['ls-tree', '-r', '--name-only', baseSha], { cwd: repoRoot });
  const basePaths = listed.stdout.split(/\r?\n/).filter(Boolean).map(normalizePath);
  const patterns = policy.verificationInputs ?? [];
  const searchableCommands = (policy.gates ?? []).flatMap((gate) => [
    ...(Array.isArray(gate.command) ? gate.command : [gate.command]),
    ...(gate.argv ?? []),
    ...(gate.args ?? []),
  ]).filter(Boolean).join(' ');
  let packageScripts = '';
  try {
    const raw = await readBaseFile(repoRoot, baseSha, 'package.json');
    packageScripts = Object.values(JSON.parse(raw ?? '{}').scripts ?? {}).join(' ');
  } catch {}
  const baseInputs = new Set(basePaths.filter((filePath) => (
    isTestPath(filePath)
    || patterns.some((pattern) => matchesPathPattern(filePath, pattern))
    || packageScripts.includes(filePath)
    || packageScripts.includes(`./${filePath}`)
    || searchableCommands.includes(filePath)
  )));
  const restore = [];
  const remove = [];
  for (const file of seal.changedFiles) {
    const filePath = normalizePath(file.path);
    const oldPath = file.oldPath ? normalizePath(file.oldPath) : null;
    if (oldPath && baseInputs.has(oldPath)) {
      restore.push(oldPath);
      if (filePath !== oldPath) remove.push(filePath);
    } else if (baseInputs.has(filePath)) restore.push(filePath);
    else if (file.status === 'A' && (isTestPath(filePath) || patterns.some((pattern) => matchesPathPattern(filePath, pattern)))) remove.push(filePath);
  }
  return { restore: [...new Set(restore)].sort(), remove: [...new Set(remove)].sort() };
}

async function restoreVerificationInputs({ verificationPath, baseSha, plan }) {
  for (let index = 0; index < plan.restore.length; index += 100) {
    await git(['checkout', baseSha, '--', ...plan.restore.slice(index, index + 100)], { cwd: verificationPath });
  }
  for (const relativePath of plan.remove) {
    const resolved = path.resolve(verificationPath, relativePath);
    if (!isWithin(verificationPath, resolved) || path.resolve(verificationPath) === resolved) throw new Error('Refusing to remove an unsafe verification input path.');
    const [rootRealPath, parentRealPath] = await Promise.all([realpath(verificationPath), realpath(path.dirname(resolved))]);
    if (!isWithin(rootRealPath, parentRealPath)) throw new Error('Refusing to remove a verification input through an escaping symlink.');
    await rm(resolved, { recursive: true, force: true });
  }
}

async function prepareVerificationSuite({ verificationPath, baseSha, patchPath, seal, plan, policy, suite, gateId, signal }) {
  throwIfAborted(signal);
  const safeRoot = path.resolve(os.tmpdir(), 'vrn');
  if (!isWithin(safeRoot, verificationPath) || path.resolve(verificationPath) === safeRoot) {
    throw new Error('Refusing to reset a verification worktree outside the Verenne cache.');
  }
  await git(['reset', '--hard', baseSha], { cwd: verificationPath });
  await git(['clean', '-fdx'], { cwd: verificationPath });
  if (seal.patch.trim()) {
    const applied = await git(['apply', '--binary', '--whitespace=nowarn', patchPath], {
      cwd: verificationPath,
      allowFailure: true,
      timeoutMs: 180_000,
      maxOutputBytes: 2_000_000,
    });
    if (applied.code !== 0) throw new Error(`Candidate patch could not be replayed on its sealed base: ${outputPreview(applied.stderr || applied.stdout, 4_000)}`);
  }
  if (suite === 'baseline') await restoreVerificationInputs({ verificationPath, baseSha, plan });
  const prepared = await runBootstrapSteps(policy.bootstrap, verificationPath, { credentials: suite === 'baseline', signal });
  const results = prepared.results.map((item) => ({ ...item, id: `${item.id}:${suite}:${gateId}`, suite, gateId }));
  if (!prepared.ok) throw new Error(`${suite === 'baseline' ? 'Baseline' : 'Candidate'} dependency bootstrap failed at ${prepared.failed.label}.`);
  return results;
}

async function removeVerificationWorktree(repoRoot, verificationPath) {
  const safeRoot = path.resolve(os.tmpdir(), 'vrn');
  if (!isWithin(safeRoot, verificationPath) || path.resolve(verificationPath) === safeRoot) return false;
  const result = await git(['worktree', 'remove', '--force', verificationPath], { cwd: repoRoot, allowFailure: true, timeoutMs: 180_000 });
  return result.code === 0;
}

export async function replayTrustedGates({ repoRoot, baseSha, seal, policyBundle, mission, lane, signal }) {
  throwIfAborted(signal);
  const policy = policyBundle?.policy ?? policyBundle ?? {};
  const gates = (policy.gates ?? []).map(normalizeGate);
  if (gates.length === 0) return { gates: [], verification: { status: 'SKIPPED', reason: 'No base-owned gates configured.' } };

  const missionId = mission?.id ?? mission?.missionId ?? 'mission';
  const laneId = lane?.id ?? lane?.laneId ?? lane?.agentId ?? 'candidate';
  const verificationLane = `${laneId}-verify-${seal.diffDigest.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const patchPath = path.join(os.tmpdir(), `verenne-${randomUUID()}.patch`);
  let verificationPath;
  let bootstrap = { ok: true, results: [] };

  try {
    for (const entry of policyBundle?.toolchain ?? []) {
      const executable = resolveTrustedExecutable(entry.command, process.env, repoRoot);
      if (path.resolve(executable) !== path.resolve(entry.executable) || sha256(await readFile(executable)) !== entry.digest) {
        throw new Error(`Trusted toolchain entry changed after mission start: ${entry.command}.`);
      }
    }
    await writeFile(patchPath, seal.patch, 'utf8');
    verificationPath = await createWorktree(repoRoot, `${missionId}-verification`, verificationLane, baseSha);
    const results = [];
    const plan = await verificationInputPlan({ repoRoot, baseSha, seal, policy });
    for (const gate of gates) {
      throwIfAborted(signal);
      bootstrap.results.push(...await prepareVerificationSuite({ verificationPath, baseSha, patchPath, seal, plan, policy, suite: 'candidate', gateId: gate.id, signal }));
      results.push(await runOneGate(gate, verificationPath, publicBinding(seal), 'candidate', signal));
    }
    if (plan.restore.length > 0 || plan.remove.length > 0) {
      for (const gate of gates) {
        throwIfAborted(signal);
        bootstrap.results.push(...await prepareVerificationSuite({ verificationPath, baseSha, patchPath, seal, plan, policy, suite: 'baseline', gateId: gate.id, signal }));
        results.push(await runOneGate(gate, verificationPath, publicBinding(seal), 'baseline', signal));
      }
    }
    return {
      gates: results,
      bootstrap: bootstrap.results,
      verification: {
        id: 'verification-setup',
        kind: 'verification-setup',
        trust: EVIDENCE_TRUST.REPLAYED,
        status: 'PASS',
        passed: true,
        candidateBinding: publicBinding(seal),
      },
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw createAbortError(signal?.reason ?? error);
    return {
      gates: gates.map((gate) => ({
        id: `gate:${gate.id}`,
        kind: 'gate-replay',
        trust: EVIDENCE_TRUST.REPLAYED,
        gateId: gate.id,
        gateKind: gate.kind,
        label: gate.label,
        required: gate.required,
        claimKinds: gate.claimKinds,
        status: 'ERROR',
        passed: false,
        reason: `Verification replay failed: ${error.message}`,
        candidateBinding: publicBinding(seal),
      })),
      bootstrap: bootstrap.results,
      verification: {
        id: 'verification-setup',
        kind: 'verification-setup',
        trust: EVIDENCE_TRUST.REPLAYED,
        status: 'ERROR',
        passed: false,
        reason: error.message,
        candidateBinding: publicBinding(seal),
      },
    };
  } finally {
    try { await unlink(patchPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (verificationPath) await removeVerificationWorktree(repoRoot, verificationPath);
  }
}

function declaredArtifactItems(agentResult) {
  const values = [
    ...(agentResult?.visualEvidence ?? []),
    ...(agentResult?.screenshots ?? []),
    ...(agentResult?.artifacts ?? []),
  ];
  const seen = new Set();
  return values.filter((value) => {
    const key = typeof value === 'string' ? value : value?.path ?? value?.file ?? value?.uri;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function threeByteLittleEndian(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return {};
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    if (marker === 0xd8 || marker === 0xd9) { offset += 1; continue; }
    if (offset + 2 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset + 1);
    if (length < 2 || offset + length >= buffer.length) break;
    if (startOfFrame.has(marker) && offset + 7 < buffer.length) {
      return { height: buffer.readUInt16BE(offset + 4), width: buffer.readUInt16BE(offset + 6) };
    }
    offset += length + 1;
  }
  return {};
}

function inspectArtifactContent(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();
  const ascii = (start, end) => content.subarray(start, end).toString('ascii');
  if (content.length >= 24 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/png', width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
  }
  if (content.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/gif', width: content.readUInt16LE(6), height: content.readUInt16LE(8) };
  }
  if (content.length >= 4 && content[0] === 0xff && content[1] === 0xd8) {
    return { artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/jpeg', ...jpegDimensions(content) };
  }
  if (content.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    let dimensions = {};
    if (chunk === 'VP8X') dimensions = { width: threeByteLittleEndian(content, 24) + 1, height: threeByteLittleEndian(content, 27) + 1 };
    if (chunk === 'VP8 ' && content.length >= 30 && content[23] === 0x9d && content[24] === 0x01 && content[25] === 0x2a) {
      dimensions = { width: content.readUInt16LE(26) & 0x3fff, height: content.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && content.length >= 25 && content[20] === 0x2f) {
      dimensions = {
        width: 1 + content[21] + ((content[22] & 0x3f) << 8),
        height: 1 + ((content[22] & 0xc0) >> 6) + (content[23] << 2) + ((content[24] & 0x0f) << 10),
      };
    }
    return { artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/webp', ...dimensions };
  }

  const prefix = content.subarray(0, Math.min(content.length, 131_072)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (extension === '.svg' && /^<svg\b/i.test(prefix)) {
    const opening = prefix.match(/^<svg\b[^>]*>/i)?.[0] ?? '';
    const width = Number.parseFloat(opening.match(/\bwidth\s*=\s*["']\s*([0-9.]+)/i)?.[1]);
    const height = Number.parseFloat(opening.match(/\bheight\s*=\s*["']\s*([0-9.]+)/i)?.[1]);
    const viewBox = opening.match(/\bviewBox\s*=\s*["']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
    return {
      artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/svg+xml',
      width: Number.isFinite(width) ? width : Number.parseFloat(viewBox?.[1]),
      height: Number.isFinite(height) ? height : Number.parseFloat(viewBox?.[2]),
    };
  }
  if (content.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return { artifactKind: 'visual', mediaKind: 'image', mimeType: 'image/avif' };
    return { artifactKind: 'visual', mediaKind: 'video', mimeType: 'video/mp4' };
  }
  if (content.length >= 4 && content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { artifactKind: 'visual', mediaKind: 'video', mimeType: 'video/webm' };
  }
  if (['.json', '.jsonl', '.xml', '.tap'].includes(extension)) return { artifactKind: 'structured' };
  return { artifactKind: 'file' };
}

export async function collectDeclaredArtifactEvidence({ agentResult, artifactDir, worktreePath, seal }) {
  const roots = [worktreePath, artifactDir].filter(Boolean).map((root) => path.resolve(root));
  const result = [];
  let index = 0;
  for (const item of declaredArtifactItems(agentResult)) {
    index += 1;
    const supplied = typeof item === 'string' ? item : item.path ?? item.file ?? item.uri;
    const declaredKind = typeof item === 'object' ? item.kind ?? item.type : null;
    if (/^[a-z]+:\/\//i.test(supplied)) {
      result.push({
        id: `artifact:${index}`,
        kind: 'artifact',
        artifactKind: 'file',
        declaredArtifactKind: declaredKind,
        trust: EVIDENCE_TRUST.UNTRUSTED,
        status: 'UNVERIFIED',
        path: supplied,
        reason: 'Remote artifacts are not accepted as local candidate-bound evidence.',
        candidateBinding: publicBinding(seal),
      });
      continue;
    }

    const candidates = path.isAbsolute(supplied)
      ? [path.resolve(supplied)]
      : [artifactDir && path.resolve(artifactDir, supplied), path.resolve(worktreePath, supplied)].filter(Boolean);
    const safeCandidates = candidates.filter((candidate) => roots.some((root) => isWithin(root, candidate)));
    let resolved = null;
    for (const candidate of safeCandidates) {
      try {
        const metadata = await stat(candidate);
        if (metadata.isFile()) {
          resolved = candidate;
          break;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    resolved ??= safeCandidates[0];
    if (!resolved) {
      result.push({
        id: `artifact:${index}`,
        kind: 'artifact',
        artifactKind: 'file',
        declaredArtifactKind: declaredKind,
        trust: EVIDENCE_TRUST.UNTRUSTED,
        status: 'REJECTED',
        path: supplied,
        reason: 'Artifact path escapes the candidate or artifact directory.',
        candidateBinding: publicBinding(seal),
      });
      continue;
    }

    try {
      const resolvedRealPath = await realpath(resolved);
      const allowedRoots = [worktreePath, artifactDir].filter(Boolean);
      const insideAllowedRoot = await Promise.all(allowedRoots.map(async (root) => {
        try { return isWithin(await realpath(root), resolvedRealPath); } catch { return false; }
      }));
      if (!insideAllowedRoot.some(Boolean)) throw new Error('Artifact resolves outside the candidate or artifact directory.');
      const metadata = await stat(resolvedRealPath);
      if (!metadata.isFile()) throw new Error('Artifact is not a file.');
      if (metadata.size > 25_000_000) throw new Error('Artifact exceeds the 25 MB evidence limit.');
      const content = await readFile(resolvedRealPath);
      const inspection = inspectArtifactContent(resolvedRealPath, content);
      const claimsVisual = /(?:visual|image|video|screenshot)/i.test(String(declaredKind ?? ''));
      if (claimsVisual && inspection.artifactKind !== 'visual') {
        result.push({
          id: `artifact:${index}`,
          kind: 'artifact',
          artifactKind: inspection.artifactKind,
          declaredArtifactKind: declaredKind,
          trust: EVIDENCE_TRUST.UNTRUSTED,
          status: 'REJECTED',
          path: supplied,
          reason: 'The declared visual artifact does not contain a recognized image or video format.',
          candidateBinding: publicBinding(seal),
        });
        continue;
      }
      result.push({
        id: `artifact:${index}`,
        kind: 'artifact',
        ...inspection,
        declaredArtifactKind: declaredKind,
        trust: EVIDENCE_TRUST.OBSERVED,
        status: 'PASS',
        path: normalizePath(path.relative(artifactDir && isWithin(artifactDir, resolved) ? artifactDir : worktreePath, resolved)),
        size: metadata.size,
        digest: sha256(content),
        candidateBinding: publicBinding(seal),
      });
    } catch (error) {
      result.push({
        id: `artifact:${index}`,
        kind: 'artifact',
        artifactKind: 'file',
        declaredArtifactKind: declaredKind,
        trust: EVIDENCE_TRUST.UNTRUSTED,
        status: 'MISSING',
        path: supplied,
        reason: error.message,
        candidateBinding: publicBinding(seal),
      });
    }
  }
  return result;
}

function agentAllegationEvidence(agentResult, seal) {
  return (agentResult?.tests ?? []).map((test, index) => ({
    id: `agent-allegation:${index + 1}`,
    kind: 'agent-allegation',
    trust: EVIDENCE_TRUST.UNTRUSTED,
    status: 'UNVERIFIED',
    command: typeof test === 'string' ? test : test.command,
    allegedExitCode: typeof test === 'object' ? test.exitCode : undefined,
    reason: 'Reported by the candidate agent; it is not replay evidence.',
    candidateBinding: publicBinding(seal),
  }));
}

export async function collectCandidateEvidence({ repoRoot, worktreePath, baseSha, policyBundle, agentResult, mission, lane, artifactDir, signal }) {
  throwIfAborted(signal);
  const policy = policyBundle?.policy ?? policyBundle ?? {};
  const seal = await createCandidateSeal({ repoRoot, worktreePath, baseSha, policyBundle });
  const analysis = await analyzeCandidateDiff({
    repoRoot,
    worktreePath,
    baseSha,
    changedFiles: seal.changedFiles,
    diffText: seal.diffText,
    policy,
  });
  analysis.reservedChanges = seal.reservedChanges;
  const trustViolations = detectTrustViolations({ analysis, policyBundle, policy });
  const artifacts = await collectDeclaredArtifactEvidence({ agentResult, artifactDir, worktreePath, seal });
  const replay = await replayTrustedGates({ repoRoot, baseSha, seal, policyBundle, mission, lane, signal });
  const evidence = [
    {
      id: 'candidate-seal',
      kind: 'candidate-seal',
      trust: EVIDENCE_TRUST.OBSERVED,
      status: 'PASS',
      candidateBinding: publicBinding(seal),
    },
    {
      id: 'diff-analysis',
      kind: 'diff-analysis',
      trust: EVIDENCE_TRUST.OBSERVED,
      status: 'PASS',
      facts: analysis,
      candidateBinding: publicBinding(seal),
    },
    replay.verification,
    ...(replay.bootstrap ?? []).map((item) => ({ ...item, trust: EVIDENCE_TRUST.REPLAYED, candidateBinding: publicBinding(seal) })),
    ...replay.gates,
    ...artifacts,
    ...agentAllegationEvidence(agentResult, seal),
  ];
  return {
    seal,
    analysis,
    gates: replay.gates,
    evidence,
    trustViolations,
  };
}

// Compatibility surface for the first mission runner. The implementation
// remains separated in scoring.js so evidence collection can be tested alone.
export { evaluateCandidate, selectCandidate } from './scoring.js';
