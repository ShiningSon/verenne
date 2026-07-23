import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { loadConfig, loadPolicy, prepareRuntimeExcludes } from './config.js';
import { inspectAdapters, runAdapter, readAgentResult, resolveAdapterTuning, runScriptedDemoAdapter } from './adapters.js';
import { runBootstrapSteps } from './bootstrap.js';
import { buildAgentPrompt, compileContext } from './context.js';
import { createMemoryStore } from './memory.js';
import { deriveIntentContract, evaluateIntentCoverage } from './intent.js';
import { capturePatch, createWorktree, currentHead, findRepoRoot, git, resolveBase, statusSummary, workingTreeSeal, worktreeCacheRoot } from './git.js';
import { createMissionState, indexMission, loadMission, missionDir, readEvents, recordEvent, saveMission } from './state.js';
import { evaluateCandidate, selectCandidate } from './evidence.js';
import { createAbortError, isAbortError, throwIfAborted } from './process.js';
import { writeReportArtifacts } from './report.js';
import { parseList, sha256, shortId, slug, writeJson, writeText } from './utils.js';

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
    }
  });
  const settled = await Promise.allSettled(runners);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return output;
}

export async function normalizeAgents(config, agents, demo, signal) {
  if (demo) return parseList(agents).length ? parseList(agents) : ['sprinter', 'builder', 'drifter'];
  const explicit = parseList(agents);
  const values = explicit.length
    ? explicit
    : (await inspectAdapters(config, Object.keys(config.adapters ?? {}), { signal }))
      .filter((adapter) => adapter.available)
      .slice(0, Math.max(1, Number(config.concurrency ?? 3)))
      .map((adapter) => adapter.id);
  if (!values.length) throw new Error('No agents configured. Pass --agents or set defaultAgents.');
  for (const id of values) {
    if (!config.adapters[id]) throw new Error(`Agent adapter '${id}' is not configured.`);
  }
  return values;
}

function defaultTasks(task, mode, agents) {
  if (mode === 'swarm') {
    return [{ id: 'task-1', title: task, task, dependsOn: [], agent: agents[0] }];
  }
  return [{ id: 'task-1', title: task, task, dependsOn: [], agents }];
}

function validateTasks(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('Task IDs must be unique.');
  for (const task of tasks) {
    if (!task.id || !task.task && !task.title) throw new Error('Each task requires id and task/title.');
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const walk = (id) => {
    if (visiting.has(id)) throw new Error(`Task DAG contains a cycle at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) walk(task.id);
}

async function executeLaneUnsafe({ repoRoot, mission, lane, config, policyBundle, demo = false, promptSuffix = '', seedPatch, signal }) {
  throwIfAborted(signal);
  const laneRoot = path.join(missionDir(repoRoot, mission.id), 'lanes', lane.id);
  await recordEvent(repoRoot, mission.id, { type: 'lane.queued', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId, summary: `${lane.label} queued` });
  const worktreePath = lane.worktreePath ?? await createWorktree(repoRoot, mission.id, lane.id, mission.baseSha);
  lane.worktreePath = worktreePath;
  await recordEvent(repoRoot, mission.id, { type: 'worktree.created', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId, summary: 'Isolated worktree ready', data: { pathRedacted: path.basename(worktreePath), baseSha: mission.baseSha } });

  const bootstrap = await runBootstrapSteps(policyBundle.policy?.bootstrap, worktreePath, { credentials: true, signal });
  await writeJson(path.join(laneRoot, 'bootstrap.json'), bootstrap);
  for (const step of bootstrap.results) {
    await recordEvent(repoRoot, mission.id, {
      type: `bootstrap.${step.status === 'PASS' ? 'completed' : 'failed'}`,
      laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId,
      summary: `${step.label}: ${step.status}`,
      durationMs: step.durationMs,
      data: { id: step.id, status: step.status, exitCode: step.exitCode },
    });
  }
  if (!bootstrap.ok) throw new Error(`Trusted dependency bootstrap failed at ${bootstrap.failed.label}. Check the lane bootstrap log or configure policy.bootstrap.`);
  if (seedPatch) {
    await applySeedPatch(worktreePath, seedPatch);
    await recordEvent(repoRoot, mission.id, {
      type: 'continuation.seed.applied', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId,
      summary: `Inherited verified patch from ${seedPatch.parentMissionId}`,
      data: { parentMissionId: seedPatch.parentMissionId, parentCandidateId: seedPatch.parentCandidateId, diffDigest: seedPatch.diffDigest },
    });
  }
  throwIfAborted(signal);

  const context = await compileContext(repoRoot, lane.task, config, path.join(laneRoot, 'context.md'));
  const basePrompt = buildAgentPrompt({ mission: { ...mission, task: lane.task }, lane, contextPath: context.path });
  const prompt = `${basePrompt}${promptSuffix ? `\n\nROLE-SPECIFIC INSTRUCTIONS\n${promptSuffix}` : ''}`;
  const promptPath = path.join(laneRoot, 'prompt.md');
  await writeText(promptPath, prompt);

  await recordEvent(repoRoot, mission.id, { type: 'agent.started', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId, summary: `${lane.label} started`, data: { contextDigest: context.digest } });
  const mainTreeBefore = await workingTreeSeal(repoRoot);
  let processResult;
  if (demo) {
    processResult = await runScriptedDemoAdapter({ worktreePath, laneId: lane.id, intent: mission.intent });
  } else {
    processResult = await runAdapter({
      config,
      adapterId: lane.agentId,
      worktreePath,
      prompt,
      promptPath,
      missionId: mission.id,
      laneId: lane.id,
      tuning: contextTuning(config, lane.agentId, mission.tuning),
      signal,
    });
  }
  if (processResult.aborted) throw createAbortError(processResult.abortReason);
  throwIfAborted(signal);
  const mainTreeAfter = await workingTreeSeal(repoRoot);
  if (mainTreeAfter !== mainTreeBefore) {
    processResult.error = 'The provider modified the parent working tree outside its assigned lane. The candidate was disqualified; inspect your main worktree before continuing.';
    processResult.integrityViolation = true;
  }

  await writeText(path.join(laneRoot, 'stdout.log'), processResult.stdout ?? '');
  await writeText(path.join(laneRoot, 'stderr.log'), processResult.stderr ?? '');
  await recordEvent(repoRoot, mission.id, {
    type: processResult.code === 0 && !processResult.error && !processResult.timedOut ? 'agent.completed' : 'agent.failed', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId,
    summary: `${lane.label} exited with ${processResult.code ?? processResult.error ?? 'unknown'}`,
    durationMs: processResult.durationMs,
    data: { exitCode: processResult.code, timedOut: processResult.timedOut, outputTruncated: processResult.outputTruncated },
  });

  const agentResult = await readAgentResult(worktreePath, processResult);
  await writeJson(path.join(laneRoot, 'agent-result.json'), agentResult);
  await recordEvent(repoRoot, mission.id, { type: 'verification.started', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId, summary: `Cross-examining ${lane.label}` });

  const candidate = await evaluateCandidate({
    repoRoot,
    worktreePath,
    baseSha: mission.baseSha,
    policyBundle,
    agentResult,
    mission,
    lane,
    artifactDir: laneRoot,
    processResult,
    signal,
  });
  const patchText = await capturePatch(worktreePath, mission.baseSha);
  if (sha256(patchText) !== candidate.diffDigest) throw new Error(`Candidate ${candidate.id} changed after its evidence seal.`);
  const patchFile = path.join('lanes', lane.id, 'candidate.patch');
  await writeText(path.join(missionDir(repoRoot, mission.id), patchFile), patchText);
  candidate.patchFile = patchFile;
  candidate.taskId = lane.taskId;
  candidate.role = lane.role;
  candidate.context = context;
  candidate.process = {
    exitCode: processResult.code,
    timedOut: processResult.timedOut,
    durationMs: processResult.durationMs,
    startedAt: processResult.startedAt,
    endedAt: processResult.endedAt,
    model: processResult.model,
    effort: processResult.effort,
    variant: processResult.variant,
    usage: processResult.usage,
  };
  candidate.model = processResult.model;
  candidate.effort = processResult.effort;
  candidate.variant = processResult.variant;
  candidate.tokenUsage = processResult.usage;
  candidate.cost = processResult.cost;
  candidate.durationMs = processResult.durationMs;
  await writeJson(path.join(laneRoot, 'candidate.json'), candidate);
  await recordEvent(repoRoot, mission.id, {
    type: 'verification.completed', laneId: lane.id, agentId: lane.agentId, taskId: lane.taskId,
    summary: `${candidate.label}: ${candidate.eligibilityStatus}`,
    durationMs: candidate.verificationDurationMs,
    data: { eligibility: candidate.eligibilityStatus, proven: candidate.claimCounts?.proven, contradicted: candidate.claimCounts?.contradicted, unproven: candidate.claimCounts?.unproven },
  });
  return candidate;
}

function blockedLaneCandidate({ mission, lane, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const intentCoverage = evaluateIntentCoverage(mission.intent, {}, { analysis: { changedPaths: [] }, gates: [] });
  const failure = {
    id: `lane-failure:${lane.id}`,
    kind: 'lane-failure',
    trust: 'observed',
    status: 'ERROR',
    reason: message,
  };
  return {
    id: lane.id,
    label: lane.label ?? lane.id,
    agentId: lane.agentId,
    taskId: lane.taskId,
    role: lane.role,
    worktreePath: lane.worktreePath ?? null,
    baseSha: mission.baseSha,
    headSha: null,
    diffDigest: null,
    sealDigest: null,
    stats: { additions: 0, deletions: 0, files: [] },
    changedFiles: [],
    gates: [],
    claims: [],
    intentCoverage,
    claimCounts: { proven: 0, contradicted: 0, unproven: 0, requiredProven: 0, requiredContradicted: 0, requiredUnproven: 0 },
    evidence: [failure],
    trustViolations: [{ id: 'lane_execution_failed', severity: 'critical', message, paths: [], evidenceIds: [failure.id] }],
    eligibility: { eligible: false, fullyProven: false, reasons: [`Lane execution failed safely: ${message}`] },
    eligibilityStatus: 'BLOCKED',
    score: 0,
    scoreBreakdown: {},
    summary: { claims: { proven: 0, contradicted: 0, unproven: 0 }, gates: { passed: 0, failed: 0, errored: 0 }, risk: 8 },
    selectionVector: [0, 0, -intentCoverage.requiredUnevidenced.length],
    process: { exitCode: null, error: message },
    error: { message },
  };
}

async function executeLane(args) {
  try {
    return await executeLaneUnsafe(args);
  } catch (error) {
    if (isAbortError(error) || args.signal?.aborted) throw createAbortError(args.signal?.reason ?? error);
    const candidate = blockedLaneCandidate({ mission: args.mission, lane: args.lane, error });
    try {
      const laneRoot = path.join(missionDir(args.repoRoot, args.mission.id), 'lanes', args.lane.id);
      await writeJson(path.join(laneRoot, 'candidate.json'), candidate);
      await recordEvent(args.repoRoot, args.mission.id, {
        type: 'lane.failed', laneId: args.lane.id, agentId: args.lane.agentId, taskId: args.lane.taskId,
        summary: candidate.eligibility.reasons[0], data: { isolated: true },
      });
    } catch {}
    return candidate;
  }
}

async function runArena(context) {
  throwIfAborted(context.signal);
  const lanes = context.agents.map((agentId, index) => ({
    id: context.demo ? ['sprinter', 'builder', 'drifter'][index] ?? slug(agentId) : `${slug(agentId)}-${index + 1}`,
    label: context.demo ? ['Sprinter', 'Builder', 'Drifter'][index] ?? agentId : context.config.adapters[agentId]?.label ?? agentId,
    agentId,
    taskId: context.mission.tasks[0].id,
    task: context.mission.tasks[0].task ?? context.mission.task,
    role: 'candidate',
  }));
  return await mapLimit(lanes, context.config.concurrency ?? lanes.length, (lane) => executeLane({ ...context, lane }));
}

function contextTuning(config, agentId, tuning = {}) {
  return resolveAdapterTuning(config, agentId, tuning);
}

async function applySeedPatch(worktreePath, seedPatch) {
  if (!seedPatch?.text || sha256(seedPatch.text) !== seedPatch.diffDigest) {
    throw new Error('Continuation seed does not match its sealed digest.');
  }
  const patchPath = path.join(worktreeCacheRoot(), `continuation-${sha256(`${seedPatch.parentMissionId}:${seedPatch.diffDigest}`).slice(0, 20)}.patch`);
  await writeText(patchPath, seedPatch.text);
  try {
    const checked = await git(['apply', '--binary', '--whitespace=nowarn', '--check', patchPath], { cwd: worktreePath, allowFailure: true });
    if (checked.code !== 0) throw new Error(`Verified continuation patch no longer applies to its base: ${checked.stderr || checked.stdout}`);
    await git(['apply', '--binary', '--whitespace=nowarn', patchPath], { cwd: worktreePath });
  } finally {
    await rm(patchPath, { force: true });
  }
}

function assertManagedRelayWorktree(worktreePath) {
  const root = worktreeCacheRoot();
  const relative = path.relative(root, path.resolve(worktreePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing to restore a relay worktree outside the Verenne cache.');
  }
}

async function clearRelayResult(worktreePath) {
  await rm(path.join(worktreePath, '.verenne-result.json'), { force: true });
}

async function restoreRelayPatch({ worktreePath, baseSha, patchText, patchPath }) {
  assertManagedRelayWorktree(worktreePath);
  await git(['reset', '--hard', baseSha], { cwd: worktreePath });
  await git(['clean', '-fdx'], { cwd: worktreePath });
  if (patchText.trim()) {
    await writeText(patchPath, patchText);
    try {
      await git(['apply', '--binary', '--whitespace=nowarn', patchPath], { cwd: worktreePath });
    } finally {
      await rm(patchPath, { force: true });
    }
  }
}

async function runRelay(context) {
  throwIfAborted(context.signal);
  const roles = ['scout', 'builder', 'critic', 'fixer'];
  const assigned = roles.map((role, index) => ({ role, agentId: context.agents[index % context.agents.length] }));
  let finalCandidate;
  const handoffs = [];

  // Relay keeps one lane/worktree by design. Each role gets a fresh process and compact handoff.
  const lane = {
    id: 'relay', label: 'Relay candidate', agentId: assigned[0].agentId,
    taskId: context.mission.tasks[0].id, task: context.mission.task, role: 'relay',
  };
  const worktreePath = await createWorktree(context.repoRoot, context.mission.id, lane.id, context.mission.baseSha);
  lane.worktreePath = worktreePath;
  const relayBootstrap = await runBootstrapSteps(context.policyBundle.policy?.bootstrap, worktreePath, { credentials: true, signal: context.signal });
  if (!relayBootstrap.ok) throw new Error(`Trusted dependency bootstrap failed at ${relayBootstrap.failed.label}.`);
  if (context.seedPatch) await applySeedPatch(worktreePath, context.seedPatch);
  let capsule = 'No prior handoff.';
  for (let index = 0; index < assigned.length; index++) {
    throwIfAborted(context.signal);
    const stage = assigned[index];
    const stageLane = { ...lane, id: `relay-${stage.role}`, label: `${stage.role} · ${stage.agentId}`, agentId: stage.agentId, worktreePath };
    const suffix = [
      `You are the ${stage.role} stage of a relay.`,
      stage.role === 'scout' ? 'Inspect and plan. Do not edit files.' : '',
      stage.role === 'critic' ? 'Review observable code and tests. Do not edit files; list concrete risks.' : '',
      stage.role === 'builder' || stage.role === 'fixer' ? 'Implement or improve the patch and leave the worktree runnable.' : '',
      `Previous handoff capsule: ${capsule}`,
    ].filter(Boolean).join('\n');

    const stageRoot = path.join(missionDir(context.repoRoot, context.mission.id), 'lanes', stageLane.id);
    await clearRelayResult(worktreePath);
    const patchBeforeStage = await capturePatch(worktreePath, context.mission.baseSha);
    const compiled = await compileContext(context.repoRoot, lane.task, context.config, path.join(stageRoot, 'context.md'));
    const prompt = `${buildAgentPrompt({ mission: context.mission, lane: stageLane, contextPath: compiled.path })}\n\n${suffix}`;
    const promptPath = path.join(stageRoot, 'prompt.md');
    await writeText(promptPath, prompt);
    await recordEvent(context.repoRoot, context.mission.id, { type: 'relay.stage.started', laneId: stageLane.id, agentId: stage.agentId, taskId: lane.taskId, summary: `${stage.role} accepted the baton` });
    const mainTreeBefore = await workingTreeSeal(context.repoRoot);
    const processResult = context.demo
      ? await runScriptedDemoAdapter({ worktreePath, laneId: stage.role === 'builder' || stage.role === 'fixer' ? 'builder' : 'scout', intent: context.mission.intent })
      : await runAdapter({ config: context.config, adapterId: stage.agentId, worktreePath, prompt, promptPath, missionId: context.mission.id, laneId: stageLane.id, tuning: contextTuning(context.config, stage.agentId, context.mission.tuning), signal: context.signal });
    if (processResult.aborted) throw createAbortError(processResult.abortReason);
    throwIfAborted(context.signal);
    const mainTreeAfter = await workingTreeSeal(context.repoRoot);
    if (mainTreeAfter !== mainTreeBefore) {
      processResult.error = 'The relay provider modified the parent working tree outside its assigned lane.';
      processResult.integrityViolation = true;
    }
    await writeText(path.join(stageRoot, 'stdout.log'), processResult.stdout ?? '');
    await writeText(path.join(stageRoot, 'stderr.log'), processResult.stderr ?? '');
    if (processResult.code !== 0 || processResult.timedOut || processResult.error) {
      const reason = processResult.error
        ?? (processResult.timedOut ? `${stage.role} timed out.` : `${stage.role} exited with ${processResult.code}.`);
      const blocked = blockedLaneCandidate({ mission: context.mission, lane: stageLane, error: new Error(reason) });
      blocked.process = {
        exitCode: processResult.code,
        timedOut: processResult.timedOut,
        integrityViolation: processResult.integrityViolation === true,
        error: reason,
      };
      await writeJson(path.join(stageRoot, 'candidate.json'), blocked);
      await recordEvent(context.repoRoot, context.mission.id, {
        type: 'relay.stage.failed', laneId: stageLane.id, agentId: stage.agentId, taskId: lane.taskId,
        summary: `${stage.role} stopped the relay: ${reason}`,
        data: { exitCode: processResult.code, timedOut: processResult.timedOut, integrityViolation: processResult.integrityViolation === true },
      });
      context.mission.handoffs = handoffs;
      return [blocked];
    }
    const result = await readAgentResult(worktreePath, processResult);
    if (stage.role === 'scout' || stage.role === 'critic') {
      const patchAfterStage = await capturePatch(worktreePath, context.mission.baseSha);
      await restoreRelayPatch({
        worktreePath,
        baseSha: context.mission.baseSha,
        patchText: patchBeforeStage,
        patchPath: path.join(stageRoot, 'restore.patch'),
      });
      if (sha256(patchAfterStage) !== sha256(patchBeforeStage)) {
        await recordEvent(context.repoRoot, context.mission.id, {
          type: 'relay.stage.reverted', laneId: stageLane.id, agentId: stage.agentId, taskId: lane.taskId,
          summary: `${stage.role} attempted edits; the pre-stage patch was restored`,
        });
      }
      const restoredBootstrap = await runBootstrapSteps(context.policyBundle.policy?.bootstrap, worktreePath, { credentials: true, signal: context.signal });
      if (!restoredBootstrap.ok) {
        const reason = `Relay dependency bootstrap failed after restoring ${stage.role}: ${restoredBootstrap.failed.label}.`;
        const blocked = blockedLaneCandidate({ mission: context.mission, lane: stageLane, error: new Error(reason) });
        await writeJson(path.join(stageRoot, 'candidate.json'), blocked);
        context.mission.handoffs = handoffs;
        return [blocked];
      }
      await clearRelayResult(worktreePath);
    }
    capsule = `${result.summary ?? `${stage.role} finished`}; risks: ${(result.openRisks ?? []).join(', ') || 'none stated'}`.slice(0, 1_500);
    const handoff = {
      id: shortId('handoff'), fromAgentId: stage.agentId, toAgentId: assigned[index + 1]?.agentId ?? 'verifier',
      taskId: lane.taskId, candidateId: 'relay', sentAt: new Date().toISOString(), acceptedAt: new Date().toISOString(),
      status: 'accepted', summary: capsule, openRisks: result.openRisks ?? [], contextDigest: compiled.digest,
    };
    handoff.packetDigest = sha256(JSON.stringify(handoff));
    handoffs.push(handoff);
    await recordEvent(context.repoRoot, context.mission.id, { type: 'relay.handoff', laneId: stageLane.id, agentId: stage.agentId, taskId: lane.taskId, summary: `${stage.role} → ${assigned[index + 1]?.role ?? 'verifier'}`, data: { packetDigest: handoff.packetDigest } });

    if (index === assigned.length - 1) {
      finalCandidate = await evaluateCandidate({ repoRoot: context.repoRoot, worktreePath, baseSha: context.mission.baseSha, policyBundle: context.policyBundle, agentResult: result, mission: context.mission, lane, artifactDir: stageRoot, processResult, signal: context.signal });
      const patchText = await capturePatch(worktreePath, context.mission.baseSha);
      if (sha256(patchText) !== finalCandidate.diffDigest) throw new Error('Relay candidate changed after its evidence seal.');
      const patchFile = path.join('lanes', stageLane.id, 'candidate.patch');
      await writeText(path.join(missionDir(context.repoRoot, context.mission.id), patchFile), patchText);
      finalCandidate.patchFile = patchFile;
      finalCandidate.process = { exitCode: processResult.code, durationMs: processResult.durationMs };
    }
  }
  context.mission.handoffs = handoffs;
  return [finalCandidate];
}

function topologicalTasks(tasks) {
  const positions = new Map(tasks.map((task, index) => [task.id, index]));
  const indegree = new Map(tasks.map((task) => [task.id, (task.dependsOn ?? []).length]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) dependents.get(dependency).push(task.id);
  }
  const ready = tasks.filter((task) => indegree.get(task.id) === 0);
  const ordered = [];
  while (ready.length) {
    ready.sort((left, right) => positions.get(left.id) - positions.get(right.id));
    const task = ready.shift();
    ordered.push(task);
    for (const dependentId of dependents.get(task.id)) {
      indegree.set(dependentId, indegree.get(dependentId) - 1);
      if (indegree.get(dependentId) === 0) ready.push(tasks[positions.get(dependentId)]);
    }
  }
  if (ordered.length !== tasks.length) throw new Error('Task DAG contains a cycle.');
  return ordered;
}

function inheritedTaskIds(task, topology, tasksById) {
  const inherited = new Set();
  const visit = (taskId) => {
    for (const dependencyId of tasksById.get(taskId)?.dependsOn ?? []) {
      if (inherited.has(dependencyId)) continue;
      inherited.add(dependencyId);
      visit(dependencyId);
    }
  };
  visit(task.id);
  return topology.filter((item) => inherited.has(item.id)).map((item) => item.id);
}

function isEligible(candidate) {
  return candidate?.eligibilityStatus === 'ELIGIBLE' && candidate?.eligibility?.eligible === true;
}

function outcomeSummary(outcome) {
  return {
    taskId: outcome.task.id,
    title: outcome.task.title ?? outcome.task.task,
    status: outcome.status,
    candidateId: outcome.candidate?.id ?? null,
    eligibilityStatus: outcome.candidate?.eligibilityStatus ?? null,
    inheritedTaskIds: outcome.inheritedTaskIds ?? [],
    blockedBy: outcome.blockedBy ?? [],
    reason: outcome.reason ?? null,
  };
}

async function persistSwarmProgress(context, outcomes, extra = {}) {
  context.mission.swarm = {
    schemaVersion: 1,
    ...context.mission.swarm,
    tasks: context.mission.tasks.map((task) => outcomeSummary(outcomes.get(task.id) ?? { task, status: 'PENDING' })),
    ...extra,
  };
  await saveMission(context.repoRoot, context.mission);
}

async function contributionArtifact(context, sourceTaskId, outcomes) {
  const outcome = outcomes.get(sourceTaskId);
  if (!outcome || outcome.status !== 'ELIGIBLE' || !isEligible(outcome.candidate)) {
    throw new Error(`Dependency ${sourceTaskId} is not eligible for integration.`);
  }
  const contribution = outcome.candidate.contribution;
  if (!contribution?.patchFile || !contribution.diffDigest) {
    throw new Error(`Dependency ${sourceTaskId} has no sealed contribution patch.`);
  }
  const root = missionDir(context.repoRoot, context.mission.id);
  const patchPath = path.resolve(root, contribution.patchFile);
  if (!pathInside(root, patchPath)) throw new Error(`Dependency ${sourceTaskId} references an unsafe patch path.`);
  const patchText = await readFile(patchPath, 'utf8');
  if (sha256(patchText) !== contribution.diffDigest) {
    throw new Error(`Dependency ${sourceTaskId} contribution no longer matches its evidence seal.`);
  }
  return { sourceTaskId, patchPath, patchText, contribution, candidateId: outcome.candidate.id };
}

async function integrateContributions({ context, worktreePath, targetTaskId, sourceTaskIds, outcomes, final = false }) {
  const eventBase = final ? 'swarm.final.integration' : 'swarm.integration';
  await recordEvent(context.repoRoot, context.mission.id, {
    type: `${eventBase}.started`,
    taskId: targetTaskId,
    summary: sourceTaskIds.length
      ? `Integrating ${sourceTaskIds.length} verified contribution(s) for ${targetTaskId}`
      : `${targetTaskId} starts from the trusted base`,
    data: { sourceTaskIds },
  });

  const applied = [];
  try {
    for (const sourceTaskId of sourceTaskIds) {
      const artifact = await contributionArtifact(context, sourceTaskId, outcomes);
      if (artifact.contribution.empty === true && artifact.contribution.reviewOnly === true) {
        const record = {
          sourceTaskId,
          candidateId: artifact.candidateId,
          contributionDigest: artifact.contribution.diffDigest,
          reviewOnly: true,
        };
        applied.push(record);
        await recordEvent(context.repoRoot, context.mission.id, {
          type: `${eventBase}.review.accepted`,
          taskId: targetTaskId,
          summary: `${sourceTaskId} review evidence accepted without a code patch`,
          data: record,
        });
        continue;
      }
      const args = ['apply', '--binary', '--whitespace=nowarn'];
      const checked = await git([...args, '--check', artifact.patchPath], { cwd: worktreePath, allowFailure: true });
      if (checked.code !== 0) {
        throw new Error(`Verified contribution ${sourceTaskId} conflicts with the integrated worktree: ${checked.stderr || checked.stdout}`);
      }
      await git([...args, artifact.patchPath], { cwd: worktreePath });
      const patchAfterApply = await readFile(artifact.patchPath, 'utf8');
      if (sha256(patchAfterApply) !== artifact.contribution.diffDigest) {
        throw new Error(`Verified contribution ${sourceTaskId} changed while it was being integrated.`);
      }
      const record = {
        sourceTaskId,
        candidateId: artifact.candidateId,
        contributionDigest: artifact.contribution.diffDigest,
      };
      applied.push(record);
      await recordEvent(context.repoRoot, context.mission.id, {
        type: `${eventBase}.patch.applied`,
        taskId: targetTaskId,
        summary: `${sourceTaskId} integrated into ${targetTaskId}`,
        data: record,
      });
    }

    const inheritedPatch = await capturePatch(worktreePath, context.mission.baseSha);
    const inheritedDiffDigest = sha256(inheritedPatch);
    let integrationBaseSha = context.mission.baseSha;
    if ((await statusSummary(worktreePath)).length > 0) {
      await git(['add', '--all'], { cwd: worktreePath });
      await git([
        '-c', 'user.name=Verenne Code',
        '-c', 'user.email=integration@verenne.local',
        'commit', '--no-verify', '--no-gpg-sign', '-m', `Verenne integration base for ${targetTaskId}`,
      ], { cwd: worktreePath });
      integrationBaseSha = await currentHead(worktreePath);
    }
    const result = {
      status: 'PASS',
      targetTaskId,
      sourceTaskIds,
      sourceCandidateIds: applied.map((item) => item.candidateId),
      applied,
      inheritedDiffDigest,
      integrationBaseSha,
    };
    await recordEvent(context.repoRoot, context.mission.id, {
      type: `${eventBase}.completed`,
      taskId: targetTaskId,
      summary: `${targetTaskId} received a sealed integration base`,
      data: result,
    });
    return result;
  } catch (error) {
    await recordEvent(context.repoRoot, context.mission.id, {
      type: `${eventBase}.failed`,
      taskId: targetTaskId,
      summary: `Integration stopped safely for ${targetTaskId}: ${error.message}`,
      data: { sourceTaskIds, applied, reason: error.message },
    });
    throw error;
  }
}

async function sealSwarmContribution({ context, task, lane, candidate, integration, worktreePath }) {
  const sealedFullPatch = await capturePatch(worktreePath, context.mission.baseSha);
  if (sha256(sealedFullPatch) !== candidate.diffDigest) throw new Error(`Swarm node ${task.id} changed after candidate verification.`);
  const contributionPatch = await capturePatch(worktreePath, integration.integrationBaseSha);
  const fullPatchAfterContributionCapture = await capturePatch(worktreePath, context.mission.baseSha);
  if (sha256(fullPatchAfterContributionCapture) !== candidate.diffDigest) throw new Error(`Swarm node ${task.id} changed while its contribution was being sealed.`);
  const contributionDigest = sha256(contributionPatch);
  const patchFile = path.join('lanes', lane.id, 'contribution.patch');
  await writeText(path.join(missionDir(context.repoRoot, context.mission.id), patchFile), contributionPatch);
  candidate.taskId = task.id;
  candidate.role = 'swarm';
  candidate.integration = integration;
  candidate.contribution = {
    patchFile,
    diffDigest: contributionDigest,
    baseSha: integration.integrationBaseSha,
    inheritedTaskIds: integration.sourceTaskIds,
    empty: contributionPatch.trim().length === 0,
    reviewOnly: task.allowEmpty === true || ['review', 'audit', 'verify'].includes(String(task.type ?? '').toLowerCase()),
  };

  if (candidate.contribution.empty && !candidate.contribution.reviewOnly) {
    const reason = `Swarm node ${task.id} produced no change beyond its inherited dependencies.`;
    candidate.eligibility = {
      ...(candidate.eligibility ?? {}),
      eligible: false,
      fullyProven: false,
      reasons: [...new Set([...(candidate.eligibility?.reasons ?? []), reason])],
    };
    candidate.eligibilityStatus = 'BLOCKED';
    candidate.trustViolations = [
      ...(candidate.trustViolations ?? []),
      { id: 'swarm_empty_contribution', severity: 'high', message: reason, paths: [], evidenceIds: ['swarm-contribution'] },
    ];
    candidate.selectionVector = [0, ...(candidate.selectionVector ?? []).slice(1)];
  }

  await writeJson(path.join(missionDir(context.repoRoot, context.mission.id), 'lanes', lane.id, 'candidate.json'), candidate);
  await recordEvent(context.repoRoot, context.mission.id, {
    type: 'swarm.contribution.sealed',
    laneId: lane.id,
    agentId: lane.agentId,
    taskId: task.id,
    summary: candidate.contribution.empty
      ? candidate.contribution.reviewOnly ? `${task.id} sealed a review-only contribution` : `${task.id} produced no independent contribution`
      : `${task.id} contribution sealed`,
    data: {
      candidateId: candidate.id,
      contributionDigest,
      inheritedTaskIds: integration.sourceTaskIds,
      eligibilityStatus: candidate.eligibilityStatus,
    },
  });
  return candidate;
}

async function buildIntegratedSwarmCandidate(context, topology, outcomes) {
  throwIfAborted(context.signal);
  const lane = {
    id: 'swarm-integrated',
    label: 'Integrated swarm result',
    agentId: 'verenne',
    taskId: 'swarm-integrated',
    task: context.mission.task,
    role: 'swarm-integration',
  };
  const laneRoot = path.join(missionDir(context.repoRoot, context.mission.id), 'lanes', lane.id);
  const worktreePath = await createWorktree(context.repoRoot, context.mission.id, lane.id, context.mission.baseSha);
  const integration = await integrateContributions({
    context,
    worktreePath,
    targetTaskId: lane.taskId,
    sourceTaskIds: topology.map((task) => task.id),
    outcomes,
    final: true,
  });
  const integratedPaths = [...new Set(topology.flatMap((task) => (
    outcomes.get(task.id)?.candidate?.changedFiles ?? []
  )).map((file) => file.path).filter(Boolean))];
  const replayGateIds = (context.policyBundle.policy?.gates ?? []).map((gate) => String(gate.id));
  const integratedClaims = topology.flatMap((task) => (
    outcomes.get(task.id)?.candidate?.claims ?? []
  ).filter((claim) => claim.required && claim.verdict === 'PROVEN').map((claim) => ({
    ...claim,
    id: `${task.id}:${claim.id}`,
    required: true,
    source: `verified-swarm-node:${task.id}`,
  })));
  const agentResult = {
    source: 'verenne-swarm-integration',
    summary: `${topology.length} independently verified swarm contribution(s) were composed in dependency order.`,
    claims: integratedClaims,
    tests: [],
    requirements: (context.mission.intent?.requirements ?? []).map((requirement) => ({
      id: requirement.id,
      status: 'completed',
      summary: 'Covered by the composed set of independently verified swarm contributions.',
      paths: integratedPaths,
      gates: replayGateIds,
      claims: integratedClaims.map((claim) => claim.id),
    })),
    visualEvidence: [],
    openRisks: [],
  };
  await writeJson(path.join(laneRoot, 'agent-result.json'), agentResult);
  await recordEvent(context.repoRoot, context.mission.id, {
    type: 'swarm.final.verification.started',
    taskId: lane.taskId,
    summary: 'Replaying trusted gates against the complete swarm result',
  });
  const candidate = await evaluateCandidate({
    repoRoot: context.repoRoot,
    worktreePath,
    baseSha: context.mission.baseSha,
    policyBundle: context.policyBundle,
    agentResult,
    mission: context.mission,
    lane,
    artifactDir: laneRoot,
    signal: context.signal,
  });
  const patchText = await capturePatch(worktreePath, context.mission.baseSha);
  if (sha256(patchText) !== candidate.diffDigest) throw new Error('Integrated swarm result changed after its evidence seal.');
  const patchFile = path.join('lanes', lane.id, 'candidate.patch');
  await writeText(path.join(missionDir(context.repoRoot, context.mission.id), patchFile), patchText);
  candidate.patchFile = patchFile;
  candidate.taskId = lane.taskId;
  candidate.role = lane.role;
  candidate.integration = integration;
  candidate.sourceCandidateIds = topology.map((task) => outcomes.get(task.id).candidate.id);
  await writeJson(path.join(laneRoot, 'candidate.json'), candidate);
  await recordEvent(context.repoRoot, context.mission.id, {
    type: 'swarm.final.verification.completed',
    taskId: lane.taskId,
    summary: `Integrated swarm result: ${candidate.eligibilityStatus}`,
    data: {
      candidateId: candidate.id,
      eligibilityStatus: candidate.eligibilityStatus,
      diffDigest: candidate.diffDigest,
      sourceCandidateIds: candidate.sourceCandidateIds,
    },
  });
  return candidate;
}

async function runSwarm(context) {
  throwIfAborted(context.signal);
  const topology = topologicalTasks(context.mission.tasks);
  const tasksById = new Map(context.mission.tasks.map((task) => [task.id, task]));
  const remaining = new Map(context.mission.tasks.map((task) => [task.id, task]));
  const outcomes = new Map();
  const candidates = [];
  let round = 0;
  await persistSwarmProgress(context, outcomes, { topology: topology.map((task) => task.id), status: 'RUNNING' });

  while (remaining.size) {
    throwIfAborted(context.signal);
    const ready = [...remaining.values()].filter((task) => (task.dependsOn ?? []).every((dependency) => outcomes.has(dependency)));
    if (!ready.length) throw new Error('No runnable swarm tasks remain; the DAG may contain a cycle.');
    const wave = await mapLimit(ready, context.config.concurrency ?? 3, async (task, index) => {
      throwIfAborted(context.signal);
      const blockedBy = (task.dependsOn ?? []).filter((dependency) => outcomes.get(dependency)?.status !== 'ELIGIBLE');
      const inheritedIds = inheritedTaskIds(task, topology, tasksById);
      if (blockedBy.length) {
        const reason = `Not started because verified dependencies are unavailable: ${blockedBy.join(', ')}.`;
        await recordEvent(context.repoRoot, context.mission.id, {
          type: 'swarm.node.blocked',
          taskId: task.id,
          summary: `${task.id} stopped before agent launch`,
          data: { blockedBy, reason },
        });
        return { task, status: 'BLOCKED_DEPENDENCY', blockedBy, inheritedTaskIds: inheritedIds, reason };
      }

      const agentId = task.agent ?? context.agents[(round + index) % context.agents.length];
      const lane = {
        id: `${slug(task.id)}-${slug(agentId)}-${sha256(task.id).slice(0, 6)}`,
        label: `${task.title ?? task.task} · ${agentId}`,
        agentId,
        taskId: task.id,
        task: task.task ?? task.title,
        role: 'swarm',
      };
      const worktreePath = await createWorktree(context.repoRoot, context.mission.id, lane.id, context.mission.baseSha);
      lane.worktreePath = worktreePath;
      let integration;
      try {
        integration = await integrateContributions({
          context,
          worktreePath,
          targetTaskId: task.id,
          sourceTaskIds: inheritedIds,
          outcomes,
        });
      } catch (error) {
        if (isAbortError(error) || context.signal?.aborted) throw createAbortError(context.signal?.reason ?? error);
        return {
          task,
          status: 'BLOCKED_INTEGRATION',
          blockedBy: inheritedIds,
          inheritedTaskIds: inheritedIds,
          reason: error.message,
        };
      }

      const promptSuffix = [
        `This is swarm node ${task.id}.`,
        inheritedIds.length
          ? `The following independently verified task contributions are already present in this worktree: ${inheritedIds.join(', ')}.`
          : 'This node starts from the trusted mission base.',
        'Treat inherited code as the working baseline. Preserve it unless this task explicitly requires a compatible adjustment.',
        task.allowEmpty === true || ['review', 'audit', 'verify'].includes(String(task.type ?? '').toLowerCase())
          ? 'This is an explicitly read-only review node. Do not edit files; report requirements against trusted gates and inherited paths.'
          : 'Your result must add a concrete contribution for this node; inherited work alone is not completion.',
      ].join('\n');
      const nodeMission = {
        ...context.mission,
        task: lane.task,
        title: task.title ?? lane.task,
        intent: deriveIntentContract(lane.task),
      };
      let candidate = await executeLane({ ...context, mission: nodeMission, lane, promptSuffix });
      throwIfAborted(context.signal);
      candidate = await sealSwarmContribution({ context, task, lane, candidate, integration, worktreePath });
      const status = isEligible(candidate) ? 'ELIGIBLE' : 'BLOCKED_VERIFICATION';
      await recordEvent(context.repoRoot, context.mission.id, {
        type: status === 'ELIGIBLE' ? 'swarm.node.completed' : 'swarm.node.blocked',
        laneId: lane.id,
        agentId,
        taskId: task.id,
        summary: status === 'ELIGIBLE' ? `${task.id} is ready for downstream integration` : `${task.id} failed independent verification`,
        data: { candidateId: candidate.id, status, eligibilityStatus: candidate.eligibilityStatus },
      });
      return { task, status, candidate, inheritedTaskIds: inheritedIds, reason: candidate.eligibility?.reasons?.join(' ') || null };
    });

    for (let index = 0; index < ready.length; index++) {
      const task = ready[index];
      const outcome = wave[index];
      outcomes.set(task.id, outcome);
      remaining.delete(task.id);
      if (outcome.candidate) candidates.push(outcome.candidate);
    }
    round += 1;
    await persistSwarmProgress(context, outcomes, { topology: topology.map((task) => task.id), status: 'RUNNING', completedWaves: round });
  }

  const blocked = [...outcomes.values()].filter((outcome) => outcome.status !== 'ELIGIBLE');
  let integratedCandidate = null;
  let finalReason = null;
  if (blocked.length === 0) {
    try {
      integratedCandidate = await buildIntegratedSwarmCandidate(context, topology, outcomes);
      candidates.push(integratedCandidate);
      if (!isEligible(integratedCandidate)) {
        finalReason = `The complete integrated patch failed final verification: ${(integratedCandidate.eligibility?.reasons ?? []).join(' ') || 'ineligible'}`;
      }
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted) throw createAbortError(context.signal?.reason ?? error);
      finalReason = `The complete swarm result could not be integrated safely: ${error.message}`;
      await recordEvent(context.repoRoot, context.mission.id, {
        type: 'swarm.final.blocked',
        taskId: 'swarm-integrated',
        summary: finalReason,
      });
    }
  } else {
    finalReason = `${blocked.length} swarm task(s) are not eligible; no combined patch was produced.`;
    await recordEvent(context.repoRoot, context.mission.id, {
      type: 'swarm.final.blocked',
      taskId: 'swarm-integrated',
      summary: finalReason,
      data: { blockedTasks: blocked.map((outcome) => outcome.task.id) },
    });
  }

  const taskSelections = Object.fromEntries(
    [...outcomes.values()].filter((outcome) => outcome.candidate).map((outcome) => [outcome.task.id, outcome.candidate.id]),
  );
  const ready = isEligible(integratedCandidate);
  const decision = {
    status: ready ? 'READY' : 'NO_WINNER',
    selectedCandidateId: ready ? integratedCandidate.id : null,
    winnerId: ready ? integratedCandidate.id : null,
    winner: ready ? integratedCandidate : null,
    ranked: integratedCandidate ? [{ ...integratedCandidate, selectionRank: 1 }] : [],
    noWinnerReason: ready ? null : finalReason,
    reasons: [ready
      ? `${topology.length} verified swarm contributions were composed and the complete patch passed independent replay.`
      : finalReason],
    taskSelections,
    integratedCandidateId: integratedCandidate?.id ?? null,
  };
  await persistSwarmProgress(context, outcomes, {
    topology: topology.map((task) => task.id),
    status: ready ? 'READY' : 'BLOCKED',
    completedWaves: round,
    integratedCandidateId: integratedCandidate?.id ?? null,
    finalReason,
  });
  return { candidates, decision };
}

export async function runMission(options) {
  throwIfAborted(options.signal);
  const repoRoot = options.repoRoot ? await findRepoRoot(options.repoRoot) : await findRepoRoot();
  await prepareRuntimeExcludes(repoRoot);
  const config = await loadConfig(repoRoot);
  const mode = options.mode ?? config.defaultMode ?? 'arena';
  if (!['arena', 'swarm', 'relay'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  if (options.seedPatch && mode === 'swarm') throw new Error('Continuation seeds currently support Arena and Relay. Start the follow-up in Arena, then create a new Swarm plan if decomposition is needed.');
  const agents = await normalizeAgents(config, options.agents, options.demo, options.signal);
  const baseRef = options.base ?? 'HEAD';
  const baseSha = await resolveBase(repoRoot, baseRef);
  const policyBundle = await loadPolicy(repoRoot, baseSha);
  throwIfAborted(options.signal);
  const task = options.task?.trim();
  if (!task) throw new Error('A task is required. Pass it as text or with --task.');
  const tasks = options.tasks?.length ? options.tasks : defaultTasks(task, mode, agents);
  validateTasks(tasks);
  const intent = deriveIntentContract(task, { criteria: options.criteria });

  const tuning = {
    profile: options.profile,
    model: options.model ?? {},
    effort: options.effort ?? {},
    variant: options.variant ?? {},
  };
  const mission = await createMissionState(repoRoot, {
    id: options.id,
    title: options.title ?? task,
    task, mode, baseRef, baseSha,
    policy: { digest: policyBundle.digest, source: policyBundle.source, trusted: policyBundle.trusted },
    agents: agents.map((id) => ({ id, label: config.adapters[id]?.label ?? id, ...resolveAdapterTuning(config, id, tuning) })),
    tasks,
    intent,
    lineage: options.seedPatch ? {
      parentMissionId: options.seedPatch.parentMissionId,
      parentCandidateId: options.seedPatch.parentCandidateId,
      inheritedDiffDigest: options.seedPatch.diffDigest,
    } : undefined,
  });
  mission.tuning = tuning;
  mission.status = 'running';
  mission.startedAt = new Date().toISOString();
  await saveMission(repoRoot, mission);
  await indexMission(repoRoot, mission);
  await recordEvent(repoRoot, mission.id, { type: 'mission.started', summary: `${mode} mission started`, data: { agents, baseSha, policyDigest: policyBundle.digest } });

  const context = { repoRoot, config, policyBundle, mission, agents, seedPatch: options.seedPatch, demo: options.demo === true, signal: options.signal };
  try {
    throwIfAborted(options.signal);
    if (mode === 'swarm') {
      const swarm = await runSwarm(context);
      mission.candidates = swarm.candidates;
      mission.decision = swarm.decision;
    } else {
      mission.candidates = mode === 'arena' ? await runArena(context) : await runRelay(context);
      mission.decision = selectCandidate(mission.candidates);
    }
    mission.status = mission.decision.status === 'NO_WINNER' ? 'blocked' : 'ready';
    mission.endedAt = new Date().toISOString();
    await recordEvent(repoRoot, mission.id, { type: 'mission.decided', summary: mission.decision.reasons?.[0] ?? mission.decision.status, data: mission.decision });

    const memory = createMemoryStore(repoRoot);
    await memory.add({
      type: 'decision', title: mission.title,
      content: `${mission.decision.status}: ${(mission.decision.reasons ?? []).join(' ')}`,
      tags: [mode, mission.decision.status.toLowerCase()], importance: 0.8,
      source: `mission:${mission.id}`,
    });
  } catch (error) {
    const cancelled = isAbortError(error) || options.signal?.aborted;
    const reported = cancelled ? createAbortError(options.signal?.reason ?? error) : error;
    mission.status = cancelled ? 'cancelled' : 'failed';
    mission.endedAt = new Date().toISOString();
    mission.error = cancelled
      ? { message: reported.message, code: 'ABORT_ERR' }
      : { message: error.message, stack: error.stack };
    await recordEvent(repoRoot, mission.id, { type: cancelled ? 'mission.cancelled' : 'mission.failed', summary: reported.message });
    await saveMission(repoRoot, mission);
    await indexMission(repoRoot, mission);
    throw reported;
  }

  await saveMission(repoRoot, mission);
  await indexMission(repoRoot, mission);
  const events = await readEvents(repoRoot, mission.id);
  const artifacts = await writeReportArtifacts(
    { mission, events },
    { outputDir: path.join(missionDir(repoRoot, mission.id), 'artifacts') },
  );
  mission.artifacts = artifacts;
  await saveMission(repoRoot, mission);
  return { mission, artifacts };
}

export async function verifyCurrentPatch(options = {}) {
  throwIfAborted(options.signal);
  const repoRoot = options.repoRoot ? await findRepoRoot(options.repoRoot) : await findRepoRoot();
  const baseSha = await resolveBase(repoRoot, options.base ?? 'HEAD');
  const policyBundle = await loadPolicy(repoRoot, baseSha);
  const task = options.task ?? 'Verify current patch quality gates';
  const mission = {
    id: options.id ?? shortId('verify'), task, title: task,
    mode: 'verify', baseSha, baseRef: options.base ?? 'HEAD', startedAt: new Date().toISOString(), tasks: [{ id: 'verify', title: options.task ?? 'Current patch' }],
    intent: deriveIntentContract(task),
  };
  const qualityKinds = new Set(['tests_passed', 'build_passed', 'lint_passed', 'typecheck_passed']);
  const inferredClaims = [...new Set((policyBundle.policy?.gates ?? []).filter((gate) => gate.required !== false).flatMap((gate) => {
    const declared = [...(gate.claimKinds ?? []), ...(gate.claims ?? [])].filter((kind) => qualityKinds.has(String(kind)));
    if (declared.length) return declared;
    const label = `${gate.id ?? ''} ${gate.label ?? ''}`;
    if (/test|pytest|jest|vitest|mocha/i.test(label)) return ['tests_passed'];
    if (/build|compile/i.test(label)) return ['build_passed'];
    if (/lint|eslint|ruff|clippy/i.test(label)) return ['lint_passed'];
    if (/type.?check|tsc|mypy|pyright/i.test(label)) return ['typecheck_passed'];
    return [];
  }))].map((kind, index) => ({ id: `verify-${index + 1}`, kind, text: `Trusted ${kind.replaceAll('_', ' ')} gate passes.`, required: true }));
  const claims = ((options.claims ?? []).length ? options.claims : inferredClaims).map((claim, index) => (
    typeof claim === 'string' ? { id: `verify-${index + 1}`, text: claim, required: true } : { id: claim.id ?? `verify-${index + 1}`, ...claim }
  ));
  const gateIds = (policyBundle.policy?.gates ?? []).filter((gate) => gate.required !== false).map((gate) => String(gate.id));
  const claimIds = claims.filter((claim) => claim.required !== false).map((claim) => claim.id);
  const claimPaths = [...new Set(claims.flatMap((claim) => claim.paths ?? claim.files ?? claim.targets ?? []).map(String))];
  const agentResult = options.agentResult ?? {
    source: 'verenne-gate-verification',
    summary: claims.length ? 'Verify the current patch against trusted quality gates.' : 'No deterministic quality claim could be inferred.',
    claims,
    requirements: (mission.intent.requirements ?? []).map((requirement) => ({
      id: requirement.id,
      status: 'completed',
      paths: claimPaths,
      gates: gateIds,
      claims: claimIds,
      summary: 'Verification maps the requested acceptance outcome to deterministic claim rules and trusted gates.',
    })),
    tests: [], visualEvidence: [],
    openRisks: claims.length ? [] : ['Pass --claims with specific acceptance claims or configure gate claimKinds.'],
  };
  const lane = { id: 'working-tree', label: 'Current working tree', agentId: 'unknown', taskId: 'verify', task: mission.task };
  const candidate = await evaluateCandidate({ repoRoot, worktreePath: repoRoot, baseSha, policyBundle, agentResult, mission, lane, artifactDir: options.outputDir ?? path.join(repoRoot, '.verenne', 'verify'), signal: options.signal });
  return { mission, candidate, decision: selectCandidate([candidate]) };
}

export async function getMission(repoRoot, id) {
  return await loadMission(await findRepoRoot(repoRoot), id);
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function selectedCandidate(mission) {
  const selectedId = mission.decision?.selectedCandidateId ?? mission.decision?.winnerId;
  return mission.candidates?.find((candidate) => candidate.id === selectedId) ?? null;
}

/** Read an evidence-approved winner as a digest-bound continuation seed. */
export async function readMissionWinnerSeed(repoRoot, mission) {
  const candidate = selectedCandidate(mission);
  if (!candidate || mission.decision?.status !== 'READY' || !candidate.patchFile) {
    throw new Error('The parent mission has no evidence-approved patch to continue from.');
  }
  const root = missionDir(repoRoot, mission.id);
  const patchPath = path.resolve(root, candidate.patchFile);
  if (!pathInside(root, patchPath)) throw new Error('The parent mission references an unsafe patch artifact.');
  const text = await readFile(patchPath, 'utf8');
  if (sha256(text) !== candidate.diffDigest) throw new Error('The parent mission patch no longer matches its evidence seal.');
  return {
    parentMissionId: mission.id,
    parentCandidateId: candidate.id,
    baseSha: mission.baseSha,
    diffDigest: candidate.diffDigest,
    text,
    task: mission.task,
  };
}

/** Apply a sealed, evidence-approved winner to a clean target worktree. */
export async function applyMissionWinner(options = {}) {
  const repoRoot = await findRepoRoot(options.repoRoot ?? process.cwd());
  const mission = await loadMission(repoRoot, options.missionId ?? 'latest');
  if (!mission) throw new Error('No mission found.');
  const candidate = selectedCandidate(mission);
  if (!candidate || mission.decision?.status !== 'READY') throw new Error('This mission has no evidence-approved winner to apply.');
  if (!candidate.patchFile) throw new Error('The selected candidate has no sealed patch artifact.');
  const dirty = await statusSummary(repoRoot);
  if (dirty.length > 0) throw new Error('The target worktree must be clean before applying a winner.');
  const headBefore = await currentHead(repoRoot);
  if (headBefore !== mission.baseSha && options.allowStale !== true) {
    throw new Error(`HEAD moved since verification (${headBefore.slice(0, 12)} != ${mission.baseSha.slice(0, 12)}). Re-run the mission on the current base.`);
  }
  const root = missionDir(repoRoot, mission.id);
  const patchPath = path.resolve(root, candidate.patchFile);
  if (!pathInside(root, patchPath)) throw new Error('Refusing a patch artifact outside the mission directory.');
  const patchText = await readFile(patchPath, 'utf8');
  if (sha256(patchText) !== candidate.diffDigest) throw new Error('The stored patch no longer matches its evidence seal.');
  const candidatePaths = [...new Set((candidate.changedFiles ?? []).flatMap((file) => [file.oldPath, file.path]).filter(Boolean))];
  const addedPaths = [...new Set((candidate.changedFiles ?? []).filter((file) => file.status === 'A').map((file) => file.path).filter(Boolean))];
  if (options.commit === true) {
    if (!candidatePaths.length) throw new Error('The winner has no declared changed paths to commit.');
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const resolved = await git(['var', identity], { cwd: repoRoot, allowFailure: true });
      if (resolved.code !== 0) {
        throw new Error('Git author/committer identity is not configured. Configure user.name and user.email before applying with --commit.');
      }
    }
  }
  const args = ['apply', '--binary', '--whitespace=nowarn'];
  if (options.threeWay === true) args.push('--3way');
  const checked = await git([...args, '--check', patchPath], { cwd: repoRoot, allowFailure: true });
  if (checked.code !== 0) throw new Error(`Winner patch cannot be applied cleanly:\n${checked.stderr || checked.stdout}`);
  await git([...args, patchPath], { cwd: repoRoot });
  // `git add -N .` deliberately respects ignore rules. Force only the sealed
  // paths that were already proven to be additions so an explicitly tracked
  // generated file can still be re-hashed and committed exactly.
  for (let index = 0; index < addedPaths.length; index += 100) {
    await git(['add', '-f', '-N', '--', ...addedPaths.slice(index, index + 100)], { cwd: repoRoot });
  }
  const appliedPatch = await capturePatch(repoRoot, headBefore);
  if (sha256(appliedPatch) !== candidate.diffDigest) {
    if (addedPaths.length) await git(['reset', '--', ...addedPaths], { cwd: repoRoot, allowFailure: true });
    throw new Error('The applied working tree does not match the sealed winner. Do not commit; inspect concurrent or hook-driven changes.');
  }
  let commitSha = null;
  if (options.commit === true) {
    for (let index = 0; index < candidatePaths.length; index += 100) {
      await git(['add', '-f', '--all', '--', ...candidatePaths.slice(index, index + 100)], { cwd: repoRoot });
    }
    const staged = await git(['diff', '--cached', '--binary', '--full-index', headBefore, '--'], { cwd: repoRoot, maxOutputBytes: 40_000_000 });
    if (sha256(staged.stdout) !== candidate.diffDigest) {
      await git(['reset', '--mixed', headBefore], { cwd: repoRoot });
      throw new Error('The staged commit does not exactly match the sealed winner; the patch remains unstaged for inspection.');
    }
    await git(['commit', '--no-verify', '--no-gpg-sign', '-m', options.message ?? `Apply ${mission.title} via Verenne Code`], { cwd: repoRoot });
    commitSha = await currentHead(repoRoot);
  } else if (addedPaths.length) {
    await git(['reset', '--', ...addedPaths], { cwd: repoRoot });
  }
  mission.status = options.commit === true ? 'committed' : 'applied';
  mission.applied = { candidateId: candidate.id, appliedAt: new Date().toISOString(), headBefore, commitSha };
  await recordEvent(repoRoot, mission.id, { type: 'winner.applied', summary: `${candidate.label} applied to the target worktree`, data: mission.applied });
  await saveMission(repoRoot, mission);
  await indexMission(repoRoot, mission);
  return { missionId: mission.id, candidateId: candidate.id, commitSha, changedFiles: candidate.changedFiles };
}
