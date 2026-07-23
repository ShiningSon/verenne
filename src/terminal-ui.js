import readline from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { APP_NAME, formatDuration, terminalWidth } from './utils.js';
import { inspectAdapters, rankAdapterRows } from './adapters.js';
import { loadConfig } from './config.js';
import { findRepoRoot } from './git.js';
import { runMission } from './mission.js';
import { createAbortError, throwIfAborted } from './process.js';

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[38;5;81m',
  violet: '\x1b[38;5;141m',
  green: '\x1b[38;5;84m',
  yellow: '\x1b[38;5;221m',
  red: '\x1b[38;5;203m',
});

function palette(stream) {
  if (stream?.isTTY && !process.env.NO_COLOR) return ANSI;
  return Object.fromEntries(Object.keys(ANSI).map((key) => [key, '']));
}

function rule(stream, character = '─') {
  const width = Math.max(72, Math.min(140, stream?.columns || terminalWidth()));
  return character.repeat(width);
}

function printHeader(stream) {
  const color = palette(stream);
  stream.write(`\n${color.violet}${color.bold}${APP_NAME}${color.reset}  ${color.dim}multi-agent coding, decided by evidence${color.reset}\n`);
  stream.write(`${color.dim}${rule(stream)}${color.reset}\n`);
}

function resolveEnteredPath(value, cwd = process.cwd()) {
  let entered = String(value ?? '').trim();
  const quoted = (entered.startsWith('"') && entered.endsWith('"'))
    || (entered.startsWith("'") && entered.endsWith("'"));
  if (quoted && entered.length >= 2) entered = entered.slice(1, -1).trim();
  if (entered === '~') entered = os.homedir();
  else if (entered.startsWith('~/') || entered.startsWith('~\\')) entered = path.join(os.homedir(), entered.slice(2));
  return entered ? path.resolve(cwd, entered) : '';
}

function displayPath(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?');
}

export async function resolveSessionRepoRoot(options = {}) {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const interactive = options.interactive ?? Boolean(input?.isTTY && output?.isTTY);
  const findRoot = options.findRepoRoot ?? findRepoRoot;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitlyRequested = options.repoRoot !== undefined && options.repoRoot !== null && String(options.repoRoot).trim() !== '';
  const initialPath = resolveEnteredPath(explicitlyRequested ? options.repoRoot : cwd, cwd);

  try {
    return await findRoot(initialPath);
  } catch {
    if (explicitlyRequested) {
      throw new Error(`Cannot open Git project at "${displayPath(initialPath)}". Choose a folder inside an existing Git repository.`);
    }
    if (!interactive) {
      throw new Error(`No Git project is open in "${displayPath(cwd)}". Run this command inside a repository or run it again with --repo <path>.`);
    }
  }

  const color = palette(output);
  output.write(`\n${color.yellow}${color.bold}No Git project is open in this folder.${color.reset}\n`);
  output.write(`${color.dim}Enter a repository folder (you can drag the folder here), or press Enter to exit.${color.reset}\n`);
  const createInterface = options.createInterface ?? ((streams) => readline.createInterface(streams));
  const ownsInterface = !options.readlineInterface;
  const rl = options.readlineInterface ?? createInterface({ input, output });
  try {
    while (true) {
      throwIfAborted(options.signal);
      let entered;
      try {
        entered = await rl.question(`${color.cyan}Project folder${color.reset}\n${color.cyan}>${color.reset} `, { signal: options.signal });
      } catch (error) {
        if (error?.code !== 'ERR_USE_AFTER_CLOSE') throw error;
        output.write(`${color.dim}No project selected; nothing was changed.${color.reset}\n`);
        return null;
      }
      const candidate = resolveEnteredPath(entered, cwd);
      if (!candidate) {
        output.write(`${color.dim}No project selected; nothing was changed.${color.reset}\n`);
        return null;
      }
      try {
        const repoRoot = await findRoot(candidate);
        output.write(`${color.green}Opened${color.reset}  ${displayPath(repoRoot)}\n`);
        return repoRoot;
      } catch {
        output.write(`${color.yellow}Not a Git repository:${color.reset} ${displayPath(candidate)}\n`);
        output.write(`${color.dim}Choose a folder inside an existing Git repository.${color.reset}\n`);
      }
    }
  } finally {
    if (ownsInterface) rl.close();
  }
}

function verdictColor(value, color) {
  if (value === 'PROVEN' || value === 'ELIGIBLE' || value === 'READY') return color.green;
  if (value === 'CONTRADICTED' || value === 'BLOCKED' || value === 'NO_WINNER') return color.red;
  return color.yellow;
}

function candidateEligibility(candidate) {
  if (candidate.eligibilityStatus) return candidate.eligibilityStatus;
  if (typeof candidate.eligibility === 'string') return candidate.eligibility.toUpperCase();
  if (candidate.eligibility && typeof candidate.eligibility === 'object') return candidate.eligibility.eligible ? 'ELIGIBLE' : 'BLOCKED';
  return 'REVIEW';
}

export function formatAdapterChoice(row) {
  const tuning = row.tuning ?? {};
  const settings = [];
  if (tuning.model) settings.push(tuning.model);
  if (tuning.effort) settings.push(`${tuning.effort} effort`);
  if (tuning.variant) settings.push(`${tuning.variant} variant`);
  return `${row.label ?? row.id} — ${settings.length ? settings.join(' · ') : 'provider-native default'}`;
}

export function selectAvailableAdapters(config, inspected) {
  const available = rankAdapterRows(inspected.filter((row) => row.available), config);
  if (!available.length) return [];
  const configuredCount = (config.defaultAgents ?? []).length;
  const concurrency = Math.max(1, Number(config.concurrency ?? 3));
  const desired = configuredCount > 0 ? Math.min(configuredCount, concurrency) : concurrency;
  return available.slice(0, Math.min(desired, available.length));
}

function printAdapterPlan(stream, config, inspected, selected, profileName) {
  const color = palette(stream);
  const detected = inspected.filter((row) => row.available);
  const selectedIds = new Set(selected.map((row) => row.id));
  const profile = profileName ? `${profileName} profile` : 'provider-native settings';
  stream.write(`\n${color.green}Ready${color.reset}  ${selected.length} agent${selected.length === 1 ? '' : 's'} selected from ${detected.length} detected · ${profile}\n`);
  for (const row of selected) stream.write(`  ${color.green}●${color.reset} ${formatAdapterChoice(row)}\n`);
  const standby = detected.filter((row) => !selectedIds.has(row.id));
  if (standby.length) stream.write(`  ${color.dim}○ Standby: ${standby.map((row) => row.label ?? row.id).join(', ')}${color.reset}\n`);
  stream.write(`${color.dim}Arena separates attempts with Git worktrees; Verenne never applies a winner automatically. Agent CLIs still use your OS permissions.${color.reset}\n`);
}

function printNoAdapters(stream, inspected) {
  const color = palette(stream);
  stream.write(`\n${color.yellow}${color.bold}No supported agent CLI was detected on PATH.${color.reset}\n`);
  const suggestions = inspected.slice(0, 3);
  for (const row of suggestions) stream.write(`  ${color.dim}• ${row.reason}${color.reset}\n`);
  stream.write(`\nInstall and sign in to at least one agent, then run ${color.bold}verenne doctor${color.reset}. Existing provider logins and model access are reused.\n`);
}

export async function readTaskInput(stream, maxBytes = 1_000_000, signal) {
  throwIfAborted(signal);
  let task = '';
  const onAbort = () => stream.destroy?.(createAbortError(signal.reason));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      task += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(task) > maxBytes) throw new Error(`Task input exceeds the ${maxBytes}-byte safety limit.`);
    }
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return task.trim();
}

function progressReporter(stream) {
  const color = palette(stream);
  const animated = stream?.isTTY && !process.env.CI && !process.env.NO_COLOR;
  const frames = ['◐', '◓', '◑', '◒'];
  let timer;
  let frame = 0;
  let startedAt = 0;
  const message = 'Agents are working in isolated worktrees; independent replay follows';
  const render = () => stream.write(`\r\x1b[2K${color.violet}${frames[frame++ % frames.length]}${color.reset} ${message}`);
  return {
    start() {
      startedAt = Date.now();
      if (!animated) {
        stream.write(`\n${message}…\n`);
        return;
      }
      stream.write('\n');
      render();
      timer = setInterval(render, 180);
      timer.unref?.();
    },
    success() {
      if (timer) clearInterval(timer);
      const elapsed = formatDuration(Date.now() - startedAt);
      if (animated) stream.write(`\r\x1b[2K${color.green}✓${color.reset} Evidence replay complete ${color.dim}(${elapsed})${color.reset}\n`);
      else stream.write(`Evidence replay complete (${elapsed}).\n`);
    },
    fail(messageText) {
      if (timer) clearInterval(timer);
      if (animated) stream.write(`\r\x1b[2K${color.red}×${color.reset} ${messageText}\n`);
      else stream.write(`Mission stopped: ${messageText}\n`);
    },
  };
}

export function printMissionSummary(mission, options = {}) {
  const stream = options.output ?? defaultOutput;
  const color = palette(stream);
  const candidates = mission.candidates ?? [];
  const winner = candidates.find((candidate) => candidate.id === mission.decision?.selectedCandidateId);
  const status = mission.decision?.status ?? mission.status ?? 'UNKNOWN';
  stream.write(`\n${color.dim}${rule(stream)}${color.reset}\n`);
  stream.write(`${verdictColor(status, color)}${color.bold}${status}${color.reset}`);
  if (winner) stream.write(`  ${winner.label} selected by evidence`);
  stream.write('\n');
  if (mission.decision?.reasons?.length) stream.write(`${color.dim}${mission.decision.reasons.join(' · ')}${color.reset}\n`);
  stream.write('\n');
  for (const candidate of candidates) {
    const counts = candidate.claimCounts ?? {};
    const eligibility = candidateEligibility(candidate);
    const marker = candidate.id === winner?.id ? '◆' : '·';
    const runtime = candidate.process?.timedOut
      ? `${color.red}timed out${color.reset}`
      : candidate.process?.exitCode != null && candidate.process.exitCode !== 0
        ? `${color.red}provider exit ${candidate.process.exitCode}${color.reset}`
        : '';
    stream.write(`${marker} ${String(candidate.label ?? candidate.id).padEnd(20)} ${verdictColor(eligibility, color)}${eligibility.padEnd(11)}${color.reset} `);
    stream.write(`${color.green}${counts.proven ?? 0} proven${color.reset}  ${color.red}${counts.contradicted ?? 0} contradicted${color.reset}  ${color.yellow}${counts.unproven ?? 0} unproven${color.reset}`);
    if (runtime) stream.write(`  ${runtime}`);
    stream.write('\n');
  }
  stream.write('\n');
  if (mission.artifacts?.html) stream.write(`${color.dim}Case file: ${mission.artifacts.html}${color.reset}\n`);
  if (winner) stream.write(`${color.dim}Review the sealed patch and case file, then apply it when ready.${color.reset}\n`);
}

export async function interactiveSession(options = {}) {
  throwIfAborted(options.signal);
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const interactive = options.interactive ?? Boolean(input?.isTTY && output?.isTTY);
  const load = options.loadConfig ?? loadConfig;
  const inspect = options.inspectAdapters ?? inspectAdapters;
  const run = options.runMission ?? runMission;
  const rl = interactive ? readline.createInterface({ input, output }) : null;
  let repoRoot;
  let profile;
  let selected;
  let task = String(options.task ?? '').trim();
  try {
    if (interactive) printHeader(output);
    repoRoot = await resolveSessionRepoRoot({
      input,
      output,
      interactive,
      repoRoot: options.repoRoot,
      cwd: options.cwd,
      findRepoRoot: options.findRepoRoot,
      readlineInterface: rl,
      signal: options.signal,
    });
    if (!repoRoot) return null;
    if (!interactive) printHeader(output);
    const config = await load(repoRoot);
    profile = options.profile ?? (config.profiles?.frontier ? 'frontier' : undefined);

    output.write(`${palette(output).dim}Detecting compatible coding agents and provider-native model access…${palette(output).reset}\n`);
    const inspected = await inspect(config, Object.keys(config.adapters ?? {}), { profile, signal: options.signal });
    selected = selectAvailableAdapters(config, inspected);
    if (!selected.length) {
      printNoAdapters(output, inspected);
      return null;
    }
    printAdapterPlan(output, config, inspected, selected, profile);

    if (!task && interactive) {
      task = (await rl.question(`\n${palette(output).cyan}What should Verenne change?${palette(output).reset}\n${palette(output).cyan}›${palette(output).reset} `, { signal: options.signal })).trim();
    } else if (!task) {
      task = await readTaskInput(input, 1_000_000, options.signal);
    }
  } finally {
    rl?.close();
  }

  if (!task) {
    if (interactive) {
      output.write(`${palette(output).dim}No task entered; nothing was changed.${palette(output).reset}\n`);
      return null;
    }
    throw new Error('No task was received on stdin. Pipe a task to verenne, or use `verenne run "<task>"`.');
  }

  const progress = progressReporter(output);
  progress.start();
  try {
    const result = await run({
      repoRoot,
      task,
      mode: options.mode ?? 'arena',
      agents: selected.map((row) => row.id),
      profile,
      model: options.model,
      effort: options.effort,
      variant: options.variant,
      signal: options.signal,
    });
    progress.success();
    printMissionSummary(result.mission, { output });
    return result;
  } catch (error) {
    progress.fail(error.message);
    throw error;
  }
}
