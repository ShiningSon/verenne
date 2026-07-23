import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_BATCH_COMMANDS = new Set(['corepack', 'gradle', 'mvn', 'npm', 'npx', 'pnpm', 'yarn']);

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveTrustedExecutable(command, env = process.env, cwd) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  if (command.toLowerCase() === 'node' || command.toLowerCase() === 'node.exe') return process.execPath;
  const pathValue = env.PATH || env.Path || '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const suffixes = process.platform === 'win32' && path.extname(command) === '' ? extensions : [''];
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const unquoted = rawEntry.replace(/^"|"$/g, '');
    if (!unquoted || !path.isAbsolute(unquoted)) continue;
    const directory = path.resolve(unquoted);
    if (cwd && pathIsInside(cwd, directory)) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through trusted absolute PATH entries.
      }
    }
  }
  throw new Error(`Executable not found in an absolute trusted PATH entry: ${command}`);
}

function windowsLaunch(command, args, env) {
  if (process.platform !== 'win32') return { command, args };
  const extension = path.extname(command).toLowerCase();
  const bareName = path.basename(command, extension).toLowerCase();
  const isBatch = extension === '.cmd' || extension === '.bat';
  const needsBatchLookup = extension === '' && WINDOWS_BATCH_COMMANDS.has(bareName);
  if (!isBatch && !needsBatchLookup) return { command, args };
  const batchCommand = needsBatchLookup ? `${command}.cmd` : command;
  const allTokens = [batchCommand, ...args];
  for (const token of allTokens) {
    if (/[\0\r\n"%&|<>^]/u.test(token)) {
      throw new Error('A Windows batch adapter argument contains shell metacharacters. Use a native executable or a prompt-file adapter.');
    }
  }
  const commandLine = allTokens.map((token) => `"${token}"`).join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    await new Promise((resolve) => {
      const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { return; } }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* exited */ } }
}

function abortMessage(reason) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'Operation cancelled.';
}

export function createAbortError(reason) {
  if (reason instanceof Error && reason.code === 'ABORT_ERR') return reason;
  const error = new Error(abortMessage(reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason instanceof Error) error.cause = reason;
  return error;
}

export function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

export async function runProcess(command, args = [], options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;

  if (options.signal?.aborted) {
    return {
      command,
      args,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      abortReason: abortMessage(options.signal.reason),
      outputTruncated: false,
      durationMs: Date.now() - startedAt,
      code: null,
      signal: null,
      error: abortMessage(options.signal.reason),
    };
  }

  let launch;
  try {
    launch = windowsLaunch(resolveTrustedExecutable(command, options.env ?? process.env, options.cwd), args, options.env ?? process.env);
  } catch (error) {
    return { command, args, stdout: '', stderr: '', timedOut: false, aborted: false, outputTruncated: false, durationMs: Date.now() - startedAt, code: null, signal: null, error: error.message };
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let abortReason;
    let outputTruncated = false;
    let settled = false;
    let termination;

    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: launch.windowsVerbatimArguments ?? false,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    const append = (current, chunk, onChunk) => {
      const text = chunk.toString('utf8');
      onChunk?.(text);
      if (Buffer.byteLength(current) >= maxOutputBytes) {
        outputTruncated = true;
        return current;
      }
      const next = current + text;
      if (Buffer.byteLength(next) <= maxOutputBytes) return next;
      outputTruncated = true;
      return Buffer.from(next).subarray(0, maxOutputBytes).toString('utf8');
    };

    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk, options.onStdout); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk, options.onStderr); });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }

    const terminate = () => {
      termination ??= terminateProcessTree(child).catch(() => {});
      return termination;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      abortReason = abortMessage(options.signal?.reason);
      terminate();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (termination) await termination;
      resolve({
        command,
        args,
        stdout,
        stderr,
        timedOut,
        aborted,
        abortReason,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        ...result,
        error: aborted ? abortReason : result.error,
      });
    };

    child.on('error', (error) => finish({ code: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal, error: null }));
  });
}

export async function commandExists(command) {
  try {
    resolveTrustedExecutable(command);
    return true;
  } catch {
    return false;
  }
}
