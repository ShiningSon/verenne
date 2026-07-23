import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';
import { initializeProject, POLICY_FILE } from './config.js';
import { runMission } from './mission.js';
import { ensureDir, writeJson, writeText } from './utils.js';

async function seedDemoRepository(repoRoot) {
  await ensureDir(path.join(repoRoot, 'src'));
  await ensureDir(path.join(repoRoot, 'test'));
  await writeJson(path.join(repoRoot, 'package.json'), {
    name: 'verenne-arena-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  });
  await writeText(path.join(repoRoot, 'src', 'limiter.js'), [
    'export function allow() {',
    '  return true;',
    '}',
    '',
  ].join('\n'));
  await writeText(path.join(repoRoot, 'test', 'happy.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { allow } from '../src/limiter.js';",
    '',
    "test('allows an authenticated request', () => {",
    "  assert.equal(allow({ userId: 'a' }), true);",
    '});',
    '',
  ].join('\n'));
  await writeText(path.join(repoRoot, 'README.md'), [
    '# Rate limit demo service',
    '',
    'A tiny fixture used to demonstrate evidence-driven agent selection.',
    '',
  ].join('\n'));

  await git(['init', '-b', 'main'], { cwd: repoRoot });
  await git(['config', 'user.name', 'Verenne Demo'], { cwd: repoRoot });
  await git(['config', 'user.email', 'demo@example.invalid'], { cwd: repoRoot });
  await initializeProject(repoRoot);
  const policy = {
    schemaVersion: 1,
    protectedInputs: ['verenne.policy.json', 'package.json'],
    forbiddenPatterns: ['.env', '*.pem', '*.key'],
    gates: [
      { id: 'trusted-tests', label: 'Trusted authentication and rate-limit tests', command: [process.execPath, '--test'], required: true, claimKinds: ['tests_passed', 'no_breaking_changes', 'security_fixed', 'feature_implemented'], timeoutMs: 60_000 },
    ],
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
    scoring: { gates: 45, claims: 25, trust: 15, scope: 10, efficiency: 5 },
  };
  await writeJson(path.join(repoRoot, POLICY_FILE), policy);
  await git(['add', '--', '.'], { cwd: repoRoot });
  await git(['commit', '-m', 'seed demo service'], { cwd: repoRoot });
}

export async function runDemo(options = {}) {
  let repoRoot = options.repoRoot;
  let temporary = false;
  if (!repoRoot) {
    const parent = options.outputRoot
      ? await ensureDir(path.resolve(options.outputRoot))
      : os.tmpdir();
    repoRoot = await mkdtemp(path.join(parent, 'verenne-demo-'));
    temporary = !options.keep;
  } else {
    repoRoot = path.resolve(repoRoot);
    await ensureDir(repoRoot);
    const entries = await readdir(repoRoot);
    if (entries.length > 0) throw new Error('The demo target must be an empty directory. Verenne refuses to overwrite or absorb an existing project.');
  }

  await seedDemoRepository(repoRoot);
  const result = await runMission({
    repoRoot,
    task: 'Implement per-user rate limiting.\nPreserve existing authentication behavior.\nAdd a regression test.',
    title: 'Per-user rate limiting',
    mode: 'arena',
    agents: ['sprinter', 'builder', 'drifter'],
    demo: true,
    signal: options.signal,
  });

  // Demo repos are intentionally retained when an output root is supplied so every patch can be inspected.
  if (temporary && options.cleanup) await rm(repoRoot, { recursive: true, force: true });
  return { ...result, repoRoot };
}
