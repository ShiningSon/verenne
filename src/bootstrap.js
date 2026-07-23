import { createAbortError, runProcess, throwIfAborted } from './process.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function bootstrapEnvironment(extra = {}, options = {}) {
  const allowed = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
    'TEMP', 'TMP', 'COREPACK_HOME',
  ]);
  if (options.credentials === true) {
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NPM_TOKEN', 'NPM_CONFIG_USERCONFIG']) allowed.add(key);
  }
  const environment = { CI: '1', VERENNE_BOOTSTRAP: '1' };
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) && value != null) environment[key] = value;
  for (const [key, value] of Object.entries(extra)) if (value != null) environment[key] = String(value);
  return environment;
}

function normalizeStep(value, index) {
  const argv = Array.isArray(value?.command) ? value.command.map(String) : [];
  if (argv.length === 0 || argv.some((item) => /[\0\r\n]/u.test(item))) {
    throw new Error(`Bootstrap step ${value?.id ?? index + 1} must use a non-empty argv command array.`);
  }
  return {
    id: String(value.id ?? `bootstrap-${index + 1}`),
    label: String(value.label ?? value.id ?? `Bootstrap ${index + 1}`),
    command: argv[0],
    args: argv.slice(1),
    required: value.required !== false,
    timeoutMs: Number(value.timeoutMs ?? 900_000),
    env: value.env ?? {},
  };
}

export async function runBootstrapSteps(steps, worktreePath, options = {}) {
  throwIfAborted(options.signal);
  const normalized = Array.isArray(steps) ? steps.map(normalizeStep) : [];
  const results = [];
  const isolatedHome = options.credentials === true ? null : await mkdtemp(path.join(os.tmpdir(), 'vrn-bootstrap-home-'));
  if (isolatedHome) await Promise.all([
    mkdir(path.join(isolatedHome, 'appdata'), { recursive: true }),
    mkdir(path.join(isolatedHome, 'localappdata'), { recursive: true }),
  ]);
  try {
    for (const step of normalized) {
      throwIfAborted(options.signal);
      const isolated = isolatedHome ? {
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        APPDATA: path.join(isolatedHome, 'appdata'),
        LOCALAPPDATA: path.join(isolatedHome, 'localappdata'),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_REPLACE_REGISTRY_HOST: 'always',
      } : {};
      const result = await runProcess(step.command, step.args, {
        cwd: worktreePath,
        timeoutMs: step.timeoutMs,
        maxOutputBytes: 1_000_000,
        env: bootstrapEnvironment({ ...step.env, ...isolated }, options),
        signal: options.signal,
      });
      if (result.aborted) throw createAbortError(result.abortReason);
      const passed = !result.timedOut && result.error == null && result.code === 0;
      results.push({
        id: `bootstrap:${step.id}`,
        kind: 'bootstrap',
        label: step.label,
        command: [step.command, ...step.args],
        required: step.required,
        credentialMode: options.credentials === true ? 'trusted-base' : 'isolated',
        status: result.timedOut || result.error ? 'ERROR' : passed ? 'PASS' : 'FAIL',
        passed,
        exitCode: result.code,
        timedOut: result.timedOut,
        error: result.error,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (!passed && step.required) break;
    }
  } finally {
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
  }
  const failed = results.find((item) => item.required && item.status !== 'PASS');
  return { ok: !failed, failed, results };
}
