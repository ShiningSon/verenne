import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { APP_NAME, CLI_NAME, VERSION, parseList, readJson } from './utils.js';
import { initializeProject, loadConfig } from './config.js';
import { findRepoRoot, git } from './git.js';
import { inspectAdapters } from './adapters.js';
import { applyMissionWinner, runMission, verifyCurrentPatch } from './mission.js';
import { runDemo } from './demo.js';
import { interactiveSession, printMissionSummary } from './terminal-ui.js';
import { latestMissionId, loadMission, missionDir, readEvents, stateRoot } from './state.js';
import { createMemoryStore } from './memory.js';
import { startMcpServer } from './mcp.js';
import { startDashboardServer } from './server.js';
import { writeReportArtifacts } from './report.js';
import { cleanupMissionWorktrees } from './maintenance.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '-h') { flags.help = true; continue; }
    if (value === '-v') { flags.version = true; continue; }
    if (value === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const equals = value.indexOf('=');
    const name = value.slice(2, equals >= 0 ? equals : undefined);
    if (name.startsWith('no-') && equals < 0) { flags[name.slice(3)] = false; continue; }
    let next = equals >= 0 ? value.slice(equals + 1) : argv[index + 1];
    if (equals < 0 && (next === undefined || next.startsWith('--'))) next = true;
    else if (equals < 0) index++;
    if (flags[name] === undefined) flags[name] = next;
    else flags[name] = Array.isArray(flags[name]) ? [...flags[name], next] : [flags[name], next];
  }
  return { positional, flags };
}

function help() {
  return `${APP_NAME} ${VERSION}

  Many agents. Isolated work. Evidence decides what ships.

USAGE
  ${CLI_NAME}                         Open the interactive coding session
  ${CLI_NAME} run "<task>"            Run an evidence-driven agent mission
  ${CLI_NAME} demo                    Optional zero-key product tour
  ${CLI_NAME} init                    Add project config and protected policy
  ${CLI_NAME} doctor                  Detect Git, Node, and agent adapters
  ${CLI_NAME} status [mission-id]     Show the latest or selected decision
  ${CLI_NAME} dashboard [mission-id]  Open the terminal-first command center
  ${CLI_NAME} report [mission-id]     Rebuild the standalone case file
  ${CLI_NAME} verify                  Verify the current patch without an agent
  ${CLI_NAME} apply [mission-id]      Apply the sealed winner to a clean worktree
  ${CLI_NAME} clean [mission-id]      Remove sealed temporary worktrees
  ${CLI_NAME} memory add|search|list  Manage local project memory
  ${CLI_NAME} mcp                     Serve MCP tools over stdio

RUN OPTIONS
  --mode arena|swarm|relay   Same task race, task DAG, or role handoff
  --agents claude,codex      Any configured CLI adapters
  --profile frontier         Use the built-in frontier configuration
  --model claude=opus        Pass any provider-native model ID
  --effort codex=xhigh       Pass provider-native reasoning effort
  --base <ref>               Trusted base commit (default: HEAD)
  --plan <file.json>         Task DAG for swarm mode
  --repo <path>              Target Git repository

EXAMPLES
  ${CLI_NAME} run "Fix the auth race and add a regression test" --profile frontier
  ${CLI_NAME} run "Ship the release" --mode relay --agents claude,codex
  ${CLI_NAME} apply latest --commit
`;
}

async function resolveRoot(flag) {
  return await findRepoRoot(flag ? path.resolve(String(flag)) : process.cwd());
}

function flagNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flagAssignments(value) {
  const output = {};
  for (const item of parseList(value)) {
    const equals = item.indexOf('=');
    if (equals < 0) output['*'] = item;
    else {
      const key = item.slice(0, equals).trim();
      const selected = item.slice(equals + 1).trim();
      if (!key || !selected) throw new Error(`Invalid assignment: ${item}`);
      output[key] = selected;
    }
  }
  return output;
}

async function loadTasks(planPath) {
  if (!planPath) return undefined;
  const plan = await readJson(path.resolve(String(planPath)));
  return plan.tasks ?? plan.nodes ?? plan;
}

async function commandInit(flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const result = await initializeProject(repoRoot, { force: flags.force === true });
  process.stdout.write(`${APP_NAME} initialized in ${repoRoot}\n`);
  process.stdout.write(result.created.length ? `Created: ${result.created.join(', ')}\n` : 'Configuration already exists.\n');
  process.stdout.write('Commit the config and policy so future agents cannot rewrite their own rules.\n');
}

async function commandDoctor(flags, options = {}) {
  const repoRoot = flags.repo
    ? await resolveRoot(flags.repo)
    : await findRepoRoot(process.cwd()).catch(() => process.cwd());
  const config = await loadConfig(repoRoot);
  const nodeOk = Number.parseInt(process.versions.node.split('.')[0], 10) >= 20;
  const gitVersion = await git(['--version'], { cwd: repoRoot, allowFailure: true });
  const adapters = await inspectAdapters(config, Object.keys(config.adapters ?? {}), { profile: 'frontier', probeVersion: true, signal: options.signal });
  process.stdout.write(`${APP_NAME} doctor\n\n`);
  process.stdout.write(`${nodeOk ? '✓' : '✗'} Node ${process.versions.node} ${nodeOk ? '' : '(20+ required)'}\n`);
  process.stdout.write(`${gitVersion.code === 0 ? '✓' : '✗'} ${gitVersion.stdout.trim() || 'Git unavailable'}\n`);
  for (const adapter of adapters) {
    const capabilities = adapter.capabilities ?? {};
    const tuning = [capabilities.model && 'model', capabilities.effort && 'effort', capabilities.variant && 'variant'].filter(Boolean).join('/');
    const detail = adapter.available ? `${adapter.version ?? adapter.command}${tuning ? ` · ${tuning}` : ''}` : 'not detected';
    process.stdout.write(`${adapter.available ? '✓' : '·'} ${(adapter.label ?? adapter.id).padEnd(18)} ${detail}\n`);
  }
  process.stdout.write(`\nRuntime: ${config.runtime?.kind ?? 'process'} · concurrency: ${config.concurrency ?? 3}\n`);
  if (!adapters.some((adapter) => adapter.available)) process.stdout.write('No agent CLI detected. The built-in demo still works without keys.\n');
}

async function commandRun(positional, flags, options = {}) {
  const repoRoot = await resolveRoot(flags.repo);
  const task = String(flags.task ?? positional.join(' ')).trim();
  const result = await runMission({
    repoRoot,
    task,
    mode: flags.mode,
    agents: parseList(flags.agents ?? flags.agent),
    base: flags.base,
    tasks: await loadTasks(flags.plan),
    title: flags.title,
    profile: flags.profile,
    model: flagAssignments(flags.model),
    effort: flagAssignments(flags.effort),
    variant: flagAssignments(flags.variant),
    signal: options.signal,
  });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printMissionSummary(result.mission);
  if (result.mission.decision?.status === 'NO_WINNER') process.exitCode = 2;
}

async function commandDemo(flags, options = {}) {
  const result = await runDemo({ outputRoot: flags.output, repoRoot: flags.repo, keep: true, signal: options.signal });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    printMissionSummary(result.mission);
    process.stdout.write(`Demo repository: ${result.repoRoot}\n`);
  }
  if (!flags.json && flags.open !== false) {
    const server = await startDashboardServer({ repoRoot: result.repoRoot, missionId: result.mission.id, port: flagNumber(flags.port, 0), open: true });
    process.stdout.write(`Command center: ${server.url}\nPress Ctrl+C to stop.\n`);
  }
}

async function commandStatus(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const mission = await loadMission(repoRoot, positional[0] ?? flags.id ?? 'latest');
  if (!mission) throw new Error('No mission found.');
  if (flags.json) process.stdout.write(`${JSON.stringify(mission, null, 2)}\n`);
  else printMissionSummary(mission);
}

async function commandDashboard(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const missionId = positional[0] ?? flags.id ?? await latestMissionId(repoRoot);
  if (!missionId) throw new Error('No mission found.');
  const server = await startDashboardServer({ repoRoot, missionId, port: flagNumber(flags.port, 0), open: flags.open !== false });
  process.stdout.write(`${APP_NAME} command center: ${server.url}\nPress Ctrl+C to stop.\n`);
}

async function commandReport(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const mission = await loadMission(repoRoot, positional[0] ?? flags.id ?? 'latest');
  if (!mission) throw new Error('No mission found.');
  const events = await readEvents(repoRoot, mission.id);
  const outputDir = flags.output ? path.resolve(String(flags.output)) : path.join(missionDir(repoRoot, mission.id), 'artifacts');
  const artifacts = await writeReportArtifacts({ mission, events }, { outputDir });
  process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
}

async function commandVerify(flags, options = {}) {
  const repoRoot = await resolveRoot(flags.repo);
  let claims = [];
  if (flags.claims) claims = (await readJson(path.resolve(String(flags.claims)))).claims ?? [];
  const result = await verifyCurrentPatch({ repoRoot, task: flags.task, base: flags.base, claims, signal: options.signal });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision.status === 'NO_WINNER') process.exitCode = 2;
}

async function commandApply(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const result = await applyMissionWinner({
    repoRoot,
    missionId: positional[0] ?? flags.id ?? 'latest',
    commit: flags.commit === true,
    message: typeof flags.message === 'string' ? flags.message : undefined,
    threeWay: flags['three-way'] === true,
    allowStale: flags['allow-stale'] === true,
  });
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${APP_NAME} applied ${result.candidateId}${result.commitSha ? ` and committed ${result.commitSha.slice(0, 12)}` : ''}.\n`);
    if (!result.commitSha) process.stdout.write('Review the working tree, then commit when ready.\n');
  }
}

async function commandClean(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const result = await cleanupMissionWorktrees({
    repoRoot,
    missionId: positional[0] ?? flags.id ?? 'latest',
    force: flags.force === true,
  });
  process.stdout.write(`Removed ${result.removed.length} temporary worktree(s).\n`);
  for (const item of result.skipped) process.stdout.write(`Kept ${item.worktreePath}: ${item.reason}\n`);
  if (result.skipped.length && flags.force !== true) process.stdout.write(`Run ${CLI_NAME} clean ${result.missionId} --force after reviewing sealed patches.\n`);
}

async function commandMemory(positional, flags) {
  const repoRoot = await resolveRoot(flags.repo);
  const store = createMemoryStore(repoRoot);
  const action = positional.shift() ?? 'list';
  if (action === 'add') {
    const title = String(flags.title ?? positional.shift() ?? '').trim();
    const content = String(flags.content ?? positional.join(' ')).trim();
    if (!title || !content) throw new Error('memory add requires --title and --content.');
    process.stdout.write(`${JSON.stringify(await store.add({ title, content, type: flags.type, tags: parseList(flags.tags), source: 'cli' }), null, 2)}\n`);
  } else if (action === 'search') {
    const query = String(flags.query ?? positional.join(' ')).trim();
    process.stdout.write(`${JSON.stringify(await store.search(query, { limit: flagNumber(flags.limit, 8) }), null, 2)}\n`);
  } else if (action === 'list') {
    process.stdout.write(`${JSON.stringify(await store.list(), null, 2)}\n`);
  } else throw new Error(`Unknown memory action: ${action}`);
}

export async function main(argv, options = {}) {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift();
  if (flags.version || command === 'version') { process.stdout.write(`${VERSION}\n`); return; }
  if (flags.help || command === 'help') { process.stdout.write(help()); return; }
  if (!command) { await interactiveSession({ repoRoot: flags.repo, signal: options.signal }); return; }
  if (command === 'init') return await commandInit(flags);
  if (command === 'doctor') return await commandDoctor(flags, options);
  if (command === 'run' || command === 'mission') return await commandRun(positional, flags, options);
  if (command === 'demo') return await commandDemo(flags, options);
  if (command === 'status' || command === 'compare') return await commandStatus(positional, flags);
  if (command === 'dashboard' || command === 'ui' || command === 'serve') return await commandDashboard(positional, flags);
  if (command === 'report') return await commandReport(positional, flags);
  if (command === 'verify') return await commandVerify(flags, options);
  if (command === 'apply') return await commandApply(positional, flags);
  if (command === 'clean') return await commandClean(positional, flags);
  if (command === 'memory') return await commandMemory(positional, flags);
  if (command === 'mcp') return await startMcpServer();
  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}

export { parseArgs, help };
