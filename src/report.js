import path from 'node:path';
import { APP_NAME, VERSION, ensureDir, escapeHtml, formatDuration, sha256, stableStringify, writeJson, writeText } from './utils.js';

const VERDICTS = new Set(['proven', 'contradicted', 'unproven']);
const SECRET_KEY_PARTS = [
  'secret', 'password', 'passwd', 'authorization', 'cookie', 'apikey', 'accesstoken',
  'refreshtoken', 'privatetoken', 'privatekey', 'clientsecret', 'credential', 'csrftoken',
];
const PRIVATE_KEYS = new Set([
  'prompt', 'rawprompt', 'promptpath', 'chainofthought', 'reasoning', 'environment', 'env',
  'reporoot', 'cwd', 'worktreepath', 'absolutepath', 'csrftoken',
]);

function array(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value, fallback = '') {
  if (value == null) return fallback;
  return String(value);
}

function idOf(value, fallback) {
  if (value && typeof value === 'object') return text(value.id ?? value.key ?? value.name ?? value.label, fallback);
  return text(value, fallback);
}

function normalizeVerdict(value) {
  const verdict = text(value, 'unproven').toLowerCase().replaceAll('_', '-');
  if (verdict === 'passed' || verdict === 'verified' || verdict === 'pass') return 'proven';
  if (verdict === 'failed' || verdict === 'false' || verdict === 'block' || verdict === 'blocked') return 'contradicted';
  return VERDICTS.has(verdict) ? verdict : 'unproven';
}

function normalizeStatus(value, fallback = 'queued') {
  return text(value, fallback).toLowerCase().replace(/[\s_]+/g, '-');
}

function compactKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSecretKey(key) {
  const compact = compactKey(key);
  return SECRET_KEY_PARTS.some((part) => compact.includes(part));
}

function isPrivateKey(key) {
  return PRIVATE_KEYS.has(compactKey(key));
}

function redactString(value) {
  return String(value)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[secret]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}\b/g, '[secret]')
    .replace(/\b(?:glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/g, '[secret]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[secret]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [secret]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[secret]')
    .replace(/(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)[^\s,;]+/gi, '$1[secret]')
    .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/gi, '$1[secret]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[secret]')
    .replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => match.replace(/\/\/.*@/, '//[credentials]@'))
    .replace(/\bfile:\/{2,3}[^\s\r\n\t"'<>]+/gi, '[local-path]')
    .replace(/(^|[\s(\[{"'=,:])(?:[A-Za-z]:[\\/][^\r\n\t"'<>|\s]*|\\\\[^\r\n\t"'<>|\s]+\\[^\r\n\t"'<>|\s]+)/gm, '$1[local-path]')
    .replace(/(^|[\s(\[{"'=,:])\/(?!\/)[^\s\r\n\t"'<>]+/gm, '$1[local-path]');
}

/** Return a deep, JSON-safe copy with local paths, prompts, environment data and common secrets removed. */
export function redactForShare(value, seen = new WeakMap(), active = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (active.has(value)) return '[circular]';
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  active.add(value);
  if (Array.isArray(value)) {
    for (const item of value) result.push(redactForShare(item, seen, active));
    active.delete(value);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isPrivateKey(key)) continue;
    if (isSecretKey(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = redactForShare(item, seen, active);
  }
  active.delete(value);
  return result;
}

function sourceData(input) {
  const mission = input?.mission && typeof input.mission === 'object' ? input.mission : (input ?? {});
  const candidates = array(input?.candidates ?? mission.candidates);
  const candidateClaims = candidates.flatMap((candidate) => array(candidate?.claims)
    .filter((claim) => claim && typeof claim === 'object')
    .map((claim) => ({ ...claim, candidateId: claim.candidateId ?? candidate.id })));
  const candidateEvidence = candidates.flatMap((candidate) => array(candidate?.evidence)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...item, candidateId: item.candidateId ?? candidate.id })));
  return {
    mission,
    candidates,
    claims: array(input?.claims ?? mission.claims).concat(candidateClaims),
    evidence: array(input?.evidence ?? mission.evidence).concat(candidateEvidence),
    events: array(input?.events ?? mission.events),
    tasks: array(input?.tasks ?? mission.tasks),
    agents: array(input?.agents ?? mission.agents),
    handoffs: array(input?.handoffs ?? mission.handoffs),
    worktrees: array(input?.worktrees ?? mission.worktrees),
    decision: input?.decision ?? mission.decision ?? {},
    receipt: input?.receipt ?? mission.receipt ?? {},
  };
}

function recordCandidateId(record, candidates, membershipKey) {
  const direct = record.candidateId ?? record.candidate ?? record.laneId;
  if (direct && typeof direct === 'object') return idOf(direct);
  if (direct) return text(direct);
  const rawId = idOf(record, '');
  const owners = candidates.filter((candidate) => {
    if (array(candidate?.[`${membershipKey}Ids`]).some((item) => idOf(item) === rawId)) return true;
    return array(candidate?.[membershipKey]).some((item) => idOf(item) === rawId);
  });
  return owners.length === 1 ? owners[0].id : null;
}

/** Preserve same local IDs from different candidates by assigning stable scoped report IDs. */
function scopedRecords(items, prefix, candidates, membershipKey) {
  const records = items.map((item, index) => {
    const object = item && typeof item === 'object' ? { ...item } : { label: text(item) };
    const sourceId = idOf(object, `${prefix}-${index + 1}`);
    const candidateId = recordCandidateId(object, candidates, membershipKey);
    return { object, sourceId, candidateId, index };
  });

  // Aggregated mission data can repeat an identical nested record. Remove only exact copies;
  // records that merely reuse an ID remain visible and receive distinct scoped IDs.
  const fingerprints = new Set();
  const distinct = records.filter((record) => {
    const fingerprint = stableStringify({ ...record.object, candidateId: record.candidateId });
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
  const counts = new Map();
  for (const record of distinct) counts.set(record.sourceId, (counts.get(record.sourceId) ?? 0) + 1);
  const occurrences = new Map();
  const normalized = distinct.map((record) => {
    let id = record.sourceId;
    if ((counts.get(record.sourceId) ?? 0) > 1) {
      const base = `${record.candidateId ?? 'mission'}:${record.sourceId}`;
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      id = occurrence === 1 ? base : `${base}#${occurrence}`;
    }
    return { ...record, id };
  });

  const resolve = (candidateId, sourceId) => {
    const exact = normalized.filter((record) => record.sourceId === sourceId && record.candidateId === candidateId);
    if (exact.length) return exact[0].id;
    const global = normalized.filter((record) => record.sourceId === sourceId && record.candidateId == null);
    if (global.length) return global[0].id;
    const any = normalized.filter((record) => record.sourceId === sourceId);
    return any.length === 1 ? any[0].id : sourceId;
  };
  return {
    records: normalized.map((record) => ({ ...record.object, id: record.id, candidateId: record.candidateId })),
    resolve,
  };
}

function uniqueById(items, prefix) {
  const seen = new Set();
  return items.map((item, index) => {
    const object = item && typeof item === 'object' ? { ...item } : { label: text(item) };
    object.id = idOf(object, `${prefix}-${index + 1}`);
    return object;
  }).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function costValue(value) {
  if (typeof value === 'number') return { value, kind: 'exact', currency: 'USD' };
  if (value && typeof value === 'object') {
    const number = Number(value.value ?? value.amount ?? value.usd ?? 0);
    return { value: Number.isFinite(number) ? number : 0, kind: value.kind ?? 'estimated', currency: value.currency ?? 'USD' };
  }
  const number = Number(value ?? 0);
  return { value: Number.isFinite(number) ? number : 0, kind: 'unavailable', currency: 'USD' };
}

function money(value) {
  const cost = costValue(value);
  if (cost.kind === 'unavailable' && cost.value === 0) return '—';
  const prefix = cost.kind === 'estimated' ? '~' : '';
  return `${prefix}$${cost.value.toFixed(2)}`;
}

function claimCandidateId(claim, candidates) {
  const direct = claim.candidateId ?? claim.candidate ?? claim.laneId;
  if (direct && typeof direct === 'object') return idOf(direct);
  if (direct) return text(direct);
  return candidates.length === 1 ? candidates[0].id : null;
}

function inferredTaskStatus(task, mission, candidates, events, winnerId) {
  if (task.status != null && text(task.status).trim()) return normalizeStatus(task.status);
  const taskId = idOf(task, '');
  const relatedCandidates = candidates.filter((candidate) => idOf(candidate.taskId ?? candidate.task, '') === taskId);
  const relatedEvents = events.filter((event) => idOf(event.taskId ?? event.task, '') === taskId);
  const eventSignals = relatedEvents.flatMap((event) => [event.type, event.status]).map((value) => normalizeStatus(value, ''));
  if (eventSignals.some((value) => ['failed', 'error', 'blocked', 'cancelled'].includes(value))) return 'failed';
  if (relatedCandidates.some((candidate) => candidate.id === winnerId)) return 'verified';
  if (eventSignals.some((value) => ['running', 'started', 'command', 'edit', 'test', 'verify'].includes(value))) return 'running';
  if (relatedCandidates.length && relatedCandidates.every((candidate) => candidate.eligibility === 'blocked')) return 'blocked';
  const missionStatus = normalizeStatus(mission.status, 'queued');
  if (['verified', 'completed', 'passed', 'success'].includes(missionStatus)) return winnerId ? 'verified' : 'completed';
  if (['failed', 'error', 'blocked', 'cancelled'].includes(missionStatus)) return 'failed';
  if (['running', 'active', 'working'].includes(missionStatus)) return 'running';
  return 'queued';
}

function prepareData(input, options = {}) {
  const original = sourceData(input);
  const safe = options.shareSafe !== false;
  const value = safe ? redactForShare(original) : original;
  const candidates = uniqueById(value.candidates, 'candidate');
  const scopedEvidence = scopedRecords(value.evidence, 'evidence', candidates, 'evidence');
  const evidence = scopedEvidence.records.map((item) => ({
    ...item,
    summary: text(item.summary ?? item.message ?? item.title ?? item.kind, 'Evidence'),
  }));
  const scopedClaims = scopedRecords(value.claims, 'claim', candidates, 'claims');
  const claims = scopedClaims.records.map((claim) => {
    const candidateId = claimCandidateId(claim, candidates);
    return {
    ...claim,
    verdict: normalizeVerdict(claim.verdict ?? claim.status),
    rawText: text(claim.rawText ?? claim.text ?? claim.claim ?? claim.summary, 'Unspecified claim'),
      candidateId,
      evidenceIds: array(claim.evidenceIds ?? claim.evidence).map((item) => scopedEvidence.resolve(candidateId, idOf(item))).filter(Boolean),
      counterEvidenceIds: array(claim.counterEvidenceIds ?? claim.counterEvidence).map((item) => scopedEvidence.resolve(candidateId, idOf(item))).filter(Boolean),
    };
  });
  const events = uniqueById(value.events, 'event').map((event) => ({
    ...event,
    type: normalizeStatus(event.type ?? event.kind, 'event'),
    summary: text(event.summary ?? event.message ?? event.type ?? event.kind, 'Agent event'),
    agentId: idOf(event.agentId ?? event.agent, 'unassigned'),
  }));
  const inferredAgentIds = events.map((event) => event.agentId);
  const agents = uniqueById(value.agents.concat(inferredAgentIds), 'agent').map((agent) => ({
    ...agent,
    label: text(agent.label ?? agent.name ?? agent.id, agent.id),
    status: normalizeStatus(agent.status, 'idle'),
  }));
  const handoffs = uniqueById(value.handoffs, 'handoff');
  const decision = value.decision && typeof value.decision === 'object' ? value.decision : {};
  const winnerId = idOf(decision.selectedCandidateId ?? decision.winnerId ?? value.mission.winningCandidateId ?? candidates.find((candidate) => candidate.winner)?.id, '');
  const normalizedCandidates = candidates.map((candidate) => {
    const localClaimIds = array(candidate.claimIds).map((item) => idOf(item));
    const candidateClaims = claims.filter((claim) => claim.candidateId === candidate.id || localClaimIds.includes(claim.id));
    const counts = { proven: 0, contradicted: 0, unproven: 0 };
    for (const claim of candidateClaims) counts[claim.verdict] += 1;
    const gates = array(candidate.gates ?? candidate.gateResults);
    const passedGates = Number(candidate.passedGates ?? gates.filter((gate) => ['pass', 'passed', 'proven', 'success'].includes(normalizeStatus(gate.status))).length);
    const failedGates = Number(candidate.failedGates ?? gates.filter((gate) => ['fail', 'failed', 'blocked', 'error'].includes(normalizeStatus(gate.status))).length);
    const disqualifications = array(candidate.disqualifications ?? candidate.trust?.violations);
    return {
      ...candidate,
      label: text(candidate.label ?? candidate.name ?? candidate.agentLabel ?? candidate.id, candidate.id),
      eligibility: normalizeStatus(
        candidate.eligibilityStatus
          ?? (typeof candidate.eligibility === 'object'
            ? (candidate.eligibility.eligible ? 'eligible' : 'blocked')
            : candidate.eligibility)
          ?? (disqualifications.length || failedGates ? 'blocked' : 'eligible'),
      ),
      winner: candidate.id === winnerId,
      claimCounts: counts,
      claimTotal: candidateClaims.length,
      passedGates,
      failedGates,
      disqualifications,
      durationMs: Number(candidate.durationMs ?? candidate.duration ?? 0),
      cost: costValue(candidate.cost),
      scopeDrift: text(candidate.scopeDrift ?? candidate.scope?.rating ?? candidate.scope?.status, '—'),
    };
  });
  let taskSource = value.tasks;
  if (!taskSource.length) {
    const candidateTasks = new Map();
    for (const candidate of normalizedCandidates) {
      const taskId = idOf(candidate.taskId, '');
      if (taskId && !candidateTasks.has(taskId)) {
        candidateTasks.set(taskId, { id: taskId, title: text(candidate.task ?? candidate.taskTitle, value.mission.title ?? value.mission.task) });
      }
    }
    taskSource = candidateTasks.size
      ? [...candidateTasks.values()]
      : [{ id: 'task-1', title: text(value.mission.title ?? value.mission.task, 'Coding mission') }];
  }
  const tasks = uniqueById(taskSource, 'task').map((task) => ({
    ...task,
    title: text(task.title ?? task.task ?? task.summary, 'Untitled task'),
    status: inferredTaskStatus(task, value.mission, normalizedCandidates, events, winnerId),
    dependsOn: array(task.dependsOn ?? task.dependencies).map((item) => idOf(item)).filter(Boolean),
    evidenceIds: array(task.evidenceIds ?? task.evidence).map((item) => scopedEvidence.resolve(task.candidateId, idOf(item))).filter(Boolean),
  }));
  const inferredWorktrees = normalizedCandidates.map((candidate) => ({
    id: idOf(candidate.worktreeId ?? candidate.worktree, candidate.id),
    label: text(candidate.worktreeLabel ?? candidate.label, candidate.id),
    candidateId: candidate.id,
    status: candidate.winner ? 'verified' : candidate.eligibility === 'blocked' ? 'review' : 'clean',
    headSha: candidate.headSha,
    additions: candidate.additions ?? candidate.stats?.additions,
    deletions: candidate.deletions ?? candidate.stats?.deletions,
  }));
  const worktrees = uniqueById(value.worktrees.length ? value.worktrees : inferredWorktrees, 'worktree').map((worktree) => ({
    ...worktree,
    label: text(worktree.label ?? worktree.name ?? worktree.id, worktree.id),
    status: normalizeStatus(worktree.status ?? (worktree.clean === false ? 'dirty' : 'clean')),
  }));
  const focusClaims = winnerId ? claims.filter((claim) => claim.candidateId === winnerId) : claims;
  const totals = { proven: 0, contradicted: 0, unproven: 0 };
  for (const claim of focusClaims) totals[claim.verdict] += 1;
  const startedAt = value.mission.startedAt ?? value.mission.createdAt;
  const endedAt = value.mission.endedAt;
  const inferredDuration = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
  const totalCost = normalizedCandidates.reduce((sum, candidate) => sum + candidate.cost.value, 0);
  const report = {
    app: { name: APP_NAME, version: VERSION },
    settings: { shareSafe: safe, live: Boolean(options.live), revision: Number(options.revision ?? 0) },
    mission: {
      ...value.mission,
      id: idOf(value.mission, 'mission'),
      title: text(value.mission.title ?? value.mission.task, 'Untitled coding mission'),
      status: normalizeStatus(value.mission.status, winnerId ? 'verified' : 'review'),
      durationMs: Number(value.mission.durationMs ?? inferredDuration),
      totalCost: costValue(value.mission.totalCost ?? value.mission.cost ?? { value: totalCost, kind: 'estimated' }),
    },
    candidates: normalizedCandidates,
    claims,
    evidence,
    events,
    tasks,
    agents,
    handoffs,
    worktrees,
    decision: { ...decision, winnerId },
    receipt: value.receipt,
    totals,
  };
  report.digest = sha256(stableStringify({ mission: report.mission.id, decision: report.decision, claims: report.claims, evidence: report.evidence }));
  return report;
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function statusLabel(value) {
  return text(value, 'unknown').replaceAll('-', ' ').toUpperCase();
}

function shortSha(value) {
  return text(value, 'unknown').slice(0, 10);
}

function reasonText(report) {
  const reasons = array(report.decision.comparisonReasons ?? report.decision.reasons).map((item) => text(item)).filter(Boolean);
  if (reasons.length) return reasons.join(' ');
  const winner = report.candidates.find((candidate) => candidate.winner);
  if (winner) {
    return `${winner.label} is the selected candidate with ${winner.claimCounts.proven}/${winner.claimTotal || winner.claimCounts.proven} claims proven and ${winner.disqualifications.length} trust violations.`;
  }
  const contradiction = report.claims.find((claim) => claim.verdict === 'contradicted');
  if (contradiction) return `No candidate earned merge. A required claim was contradicted: “${contradiction.rawText}”`;
  return 'The mission needs review because no evidence-backed winner has been selected.';
}

function taskDepths(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return 0;
    const task = byId.get(id);
    if (!task || !task.dependsOn.length) return 0;
    const next = new Set(stack).add(id);
    const depth = 1 + Math.max(0, ...task.dependsOn.map((parent) => visit(parent, next)));
    memo.set(id, depth);
    return depth;
  };
  for (const task of tasks) memo.set(task.id, visit(task.id));
  return memo;
}

function renderDag(report) {
  if (!report.tasks.length) return '<p class="empty">No task graph was recorded.</p>';
  const depths = taskDepths(report.tasks);
  const groups = new Map();
  for (const task of report.tasks) {
    const depth = depths.get(task.id) ?? 0;
    if (!groups.has(depth)) groups.set(depth, []);
    groups.get(depth).push(task);
  }
  const positions = new Map();
  for (const [depth, tasks] of groups) tasks.forEach((task, index) => positions.set(task.id, { x: 28 + depth * 220, y: 34 + index * 102 }));
  const width = Math.max(760, (Math.max(...groups.keys()) + 1) * 220 + 20);
  const height = Math.max(220, Math.max(...[...groups.values()].map((items) => items.length)) * 102 + 40);
  const paths = report.tasks.flatMap((task) => task.dependsOn.map((parentId) => {
    const from = positions.get(parentId);
    const to = positions.get(task.id);
    if (!from || !to) return '';
    const x1 = from.x + 176;
    const y1 = from.y + 38;
    const x2 = to.x;
    const y2 = to.y + 38;
    const bend = Math.max(20, (x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" />`;
  })).join('');
  const nodes = report.tasks.map((task) => {
    const position = positions.get(task.id);
    const evidenceCount = task.evidenceIds.length;
    const search = escapeHtml(`${task.id} ${task.title} ${task.status}`.toLowerCase());
    return `<button class="dag-node status-${escapeHtml(task.status)}" style="left:${position.x}px;top:${position.y}px" data-inspect="task:${escapeHtml(task.id)}" data-navigable data-search="${search}">
      <span class="eyebrow">${escapeHtml(task.id)} · ${escapeHtml(statusLabel(task.status))}</span>
      <strong>${escapeHtml(task.title)}</strong>
      <span class="node-meta">${evidenceCount} evidence · ${task.dependsOn.length ? `after ${task.dependsOn.map(escapeHtml).join(', ')}` : 'root task'}</span>
    </button>`;
  }).join('');
  const accessible = report.tasks.map((task) => `<li>${escapeHtml(task.id)}: ${escapeHtml(task.title)}. Status ${escapeHtml(task.status)}. ${task.dependsOn.length ? `Depends on ${task.dependsOn.map(escapeHtml).join(', ')}.` : 'No dependencies.'}</li>`).join('');
  return `<div class="dag-scroll" tabindex="0" aria-label="Scrollable mission task graph">
    <div class="dag-canvas" style="width:${width}px;height:${height}px">
      <svg class="dag-edges" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">${paths}</svg>
      ${nodes}
    </div>
  </div><ol class="sr-only">${accessible}</ol>`;
}

function timeMs(value) {
  const result = Date.parse(value ?? '');
  return Number.isFinite(result) ? result : null;
}

function renderLanes(report) {
  if (!report.events.length) return '<p class="empty">No agent events were recorded.</p>';
  const times = report.events.flatMap((event) => [timeMs(event.startedAt ?? event.observedAt), timeMs(event.endedAt)]).filter((value) => value != null);
  const start = times.length ? Math.min(...times) : 0;
  const end = times.length ? Math.max(...times) : Math.max(1, report.events.length - 1);
  const span = Math.max(1, end - start);
  const agents = report.agents.length ? report.agents : [{ id: 'unassigned', label: 'Unassigned' }];
  return agents.map((agent) => {
    const events = report.events.filter((event) => event.agentId === agent.id);
    const bars = events.map((event, index) => {
      const eventStart = timeMs(event.startedAt ?? event.observedAt);
      const eventEnd = timeMs(event.endedAt) ?? eventStart;
      const left = eventStart == null ? (index / Math.max(1, events.length)) * 92 : ((eventStart - start) / span) * 92;
      const width = eventStart == null ? Math.max(5, 88 / Math.max(1, events.length)) : Math.max(3.5, (((eventEnd ?? eventStart) - eventStart) / span) * 92);
      const search = escapeHtml(`${agent.label} ${event.type} ${event.summary}`.toLowerCase());
      return `<button class="lane-event event-${escapeHtml(event.type)}" style="left:${left.toFixed(2)}%;width:${Math.min(width, 96 - left).toFixed(2)}%" title="${escapeHtml(event.summary)}" aria-label="${escapeHtml(agent.label)}: ${escapeHtml(event.summary)}" data-inspect="event:${escapeHtml(event.id)}" data-navigable data-search="${search}"><span>${escapeHtml(event.type)}</span></button>`;
    }).join('');
    return `<div class="agent-lane" data-search="${escapeHtml(agent.label.toLowerCase())}">
      <div class="lane-label"><strong>${escapeHtml(agent.label)}</strong><span>${escapeHtml(agent.model ?? agent.adapter ?? agent.status ?? '')}</span></div>
      <div class="lane-track" aria-label="${escapeHtml(agent.label)} event timeline">${bars || '<span class="no-events">No events</span>'}</div>
      <div class="lane-cost">${escapeHtml(money(agent.cost))}<span>${escapeHtml(agent.durationMs ? formatDuration(agent.durationMs) : '')}</span></div>
    </div>`;
  }).join('');
}

function renderWorktrees(report) {
  if (!report.worktrees.length) return '<p class="empty compact">No worktree state recorded.</p>';
  return report.worktrees.map((worktree) => {
    const changed = Number(worktree.additions ?? 0) + Number(worktree.deletions ?? 0);
    return `<button class="worktree status-${escapeHtml(worktree.status)}" data-inspect="worktree:${escapeHtml(worktree.id)}" data-navigable data-search="${escapeHtml(`${worktree.label} ${worktree.branch ?? ''} ${worktree.status}`.toLowerCase())}">
      <span class="status-dot" aria-hidden="true"></span><strong>${escapeHtml(worktree.label)}</strong>
      <span>${escapeHtml(statusLabel(worktree.status))}</span><code>${escapeHtml(shortSha(worktree.headSha))}</code><small>${changed ? `+${Number(worktree.additions ?? 0)}/-${Number(worktree.deletions ?? 0)}` : ''}</small>
    </button>`;
  }).join('');
}

function renderCandidateCards(report) {
  if (!report.candidates.length) return '<p class="empty">No candidates entered the arena.</p>';
  return report.candidates.map((candidate, index) => {
    const status = candidate.winner ? 'winner' : candidate.eligibility;
    return `<button class="candidate-card ${candidate.winner ? 'is-winner' : ''}" data-inspect="candidate:${escapeHtml(candidate.id)}" data-navigable data-search="${escapeHtml(`${candidate.label} ${candidate.eligibility}`.toLowerCase())}">
      <span class="candidate-index">${String.fromCharCode(65 + index)}</span>
      <span class="candidate-copy"><strong>${escapeHtml(candidate.label)}</strong><small>${escapeHtml(statusLabel(status))}</small></span>
      <span class="candidate-proof"><b>${candidate.claimCounts.proven}/${candidate.claimTotal}</b><small>claims proven</small></span>
      <span class="candidate-risk"><b>${candidate.claimCounts.contradicted}</b><small>contradicted</small></span>
    </button>`;
  }).join('');
}

function renderArenaTable(report) {
  if (!report.candidates.length) return '<p class="empty">No candidate comparison is available.</p>';
  const columns = report.candidates.map((candidate) => `<th scope="col">${escapeHtml(candidate.label)}${candidate.winner ? '<span class="winner-tag">Winner</span>' : ''}</th>`).join('');
  const row = (label, getter) => `<tr><th scope="row">${escapeHtml(label)}</th>${report.candidates.map((candidate) => `<td>${getter(candidate)}</td>`).join('')}</tr>`;
  return `<div class="table-scroll" tabindex="0"><table>
    <caption>Evidence-based candidate comparison</caption>
    <thead><tr><th scope="col">Decision factor</th>${columns}</tr></thead>
    <tbody>
      ${row('Eligibility', (candidate) => `<span class="pill status-${escapeHtml(candidate.eligibility)}">${escapeHtml(statusLabel(candidate.winner ? 'winner' : candidate.eligibility))}</span>`)}
      ${row('Required claims', (candidate) => `${candidate.claimCounts.proven}/${candidate.claimTotal}`)}
      ${row('Contradicted', (candidate) => String(candidate.claimCounts.contradicted))}
      ${row('Unproven', (candidate) => String(candidate.claimCounts.unproven))}
      ${row('Gates', (candidate) => `${candidate.passedGates} passed · ${candidate.failedGates} failed`)}
      ${row('Trust violations', (candidate) => String(candidate.disqualifications.length))}
      ${row('Scope drift', (candidate) => escapeHtml(candidate.scopeDrift))}
      ${row('Cost', (candidate) => escapeHtml(money(candidate.cost)))}
      ${row('Wall time', (candidate) => escapeHtml(candidate.durationMs ? formatDuration(candidate.durationMs) : '—'))}
    </tbody>
  </table></div>`;
}

function evidenceSummary(ids, evidence) {
  const items = ids.map((id) => evidence.find((item) => item.id === id)).filter(Boolean);
  if (!items.length) return '<li>No linked evidence recorded.</li>';
  return items.map((item) => `<li><button data-inspect="evidence:${escapeHtml(item.id)}" data-navigable><span>${escapeHtml(item.kind ?? 'evidence')}</span>${escapeHtml(item.summary)}</button></li>`).join('');
}

function renderClaims(report) {
  if (!report.claims.length) return '<p class="empty">No claims were captured from agent output.</p>';
  return report.claims.map((claim) => {
    const candidate = report.candidates.find((item) => item.id === claim.candidateId);
    const ids = [...claim.evidenceIds, ...claim.counterEvidenceIds];
    const search = `${claim.rawText} ${claim.verdict} ${claim.kind ?? ''} ${candidate?.label ?? ''}`.toLowerCase();
    return `<article class="claim-card verdict-${escapeHtml(claim.verdict)}" data-claim-verdict="${escapeHtml(claim.verdict)}" data-search="${escapeHtml(search)}">
      <header>
        <span class="claim-id">${escapeHtml(claim.id)}${candidate ? ` · ${escapeHtml(candidate.label)}` : ''}</span>
        <span class="verdict"><span aria-hidden="true">${claim.verdict === 'proven' ? '✓' : claim.verdict === 'contradicted' ? '×' : '?'}</span>${escapeHtml(statusLabel(claim.verdict))}</span>
      </header>
      <blockquote>${escapeHtml(claim.rawText)}</blockquote>
      <p>${escapeHtml(claim.rationale ?? claim.reason ?? 'No ruling rationale was recorded.')}</p>
      <details><summary>Evidence trail <span>${ids.length}</span></summary><ul class="evidence-list">${evidenceSummary(ids, report.evidence)}</ul></details>
      ${claim.remedy ? `<div class="remedy"><strong>Next move</strong><span>${escapeHtml(claim.remedy)}</span></div>` : ''}
      <button class="text-button inspect-claim" data-inspect="claim:${escapeHtml(claim.id)}" data-navigable>Open full ruling</button>
    </article>`;
  }).join('');
}

function renderIntentCoverage(report) {
  const requirements = array(report.mission.intent?.requirements);
  if (!requirements.length) return '<p class="empty">No explicit intent contract was recorded.</p>';
  const winner = report.candidates.find((candidate) => candidate.winner);
  const coverage = new Map(array(winner?.intentCoverage?.requirements).map((item) => [item.id, item]));
  return `<div class="claims">${requirements.map((requirement) => {
    const item = coverage.get(requirement.id) ?? { status: 'UNREPORTED' };
    const verdict = item.status === 'EVIDENCED' ? 'proven' : item.status === 'MISSING' ? 'contradicted' : 'unproven';
    const links = [...array(item.paths), ...array(item.gates)];
    return `<article class="claim-card verdict-${verdict}" data-search="${escapeHtml(`${requirement.id} ${requirement.text} ${item.status}`.toLowerCase())}"><header><span class="claim-id">${escapeHtml(requirement.id)} · ${requirement.required ? 'REQUIRED' : 'OPTIONAL'}</span><span class="verdict">${escapeHtml(statusLabel(item.status))}</span></header><blockquote>${escapeHtml(requirement.text)}</blockquote><p>${escapeHtml(item.summary ?? (item.status === 'EVIDENCED' ? 'Declared coverage is bound to observed changed paths or replayed gates.' : 'No independently linked delivery evidence was recorded.'))}</p>${links.length ? `<details><summary>Linked delivery evidence <span>${links.length}</span></summary><ul class="evidence-list">${links.map((entry) => `<li><code>${escapeHtml(entry)}</code></li>`).join('')}</ul></details>` : ''}</article>`;
  }).join('')}</div>`;
}

function renderSessionTasks(report) {
  if (!report.tasks.length) return '<p class="rail-empty">No task DAG recorded</p>';
  return report.tasks.map((task) => {
    const deps = task.dependsOn.length ? `← ${task.dependsOn.join(', ')}` : 'root';
    return `<button class="rail-task status-${escapeHtml(task.status)}" data-inspect="task:${escapeHtml(task.id)}" data-navigable data-search="${escapeHtml(`${task.id} ${task.title} ${task.status}`.toLowerCase())}">
      <span class="rail-node" aria-hidden="true"></span><span class="rail-task-copy"><small>${escapeHtml(task.id)} · ${escapeHtml(statusLabel(task.status))}</small><strong>${escapeHtml(task.title)}</strong><em>${escapeHtml(deps)}</em></span>
    </button>`;
  }).join('');
}

function eventTime(event) {
  const value = event.startedAt ?? event.observedAt ?? event.endedAt;
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(11, 19);
}

function renderExecutionStream(report) {
  const agentMap = new Map(report.agents.map((agent) => [agent.id, agent]));
  const missionEntry = `<article class="stream-entry entry-user" data-search="${escapeHtml(report.mission.title.toLowerCase())}"><div class="stream-avatar" aria-hidden="true">U</div><div class="stream-content"><header><strong>Mission</strong><span>${escapeHtml(report.mission.id)}</span></header><p>${escapeHtml(report.mission.title)}</p></div></article>`;
  const events = report.events.map((event) => {
    const agent = agentMap.get(event.agentId);
    const label = agent?.label ?? event.agentId;
    const initial = label.slice(0, 1).toUpperCase();
    const detail = event.command ? `<pre><code>${escapeHtml(event.command)}</code></pre>` : '';
    const kind = event.type === 'handoff' ? 'entry-handoff' : ['test', 'gate', 'verify'].includes(event.type) ? 'entry-proof' : '';
    return `<article class="stream-entry ${kind}" data-inspect="event:${escapeHtml(event.id)}" data-navigable data-search="${escapeHtml(`${label} ${event.type} ${event.summary}`.toLowerCase())}"><div class="stream-avatar" aria-hidden="true">${escapeHtml(initial)}</div><div class="stream-content"><header><strong>${escapeHtml(label)}</strong><span>${escapeHtml(event.type)}${eventTime(event) ? ` · ${escapeHtml(eventTime(event))}` : ''}</span></header><p>${escapeHtml(event.summary)}</p>${detail}</div></article>`;
  }).join('');
  const winner = report.candidates.find((candidate) => candidate.winner);
  const result = `<article class="stream-entry entry-verdict" data-search="verdict winner evidence"><div class="stream-avatar" aria-hidden="true">✓</div><div class="stream-content"><header><strong>Evidence verdict</strong><span>${escapeHtml(statusLabel(report.mission.status))}</span></header><h2>${escapeHtml(winner ? `${winner.label} earned merge` : 'No evidence-backed winner')}</h2><p>${escapeHtml(reasonText(report))}</p><div class="inline-metrics"><span class="proven">${report.totals.proven} proven</span><span class="contradicted">${report.totals.contradicted} contradicted</span><span class="unproven">${report.totals.unproven} unproven</span></div><button class="text-button" type="button" data-open-arena>Open Arena decision</button></div></article>`;
  return missionEntry + (events || '<p class="stream-empty">Waiting for observable agent events…</p>') + result;
}

function renderCompactLanes(report) {
  if (!report.agents.length) return '<p class="rail-empty">No agents recorded</p>';
  return report.agents.map((agent) => {
    const events = report.events.filter((event) => event.agentId === agent.id);
    const latest = events.at(-1);
    const active = ['running', 'active', 'working'].includes(agent.status) || (latest && !latest.endedAt && ['command', 'edit', 'test', 'verify'].includes(latest.type));
    return `<button class="context-agent ${active ? 'is-active' : ''}" data-inspect="${latest ? `event:${escapeHtml(latest.id)}` : `agent:${escapeHtml(agent.id)}`}" data-navigable><span class="agent-orb" aria-hidden="true">${escapeHtml(agent.label.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(agent.label)}</strong><small>${escapeHtml(latest?.summary ?? agent.status)}</small></span><em>${active ? 'LIVE' : events.length}</em></button>`;
  }).join('');
}

function renderDiffPeek(report) {
  const candidates = report.candidates.length ? report.candidates : [{ id: 'none', label: 'No candidate' }];
  return candidates.map((candidate) => {
    const additions = Number(candidate.additions ?? candidate.stats?.additions ?? candidate.diff?.additions ?? candidate.changes?.additions ?? 0);
    const deletions = Number(candidate.deletions ?? candidate.stats?.deletions ?? candidate.diff?.deletions ?? candidate.changes?.deletions ?? 0);
    const files = Number(candidate.filesChanged ?? candidate.stats?.filesChanged ?? candidate.stats?.changedPaths?.length ?? candidate.diff?.files ?? candidate.changes?.files ?? 0);
    return `<button class="diff-peek ${candidate.winner ? 'is-winner' : ''}" data-inspect="candidate:${escapeHtml(candidate.id)}" data-navigable><span><strong>${escapeHtml(candidate.label)}</strong><small>${candidate.winner ? 'selected patch' : escapeHtml(candidate.eligibility ?? '')}</small></span><code>${files} files</code><b class="plus">+${additions}</b><b class="minus">-${deletions}</b></button>`;
  }).join('');
}

function renderEvidencePeek(report) {
  const important = [...report.claims].sort((left, right) => {
    const rank = { contradicted: 0, unproven: 1, proven: 2 };
    return rank[left.verdict] - rank[right.verdict];
  }).slice(0, 6);
  if (!important.length) return '<p class="rail-empty">No claims recorded</p>';
  return important.map((claim) => `<button class="evidence-peek verdict-${escapeHtml(claim.verdict)}" data-inspect="claim:${escapeHtml(claim.id)}" data-navigable><span class="status-glyph" aria-hidden="true">${claim.verdict === 'proven' ? '✓' : claim.verdict === 'contradicted' ? '×' : '?'}</span><span><strong>${escapeHtml(claim.rawText)}</strong><small>${escapeHtml(statusLabel(claim.verdict))}</small></span></button>`).join('');
}

function reportStyles() {
  return `
    :root{color-scheme:dark;--bg:#090d12;--panel:#111820;--panel2:#18222e;--line:#2a3948;--text:#f3f7fb;--muted:#aab7c4;--green:#55d98a;--red:#ff6b6b;--amber:#f6c453;--cyan:#66d9ef;--violet:#b69cff;--blue:#67a8ff;--radius:16px;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;overflow-x:hidden;background:radial-gradient(circle at 70% -20%,#172b42 0,transparent 36rem),var(--bg);color:var(--text);line-height:1.5}button,a,input{font:inherit}button,a{min-height:44px}button{color:inherit}a{color:var(--cyan)}:focus-visible{outline:3px solid #fff;outline-offset:3px}.skip-link{position:fixed;left:16px;top:-80px;z-index:100;background:#fff;color:#000;padding:10px 14px}.skip-link:focus{top:16px}.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .app-header{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:16px;min-height:68px;padding:10px max(20px,calc((100vw - 1440px)/2));background:rgba(9,13,18,.9);border-bottom:1px solid var(--line);backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:10px;font-weight:850;letter-spacing:-.03em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--cyan);border-radius:9px;color:var(--cyan);font:800 13px ui-monospace,monospace}.view-nav{display:flex;gap:4px;margin-left:12px}.view-nav a,.view-nav button{display:flex;align-items:center;padding:5px 11px;text-decoration:none;color:var(--muted);border:0;background:transparent;border-radius:9px;cursor:pointer}.view-nav a:hover,.view-nav button:hover{background:var(--panel2);color:var(--text)}.header-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.header-actions button,.toolbar button,.claim-filters button{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:8px 12px;cursor:pointer}.privacy-badge{font-size:12px;color:var(--green);border:1px solid color-mix(in srgb,var(--green),transparent 55%);border-radius:999px;padding:6px 10px}.search{width:min(260px,22vw);height:42px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);padding:0 12px}
    .terminal-main{width:100%;margin:0;padding:0}.session-shell{display:grid;grid-template-columns:250px minmax(420px,1fr) 340px;height:calc(100dvh - 68px);min-height:650px;border-bottom:1px solid var(--line);background:#0b1016}.session-rail,.context-rail{min-width:0;background:#0d131a;overflow:hidden}.session-rail{display:flex;flex-direction:column;border-right:1px solid var(--line)}.context-rail{display:flex;flex-direction:column;border-left:1px solid var(--line)}.rail-header,.session-header,.context-tabs{display:flex;align-items:center;gap:8px;min-height:55px;padding:9px 12px;border-bottom:1px solid var(--line)}.rail-header{justify-content:space-between}.rail-header strong,.session-header strong{font-size:12px}.rail-header button,.session-header button{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:5px 8px;min-height:34px;cursor:pointer;font-size:11px}.rail-session{margin:10px;padding:10px;border:1px solid var(--cyan);border-radius:10px;background:rgba(102,217,239,.05)}.rail-session span,.rail-session small{display:block;color:var(--muted);font-size:10px}.rail-session strong{display:block;margin:3px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.rail-label{padding:8px 12px;color:var(--muted);font:700 9px ui-monospace,monospace;letter-spacing:1.2px;text-transform:uppercase}.rail-tasks{position:relative;flex:1;overflow:auto;padding:0 8px 24px}.rail-tasks:before{content:'';position:absolute;left:22px;top:10px;bottom:28px;border-left:1px solid #314253}.rail-task{position:relative;display:grid;grid-template-columns:20px 1fr;gap:8px;width:100%;padding:8px 5px;border:0;background:transparent;text-align:left;cursor:pointer}.rail-task:hover{background:var(--panel2);border-radius:8px}.rail-node{position:relative;z-index:1;width:10px;height:10px;margin:6px 0 0 5px;border:2px solid var(--blue);border-radius:50%;background:#0d131a}.rail-task.status-completed .rail-node,.rail-task.status-verified .rail-node{border-color:var(--green);background:var(--green)}.rail-task.status-failed .rail-node,.rail-task.status-blocked .rail-node{border-color:var(--red);background:var(--red)}.rail-task-copy{min-width:0}.rail-task-copy small,.rail-task-copy em{display:block;color:var(--muted);font:normal 9px ui-monospace,monospace}.rail-task-copy strong{display:block;margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.rail-empty{padding:14px;color:var(--muted);font-size:11px}.rail-footer{padding:10px 12px;border-top:1px solid var(--line);font:10px ui-monospace,monospace;color:var(--muted)}
    .session-terminal{display:flex;min-width:0;flex-direction:column;background:radial-gradient(circle at 50% -15%,rgba(102,217,239,.055),transparent 28rem),#090e14}.session-header{justify-content:space-between}.session-title{min-width:0}.session-title span{display:block;color:var(--muted);font:10px ui-monospace,monospace}.session-title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-state{display:flex;align-items:center;gap:7px;color:var(--green);font:700 10px ui-monospace,monospace}.session-state:before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.stream-scroll{flex:1;overflow:auto;scrollbar-gutter:stable;padding:24px clamp(16px,4vw,58px)}.execution-stream{width:min(820px,100%);margin:0 auto}.stream-entry{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;margin:0 0 18px;cursor:default}.stream-entry[data-inspect]{cursor:pointer}.stream-avatar{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);font:800 10px ui-monospace,monospace}.stream-content{min-width:0}.stream-content header{display:flex;align-items:baseline;gap:8px}.stream-content header strong{font-size:12px}.stream-content header span{color:var(--muted);font:9px ui-monospace,monospace;text-transform:uppercase}.stream-content p{margin:5px 0;color:#d8e0e8;font-size:13px;white-space:pre-wrap}.stream-content pre{max-height:150px;margin:8px 0;overflow:auto;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#070b10;color:#9dd9e5;font:10px/1.55 ui-monospace,monospace}.entry-user .stream-avatar{border-color:var(--cyan);color:var(--cyan)}.entry-user .stream-content{padding:12px 14px;border:1px solid var(--line);border-radius:4px 14px 14px 14px;background:var(--panel)}.entry-handoff .stream-avatar{border-color:var(--violet);color:var(--violet)}.entry-handoff .stream-content{border-left:2px dashed var(--violet);padding-left:12px}.entry-proof .stream-avatar{border-color:var(--green);color:var(--green)}.entry-verdict{margin-top:30px}.entry-verdict .stream-avatar{border-color:var(--green);background:rgba(85,217,138,.1);color:var(--green)}.entry-verdict .stream-content{padding:17px;border:1px solid rgba(85,217,138,.35);border-radius:4px 16px 16px 16px;background:linear-gradient(135deg,rgba(85,217,138,.07),transparent),var(--panel)}.entry-verdict h2{margin:8px 0 3px;font-size:25px;letter-spacing:-.04em}.inline-metrics{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.inline-metrics span{padding:4px 8px;border:1px solid var(--line);border-radius:999px;font:700 9px ui-monospace,monospace;text-transform:uppercase}.inline-metrics .proven{color:var(--green)}.inline-metrics .contradicted{color:var(--red)}.inline-metrics .unproven{color:var(--amber)}.stream-empty{color:var(--muted);font-size:12px;text-align:center}
    .composer{padding:12px clamp(14px,3vw,40px) 16px;border-top:1px solid var(--line);background:linear-gradient(0deg,#090e14 75%,transparent)}.composer-box{width:min(860px,100%);margin:0 auto;border:1px solid var(--line);border-radius:13px;background:var(--panel);box-shadow:0 16px 50px rgba(0,0,0,.24);overflow:hidden}.composer textarea{display:block;width:100%;height:58px;resize:none;border:0;background:transparent;color:var(--text);padding:12px 14px;outline:0;font:12px/1.5 ui-monospace,monospace}.composer textarea:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}.composer-actions{display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid var(--line)}.composer-actions span{color:var(--muted);font:9px ui-monospace,monospace}.composer-actions button{margin-left:auto;min-height:34px;padding:5px 11px;border:1px solid var(--cyan);border-radius:8px;background:rgba(102,217,239,.09);color:var(--cyan);cursor:pointer;font-size:11px}.composer-actions button:disabled,.composer textarea:disabled{opacity:.5;cursor:not-allowed}
    .context-tabs{padding:8px}.context-tabs button{flex:1;min-height:34px;border:0;border-radius:7px;background:transparent;color:var(--muted);cursor:pointer;font-size:10px}.context-tabs button[aria-selected="true"]{background:var(--panel2);color:var(--text)}.context-panel{flex:1;overflow:auto;padding:9px}.context-agent,.diff-peek,.evidence-peek{display:grid;align-items:center;width:100%;margin-bottom:6px;padding:9px;border:1px solid transparent;border-radius:9px;background:transparent;text-align:left;cursor:pointer}.context-agent:hover,.diff-peek:hover,.evidence-peek:hover{border-color:var(--line);background:var(--panel)}.context-agent{grid-template-columns:28px 1fr auto;gap:8px}.agent-orb{display:grid;place-items:center;width:27px;height:27px;border-radius:8px;background:var(--panel2);color:var(--cyan);font:800 10px ui-monospace,monospace}.context-agent span:nth-child(2),.diff-peek span,.evidence-peek span:last-child{min-width:0}.context-agent strong,.context-agent small,.diff-peek strong,.diff-peek small,.evidence-peek strong,.evidence-peek small{display:block}.context-agent strong,.diff-peek strong,.evidence-peek strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.context-agent small,.diff-peek small,.evidence-peek small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:9px}.context-agent em{color:var(--muted);font:normal 9px ui-monospace,monospace}.diff-peek{grid-template-columns:1fr auto auto auto;gap:8px}.diff-peek code{color:var(--muted);font-size:9px}.diff-peek .plus{color:var(--green);font-size:10px}.diff-peek .minus{color:var(--red);font-size:10px}.diff-peek.is-winner{border-color:rgba(85,217,138,.35);background:rgba(85,217,138,.04)}.evidence-peek{grid-template-columns:24px 1fr;gap:8px}.status-glyph{display:grid;place-items:center;width:22px;height:22px;border:1px solid currentColor;border-radius:7px}.evidence-peek.verdict-proven{color:var(--green)}.evidence-peek.verdict-contradicted{color:var(--red)}.evidence-peek.verdict-unproven{color:var(--amber)}.evidence-peek strong{color:var(--text)}.context-worktrees{margin-top:auto;padding:9px;border-top:1px solid var(--line)}.context-worktrees .worktree-dock{padding:0}.context-worktrees .worktree{max-width:100%;border-radius:8px}.detail-content{width:min(1440px,100%);margin:0 auto;padding:28px}
    .arena-drawer{position:fixed;z-index:65;right:0;top:0;width:min(900px,100%);height:100dvh;padding:18px;border-left:1px solid var(--line);background:#0d141b;box-shadow:-30px 0 90px rgba(0,0,0,.45);overflow:auto;transform:translateX(103%);transition:transform .18s ease}.arena-drawer.is-open{transform:translateX(0)}.drawer-header{display:flex;align-items:center;justify-content:space-between;position:sticky;top:-18px;z-index:1;margin:-18px -18px 14px;padding:16px 18px;border-bottom:1px solid var(--line);background:#0d141b}.drawer-header h2{margin:2px 0}.palette-backdrop{position:fixed;z-index:90;inset:0;display:grid;place-items:start center;padding-top:12vh;background:rgba(0,0,0,.58);backdrop-filter:blur(4px)}.palette{width:min(590px,calc(100% - 24px));border:1px solid var(--line);border-radius:14px;background:#111820;box-shadow:0 28px 90px rgba(0,0,0,.55);overflow:hidden}.palette header{padding:12px;border-bottom:1px solid var(--line)}.palette header strong{font-size:12px}.palette-list{padding:7px}.palette-list button{display:flex;justify-content:space-between;width:100%;padding:9px 11px;border:0;border-radius:8px;background:transparent;color:var(--text);text-align:left;cursor:pointer;font-size:12px}.palette-list button:hover,.palette-list button:focus{background:var(--panel2)}.palette-list kbd{color:var(--muted);font:9px ui-monospace,monospace}.toast{position:fixed;left:50%;bottom:24px;z-index:100;transform:translateX(-50%);padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);box-shadow:0 12px 30px rgba(0,0,0,.3)}
    @keyframes aurora-border{0%{background-position:0 0,0% 50%}50%{background-position:0 0,100% 50%}100%{background-position:0 0,0% 50%}}@keyframes stage-sweep{0%{transform:translateX(-125%);opacity:0}24%{opacity:.8}100%{transform:translateX(210%);opacity:0}}.composer-box.is-live,.context-agent.is-active{border:1px solid transparent;background:linear-gradient(var(--panel),var(--panel)) padding-box,linear-gradient(110deg,#2a3948 0%,#66d9ef 28%,#b69cff 50%,#55d98a 72%,#2a3948 100%) border-box;background-size:100% 100%,260% 100%;animation:aurora-border 7s ease-in-out infinite}.context-agent.is-active{box-shadow:0 0 22px rgba(102,217,239,.055)}.context-agent.is-active em{color:var(--cyan)}.rail-task.status-running{overflow:hidden;border-radius:8px;background:rgba(102,217,239,.035)}.rail-task.status-running:after{content:'';position:absolute;inset:-20% auto -20% 0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent);transform:translateX(-125%);animation:stage-sweep 2.6s ease-out 1;pointer-events:none}.rail-task.status-completed,.rail-task.status-verified{color:var(--green)}
    main{width:min(1440px,100%);margin:0 auto;padding:26px}.outcome-hero{display:grid;grid-template-columns:1fr auto;gap:24px;padding:28px;border:1px solid var(--line);border-radius:22px;background:linear-gradient(135deg,rgba(102,217,239,.08),rgba(182,156,255,.05) 50%,transparent),var(--panel);box-shadow:0 24px 80px rgba(0,0,0,.22)}.eyebrow{display:block;color:var(--cyan);font:700 11px/1.2 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.outcome-hero h1{margin:6px 0 5px;font-size:clamp(30px,4vw,58px);line-height:1;letter-spacing:-.055em}.outcome-hero h2{margin:8px 0;font-size:clamp(20px,2.2vw,31px);letter-spacing:-.03em}.outcome-hero p{max-width:850px;margin:8px 0 0;color:var(--muted);font-size:16px}.receipt{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:8px;text-align:right}.receipt strong{color:var(--green);font-size:15px}.receipt code{font-size:11px;color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(96px,1fr));gap:10px;margin-top:18px}.metric{padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:rgba(9,13,18,.5)}.metric b{display:block;font-size:22px;line-height:1.1}.metric span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.metric.proven b{color:var(--green)}.metric.contradicted b{color:var(--red)}.metric.unproven b{color:var(--amber)}
    .section{scroll-margin-top:90px;margin-top:26px}.section-header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:12px}.section-header h2{margin:0;font-size:22px;letter-spacing:-.025em}.section-header p{max-width:720px;margin:3px 0 0;color:var(--muted)}.command-grid{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:16px}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden}.panel-title{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line)}.panel-title h3{margin:0;font-size:14px}.panel-title span{font-size:12px;color:var(--muted)}
    .dag-scroll{overflow:auto}.dag-canvas{position:relative;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:24px 24px}.dag-edges{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:#42566a;stroke-width:2}.dag-node{position:absolute;width:176px;height:76px;padding:9px 11px;text-align:left;border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:11px;background:#121b24;cursor:pointer;overflow:hidden}.dag-node:hover{transform:translateY(-1px);border-color:var(--cyan)}.dag-node strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;margin-top:5px}.dag-node .eyebrow{font-size:9px}.node-meta{display:block;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-completed,.status-proven,.status-verified,.status-winner{border-left-color:var(--green)!important}.status-failed,.status-blocked,.status-contradicted,.status-conflicted{border-left-color:var(--red)!important}.status-review,.status-unproven,.status-stale{border-left-color:var(--amber)!important}.status-running{border-left-color:var(--cyan)!important}
    .arena-summary{display:flex;flex-direction:column}.candidate-list{padding:10px}.candidate-card{width:100%;display:grid;grid-template-columns:34px 1fr 66px 66px;align-items:center;gap:8px;padding:11px 8px;border:1px solid transparent;border-bottom-color:var(--line);background:transparent;text-align:left;cursor:pointer}.candidate-card:last-child{border-bottom:0}.candidate-card:hover{background:var(--panel2)}.candidate-card.is-winner{border:1px solid color-mix(in srgb,var(--green),transparent 52%);border-radius:12px;background:rgba(85,217,138,.06)}.candidate-index{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--panel2);font:700 12px ui-monospace,monospace}.candidate-copy,.candidate-proof,.candidate-risk{display:flex;flex-direction:column}.candidate-copy small,.candidate-proof small,.candidate-risk small{color:var(--muted);font-size:9px;text-transform:uppercase}.candidate-proof b{color:var(--green)}.candidate-risk b{color:var(--red)}.decision-reason{margin:auto 12px 12px;padding:14px;border-left:3px solid var(--violet);border-radius:0 10px 10px 0;background:var(--panel2);font-size:13px;color:var(--muted)}
    .worktree-dock{display:flex;gap:8px;padding:10px 0;overflow:auto}.worktree{display:flex;align-items:center;gap:7px;flex:0 0 auto;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);cursor:pointer;font-size:11px}.worktree code{color:var(--muted)}.worktree small{color:var(--muted)}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--green)}.status-dirty .status-dot,.status-conflicted .status-dot{background:var(--red)}.status-stale .status-dot{background:var(--amber)}
    .lanes{padding:10px 14px}.agent-lane{display:grid;grid-template-columns:145px minmax(300px,1fr) 74px;align-items:center;gap:12px;min-height:60px;border-bottom:1px solid var(--line)}.agent-lane:last-child{border:0}.lane-label,.lane-cost{display:flex;flex-direction:column}.lane-label span,.lane-cost span{color:var(--muted);font-size:10px}.lane-cost{text-align:right;font-size:12px}.lane-track{position:relative;height:32px;border-radius:8px;background:repeating-linear-gradient(90deg,var(--panel2),var(--panel2) calc(10% - 1px),var(--line) 10%)}.lane-event{position:absolute;top:4px;height:24px;min-height:24px;min-width:28px;padding:0 5px;border:1px solid var(--blue);border-radius:6px;background:#17314a;cursor:pointer;overflow:hidden;font-size:9px;text-transform:uppercase}.event-handoff{border-color:var(--violet);background:#30264b}.event-test,.event-gate,.event-verify{border-color:var(--green);background:#17382a}.event-error,.event-failed{border-color:var(--red);background:#432126}.no-events{position:absolute;inset:7px 10px;color:var(--muted);font-size:11px}
    .table-scroll{overflow:auto;border:1px solid var(--line);border-radius:var(--radius)}table{width:100%;border-collapse:collapse;background:var(--panel)}caption{text-align:left;padding:13px 16px;color:var(--muted);font-size:12px}th,td{padding:13px 15px;border-top:1px solid var(--line);text-align:left;white-space:nowrap}thead th{color:var(--text);font-size:13px;background:var(--panel2)}tbody th{color:var(--muted);font-size:12px}.winner-tag{display:block;width:max-content;margin-top:4px;padding:2px 6px;border-radius:999px;background:rgba(85,217,138,.12);color:var(--green);font-size:9px;text-transform:uppercase}.pill{display:inline-block;padding:3px 8px;border:1px solid var(--line);border-radius:999px;font-size:10px}.status-winner{color:var(--green)}.status-blocked{color:var(--red)}
    .claim-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px}.claim-filters{display:flex;gap:6px;overflow:auto}.claim-filters button[aria-pressed="true"]{border-color:var(--cyan);background:rgba(102,217,239,.09)}.claim-count{color:var(--muted);font-size:12px}.claims{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.claim-card{display:flex;flex-direction:column;min-height:300px;padding:17px;border:1px solid var(--line);border-top:4px solid var(--amber);border-radius:var(--radius);background:var(--panel)}.claim-card.verdict-proven{border-top-color:var(--green)}.claim-card.verdict-contradicted{border-top-color:var(--red)}.claim-card header{display:flex;justify-content:space-between;gap:8px}.claim-id{font:700 10px ui-monospace,monospace;color:var(--muted)}.verdict{display:flex;gap:5px;font-size:10px;font-weight:800}.verdict-proven .verdict{color:var(--green)}.verdict-contradicted .verdict{color:var(--red)}.verdict-unproven .verdict{color:var(--amber)}blockquote{margin:18px 0 10px;font-size:18px;font-weight:720;letter-spacing:-.02em}blockquote:before{content:'“';color:var(--muted)}blockquote:after{content:'”';color:var(--muted)}.claim-card>p{color:var(--muted);font-size:13px}.claim-card details{margin-top:auto;border-top:1px solid var(--line);padding-top:10px}.claim-card summary{cursor:pointer;font-size:12px;font-weight:700}.claim-card summary span{float:right;color:var(--muted)}.evidence-list{padding:0;list-style:none}.evidence-list button{width:100%;display:grid;grid-template-columns:76px 1fr;gap:8px;padding:7px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer;font-size:11px}.evidence-list button span{color:var(--cyan);font:700 9px ui-monospace,monospace;text-transform:uppercase}.remedy{display:flex;flex-direction:column;margin-top:10px;padding:9px;border-radius:8px;background:var(--panel2);font-size:11px}.remedy strong{color:var(--amber)}.text-button{width:max-content;border:0;background:transparent;color:var(--cyan);padding:8px 0;cursor:pointer;font-size:12px}
    .empty{padding:28px;color:var(--muted);text-align:center}.empty.compact{padding:8px;text-align:left}.inspector{position:fixed;z-index:60;top:0;right:0;width:min(520px,100%);height:100dvh;padding:20px;border-left:1px solid var(--line);background:#0d141b;box-shadow:-30px 0 90px rgba(0,0,0,.42);overflow:auto;transform:translateX(103%);transition:transform .18s ease}.inspector.is-open{transform:translateX(0)}.inspector header{display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:-20px;background:#0d141b;padding:12px 0;border-bottom:1px solid var(--line)}.inspector h2{margin:0}.icon-button{width:44px;border:1px solid var(--line);border-radius:10px;background:var(--panel);cursor:pointer}.inspector-body dl{display:grid;grid-template-columns:120px 1fr;gap:8px 12px}.inspector-body dt{color:var(--muted);font-size:11px;text-transform:uppercase}.inspector-body dd{margin:0;overflow-wrap:anywhere}.inspector-body pre{white-space:pre-wrap;word-break:break-word;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--muted);font:11px/1.5 ui-monospace,monospace}.footer{display:flex;justify-content:space-between;gap:20px;margin-top:32px;padding:18px 0;border-top:1px solid var(--line);color:var(--muted);font-size:11px}.toast{position:fixed;left:50%;bottom:24px;z-index:80;transform:translateX(-50%);padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);box-shadow:0 12px 30px rgba(0,0,0,.3)}[hidden]{display:none!important}
    @media(max-width:1100px){.session-shell{grid-template-columns:220px minmax(400px,1fr) 285px}.search{width:170px}.claims{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:920px){.view-nav{display:none}.session-shell{grid-template-columns:minmax(180px,205px) minmax(0,1fr)}.context-rail{display:none}.command-grid{grid-template-columns:1fr}.receipt{align-items:flex-start;text-align:left}.outcome-hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:680px){.terminal-main{padding:0}.app-header{padding:8px 12px}.brand span:last-child,.privacy-badge,.search{display:none}.session-shell{grid-template-columns:1fr;height:calc(100dvh - 60px);min-height:560px}.session-rail{display:none}.stream-scroll{padding:18px 13px}.detail-content{padding:14px}.outcome-hero{padding:20px}.metrics{grid-template-columns:repeat(2,1fr)}.claims{grid-template-columns:1fr}.agent-lane{grid-template-columns:92px minmax(240px,1fr) 54px}.lanes{overflow:auto}.section-header{align-items:start;flex-direction:column}.claim-toolbar{align-items:start;flex-direction:column}.footer{flex-direction:column}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}.composer-box.is-live,.context-agent.is-active{background:var(--panel);border-color:var(--cyan)}.context-agent.is-active em:after{content:' · ACTIVE';color:var(--cyan)}}
    @media print{body{background:#fff;color:#111}.app-header,.header-actions,.view-nav,.claim-toolbar,.inspector,.toast{display:none!important}.panel,.outcome-hero,.claim-card,table{background:#fff;color:#111;box-shadow:none}.section{break-inside:avoid}.claim-card{break-inside:avoid}.muted,p,.node-meta{color:#444!important}}
  `;
}

function reportScript() {
  return `
    (() => {
      const data = JSON.parse(document.getElementById('report-data').textContent);
      const shareCard = JSON.parse(document.getElementById('share-card-data').textContent);
      const inspector = document.getElementById('inspector');
      const inspectorBody = document.getElementById('inspector-body');
      const inspectorTitle = document.getElementById('inspector-title');
      const search = document.getElementById('global-search');
      const arena = document.getElementById('arena-drawer');
      const palette = document.getElementById('command-palette');
      const toast = document.getElementById('toast');
      const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),details>summary,[tabindex]:not([tabindex="-1"])';
      let modalState = null;
      let backgroundState = [];

      function focusableElements(container) {
        return [...container.querySelectorAll(focusableSelector)].filter((node) => !node.hidden && !node.closest('[hidden]') && !node.hasAttribute('inert'));
      }
      function isolateBackground(container) {
        backgroundState = [];
        [...document.body.children].forEach((node) => {
          if (node === container || node === toast) return;
          backgroundState.push({ node, inert: node.hasAttribute('inert') });
          node.setAttribute('inert', '');
        });
      }
      function restoreBackground() {
        backgroundState.forEach(({ node, inert }) => { if (!inert) node.removeAttribute('inert'); });
        backgroundState = [];
      }
      function hideModal(container) {
        if (container === palette) container.hidden = true;
        else container.classList.remove('is-open');
        container.setAttribute('aria-hidden', 'true');
        container.setAttribute('inert', '');
      }
      function closeActiveModal(restoreFocus = true) {
        if (!modalState) return;
        const { container, trigger } = modalState;
        hideModal(container);
        modalState = null;
        restoreBackground();
        if (restoreFocus && trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus();
      }
      function openModal(container, trigger, preferredFocus) {
        const restoreTarget = modalState?.trigger ?? trigger ?? document.activeElement;
        if (modalState) closeActiveModal(false);
        if (container === palette) container.hidden = false;
        else container.classList.add('is-open');
        container.setAttribute('aria-hidden', 'false');
        container.removeAttribute('inert');
        isolateBackground(container);
        modalState = { container, trigger: restoreTarget };
        (preferredFocus ?? focusableElements(container)[0] ?? container).focus();
      }

      const collections = { task: data.tasks, event: data.events, agent: data.agents, candidate: data.candidates, claim: data.claims, evidence: data.evidence, worktree: data.worktrees, handoff: data.handoffs };
      const displayName = (type, item) => item.title || item.label || item.rawText || item.summary || item.id || type;
      const append = (parent, name, value) => {
        if (value == null || value === '' || (Array.isArray(value) && !value.length)) return;
        const dt = document.createElement('dt'); dt.textContent = name.replace(/([A-Z])/g, ' $1');
        const dd = document.createElement('dd');
        dd.textContent = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        parent.append(dt, dd);
      };
      function openInspector(type, id, trigger) {
        const item = (collections[type] || []).find((entry) => String(entry.id) === id);
        if (!item) return;
        inspectorTitle.textContent = displayName(type, item);
        inspectorBody.replaceChildren();
        const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = type + ' · ' + id;
        const dl = document.createElement('dl');
        const preferred = ['status','verdict','summary','rationale','reason','remedy','agentId','taskId','candidateId','worktreeId','startedAt','endedAt','observedAt','durationMs','cost','eligibility','scopeDrift','dependsOn','evidenceIds','counterEvidenceIds','disqualifications'];
        preferred.forEach((key) => append(dl, key, item[key]));
        const raw = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Raw structured record';
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(item, null, 2);
        raw.append(summary, pre); inspectorBody.append(label, dl, raw);
        openModal(inspector, trigger, document.getElementById('close-inspector'));
        history.replaceState(null, '', '#' + type + '/' + encodeURIComponent(id));
      }
      function closeInspector() { if (modalState?.container === inspector) closeActiveModal(); else hideModal(inspector); }
      function announce(message) {
        toast.textContent = message; toast.hidden = false;
        clearTimeout(announce.timer); announce.timer = setTimeout(() => { toast.hidden = true; }, 2800);
      }
      function openArena(trigger) {
        openModal(arena, trigger, document.getElementById('close-arena'));
      }
      function closeArena() { if (modalState?.container === arena) closeActiveModal(); else hideModal(arena); }
      function openPalette(trigger) { openModal(palette, trigger, palette.querySelector('button')); }
      function closePalette(restoreFocus = true) { if (modalState?.container === palette) closeActiveModal(restoreFocus); else hideModal(palette); }
      document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-inspect]');
        if (!trigger) return;
        const [type, ...parts] = trigger.dataset.inspect.split(':');
        openInspector(type, parts.join(':'), trigger);
      });
      document.getElementById('close-inspector').addEventListener('click', closeInspector);
      document.getElementById('close-arena').addEventListener('click', closeArena);
      document.querySelectorAll('[data-open-arena]').forEach((button) => button.addEventListener('click', () => openArena(button)));
      document.getElementById('open-palette').addEventListener('click', (event) => openPalette(event.currentTarget));
      palette.addEventListener('click', (event) => { if (event.target === palette) closePalette(); });

      const contextTabs = [...document.querySelectorAll('[data-context-tab]')];
      function selectContextTab(tab, moveFocus = false) {
        const selected = tab.dataset.contextTab;
        contextTabs.forEach((item) => {
          item.setAttribute('aria-selected', String(item === tab));
          item.setAttribute('tabindex', item === tab ? '0' : '-1');
        });
        document.querySelectorAll('[data-context-panel]').forEach((panel) => { panel.hidden = panel.dataset.contextPanel !== selected; });
        if (moveFocus) tab.focus();
      }
      contextTabs.forEach((tab) => {
        tab.addEventListener('click', () => selectContextTab(tab));
        tab.addEventListener('keydown', (event) => {
          const index = contextTabs.indexOf(tab);
          let next = null;
          if (event.key === 'ArrowRight') next = (index + 1) % contextTabs.length;
          if (event.key === 'ArrowLeft') next = (index - 1 + contextTabs.length) % contextTabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = contextTabs.length - 1;
          if (next == null) return;
          event.preventDefault(); selectContextTab(contextTabs[next], true);
        });
      });

      const filterButtons = [...document.querySelectorAll('[data-claim-filter]')];
      function filterClaims(filter) {
        let visible = 0;
        document.querySelectorAll('[data-claim-verdict]').forEach((card) => {
          const show = filter === 'all' || card.dataset.claimVerdict === filter;
          card.hidden = !show; if (show) visible += 1;
        });
        filterButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.claimFilter === filter)));
        document.getElementById('claim-count').textContent = visible + ' claims shown';
      }
      filterButtons.forEach((button) => button.addEventListener('click', () => filterClaims(button.dataset.claimFilter)));
      filterClaims('all');

      search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        document.querySelectorAll('[data-search]').forEach((node) => { node.hidden = Boolean(query) && !node.dataset.search.includes(query); });
      });
      function download(name, type, content) {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      document.getElementById('download-json').addEventListener('click', () => download(data.mission.id + '-case.json', 'application/json', JSON.stringify(data, null, 2)));
      document.getElementById('download-svg').addEventListener('click', () => download(data.mission.id + '-verdict.svg', 'image/svg+xml', shareCard));
      document.querySelectorAll('[data-palette-action]').forEach((button) => button.addEventListener('click', () => {
        const action = button.dataset.paletteAction;
        const restoreTarget = modalState?.trigger;
        closePalette(false);
        if (action === 'arena') openArena(restoreTarget);
        if (action === 'claims') document.getElementById('evidence').scrollIntoView();
        if (action === 'json') document.getElementById('download-json').click();
        if (action === 'share') document.getElementById('download-svg').click();
        if (action !== 'arena' && restoreTarget?.isConnected) restoreTarget.focus();
      }));

      const composer = document.getElementById('task-composer');
      const commandInput = document.getElementById('task-command');
      document.getElementById('new-task').addEventListener('click', () => commandInput.focus());
      composer.addEventListener('submit', async (event) => {
        event.preventDefault();
        const command = commandInput.value.trim(); if (!command || !data.settings.live) return;
        const submit = composer.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = 'Dispatching…';
        try {
          const response = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, missionId: data.mission.id }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Command was not accepted.');
          commandInput.value = ''; announce('Task dispatched to the live mission.');
        } catch (error) { announce(error.message); }
        finally { submit.disabled = false; submit.textContent = 'Dispatch'; }
      });
      commandInput.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) composer.requestSubmit(); });
      document.addEventListener('keydown', (event) => {
        if (modalState && event.key === 'Tab') {
          const nodes = focusableElements(modalState.container);
          if (!nodes.length) { event.preventDefault(); modalState.container.focus(); return; }
          const first = nodes[0]; const last = nodes[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || !modalState.container.contains(document.activeElement))) { event.preventDefault(); last.focus(); return; }
          if (!event.shiftKey && (document.activeElement === last || !modalState.container.contains(document.activeElement))) { event.preventDefault(); first.focus(); return; }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); modalState?.container === palette ? closePalette() : openPalette(document.activeElement); return; }
        if (event.key === 'Escape') { if (modalState) closeActiveModal(); else { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); } return; }
        if (modalState) return;
        if (event.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { event.preventDefault(); search.focus(); return; }
        if ((event.key === 'j' || event.key === 'k') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
          const nodes = [...document.querySelectorAll('[data-navigable]:not([hidden])')];
          const index = Math.max(0, nodes.indexOf(document.activeElement));
          nodes[(index + (event.key === 'j' ? 1 : -1) + nodes.length) % nodes.length]?.focus();
        }
      });
      const hash = location.hash.match(/^#(task|event|candidate|claim|evidence|worktree|handoff)\\/(.+)$/);
      if (hash) openInspector(hash[1], decodeURIComponent(hash[2]));
      if (data.settings.live && 'EventSource' in window) {
        const source = new EventSource('/events');
        let timer;
        source.addEventListener('mission', () => { clearTimeout(timer); timer = setTimeout(() => location.reload(), 180); });
        source.addEventListener('command', () => announce('Command accepted. Waiting for the next observable event…'));
      }
    })();
  `;
}

/** Generate the complete, dependency-free terminal-first mission dashboard. */
export function createReport(input, options = {}) {
  const report = prepareData(input, options);
  const winner = report.candidates.find((candidate) => candidate.winner);
  const outcome = winner ? `${winner.label} earned merge` : (report.mission.status === 'completed' ? 'Mission completed' : 'No evidence-backed winner');
  const card = createShareCard(report, { prepared: true });
  const baseSha = report.mission.baseSha ?? report.mission.baseRef;
  const headSha = winner?.headSha ?? report.mission.headSha;
  const initials = APP_NAME.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'AR';
  const composerDisabled = report.settings.live ? '' : ' disabled';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="application-name" content="${escapeHtml(APP_NAME)}"><title>${escapeHtml(outcome)} - ${escapeHtml(APP_NAME)}</title><style>${reportStyles()}</style></head>
<body><a class="skip-link" href="#main">Skip to mission session</a>
  <header class="app-header">
    <div class="brand"><span class="brand-mark" aria-hidden="true">${escapeHtml(initials)}</span><span>${escapeHtml(APP_NAME)}</span></div>
    <nav class="view-nav" aria-label="Dashboard sections"><a href="#command">Session</a><a href="#intent">Intent</a><button type="button" data-open-arena>Arena</button><a href="#evidence">Claims</a><button type="button" id="open-palette">Commands</button></nav>
    <div class="header-actions"><span class="privacy-badge">${report.settings.shareSafe ? 'Share-safe' : 'Local detail'} mode</span><label class="sr-only" for="global-search">Search session</label><input class="search" id="global-search" type="search" placeholder="Search session /" autocomplete="off"><button id="download-json" type="button">Case JSON</button><button id="download-svg" type="button">Share card</button></div>
  </header>
  <main class="terminal-main" id="main">
    <section class="session-shell" id="command" aria-label="Coding mission session">
      <aside class="session-rail" aria-label="Sessions and mission DAG">
        <div class="rail-header"><strong>Sessions</strong><button type="button" id="new-task"${composerDisabled}>+ Task</button></div>
        <div class="rail-session"><span>ACTIVE MISSION</span><strong>${escapeHtml(report.mission.title)}</strong><small>${escapeHtml(report.mission.id)} · ${escapeHtml(statusLabel(report.mission.status))}</small></div>
        <div class="rail-label">Mission DAG · ${report.tasks.length} tasks</div><div class="rail-tasks">${renderSessionTasks(report)}</div>
        <div class="rail-footer">base ${escapeHtml(shortSha(baseSha))} -> ${escapeHtml(shortSha(headSha))}</div>
      </aside>

      <section class="session-terminal" aria-labelledby="session-title">
        <header class="session-header"><div class="session-title"><span>${escapeHtml(report.mission.id)}</span><strong id="session-title">${escapeHtml(report.mission.title)}</strong></div><div class="session-state">${escapeHtml(statusLabel(report.mission.status))}</div><button type="button" data-open-arena>${report.candidates.length} candidates</button></header>
        <div class="stream-scroll" id="execution-stream" tabindex="0"><div class="execution-stream">${renderExecutionStream(report)}</div></div>
        <form class="composer" id="task-composer"><div class="composer-box ${report.settings.live ? 'is-live' : ''}"><label class="sr-only" for="task-command">Continue the coding mission</label><textarea id="task-command" name="command" placeholder="${report.settings.live ? 'Give the team its next task, or type / for commands…' : 'Read-only case snapshot - start the local live server to dispatch tasks.'}"${composerDisabled}></textarea><div class="composer-actions"><span>${report.settings.live ? 'LIVE · Ctrl+Enter to dispatch · Ctrl+K commands' : 'SNAPSHOT · observable execution only'}</span><button type="submit"${composerDisabled}>Dispatch</button></div></div></form>
      </section>

      <aside class="context-rail" aria-label="Agent and evidence context">
        <div class="context-tabs" role="tablist" aria-label="Context panels"><button id="context-tab-lanes" role="tab" tabindex="0" aria-selected="true" aria-controls="context-lanes" data-context-tab="lanes">Lanes</button><button id="context-tab-diff" role="tab" tabindex="-1" aria-selected="false" aria-controls="context-diff" data-context-tab="diff">Diff</button><button id="context-tab-proof" role="tab" tabindex="-1" aria-selected="false" aria-controls="context-proof" data-context-tab="proof">Evidence</button></div>
        <div class="context-panel" id="context-lanes" role="tabpanel" aria-labelledby="context-tab-lanes" data-context-panel="lanes">${renderCompactLanes(report)}</div>
        <div class="context-panel" id="context-diff" role="tabpanel" aria-labelledby="context-tab-diff" data-context-panel="diff" hidden>${renderDiffPeek(report)}</div>
        <div class="context-panel" id="context-proof" role="tabpanel" aria-labelledby="context-tab-proof" data-context-panel="proof" hidden>${renderEvidencePeek(report)}</div>
        <div class="context-worktrees"><span class="rail-label">Worktrees</span><div class="worktree-dock">${renderWorktrees(report)}</div></div>
      </aside>
    </section>

    <div class="detail-content">
      <section class="section" id="intent"><div class="section-header"><div><span class="eyebrow">Intent contract</span><h2>Requested, delivered, accounted for</h2><p>The winning patch is mapped back to the original request so missing requirements cannot hide behind a green test run.</p></div></div>${renderIntentCoverage(report)}</section>
      <section class="section" id="arena"><div class="section-header"><div><span class="eyebrow">Arena record</span><h2>Evidence decides the winner</h2><p>Trust and required claims are hard gates; cost and speed only break otherwise valid ties.</p></div><button class="text-button" type="button" data-open-arena>Open comparison drawer</button></div>${renderArenaTable(report)}</section>
      <section class="section" id="evidence"><div class="section-header"><div><span class="eyebrow">Claim trial</span><h2>Claims, not people, are on trial</h2><p>Every statement resolves to proven, contradicted or unproven with a reproducible evidence trail.</p></div></div>
        <div class="claim-toolbar"><div class="claim-filters" role="group" aria-label="Filter claims"><button data-claim-filter="all" aria-pressed="true">All</button><button data-claim-filter="contradicted" aria-pressed="false">Contradicted</button><button data-claim-filter="unproven" aria-pressed="false">Unproven</button><button data-claim-filter="proven" aria-pressed="false">Proven</button></div><span class="claim-count" id="claim-count" aria-live="polite"></span></div>
        <div class="claims">${renderClaims(report)}</div>
      </section>
      <footer class="footer"><span>${escapeHtml(APP_NAME)} ${escapeHtml(VERSION)} - agents race, evidence decides</span><span>Case digest ${escapeHtml(report.digest)}</span></footer>
    </div>
  </main>
  <aside class="arena-drawer" id="arena-drawer" role="dialog" aria-modal="true" aria-labelledby="arena-drawer-title" aria-hidden="true" tabindex="-1" inert><header class="drawer-header"><div><span class="eyebrow">Arena comparison</span><h2 id="arena-drawer-title">Why ${escapeHtml(winner?.label ?? 'no candidate')} won</h2></div><button class="icon-button" id="close-arena" type="button" aria-label="Close Arena comparison">×</button></header><p class="decision-reason">${escapeHtml(reasonText(report))}</p>${renderArenaTable(report)}<div class="worktree-dock">${renderWorktrees(report)}</div></aside>
  <aside class="inspector" id="inspector" role="dialog" aria-modal="true" aria-labelledby="inspector-title" aria-hidden="true" tabindex="-1" inert><header><div><span class="eyebrow">Evidence inspector</span><h2 id="inspector-title">Record</h2></div><button class="icon-button" id="close-inspector" type="button" aria-label="Close inspector">×</button></header><div class="inspector-body" id="inspector-body"></div></aside>
  <div class="palette-backdrop" id="command-palette" aria-hidden="true" tabindex="-1" inert hidden><section class="palette" role="dialog" aria-modal="true" aria-labelledby="palette-title"><header><strong id="palette-title">Command palette</strong></header><div class="palette-list"><button type="button" data-palette-action="arena">Compare Arena candidates <kbd>A</kbd></button><button type="button" data-palette-action="claims">Open claim trial <kbd>E</kbd></button><button type="button" data-palette-action="json">Download case JSON <kbd>J</kbd></button><button type="button" data-palette-action="share">Download verdict card <kbd>S</kbd></button></div></section></div>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  <script type="application/json" id="report-data">${jsonForScript(report)}</script><script type="application/json" id="share-card-data">${jsonForScript(card)}</script><script>${reportScript()}</script>
</body></html>`;
}

function createLegacyReport(input, options = {}) {
  const report = prepareData(input, options);
  const winner = report.candidates.find((candidate) => candidate.winner);
  const outcome = winner ? `${winner.label} earned merge` : (report.mission.status === 'completed' ? 'Mission completed' : 'No evidence-backed winner');
  const card = createShareCard(report, { prepared: true });
  const baseSha = report.mission.baseSha ?? report.mission.baseRef;
  const headSha = winner?.headSha ?? report.mission.headSha;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="application-name" content="${escapeHtml(APP_NAME)}"><title>${escapeHtml(outcome)} · ${escapeHtml(APP_NAME)}</title><style>${reportStyles()}</style></head>
<body><a class="skip-link" href="#main">Skip to mission result</a>
  <header class="app-header">
    <div class="brand"><span class="brand-mark" aria-hidden="true">ER</span><span>${escapeHtml(APP_NAME)}</span></div>
    <nav class="view-nav" aria-label="Dashboard sections"><a href="#command">Command</a><a href="#arena">Arena</a><a href="#evidence">Evidence</a></nav>
    <div class="header-actions"><span class="privacy-badge">${report.settings.shareSafe ? 'Share-safe' : 'Local detail'} mode</span><label class="sr-only" for="global-search">Search dashboard</label><input class="search" id="global-search" type="search" placeholder="Search /" autocomplete="off"><button id="download-json" type="button">Case JSON</button><button id="download-svg" type="button">Share card</button></div>
  </header>
  <main id="main">
    <section class="outcome-hero" aria-labelledby="outcome-title">
      <div><span class="eyebrow">Case ${escapeHtml(report.mission.id)} · ${escapeHtml(statusLabel(report.mission.status))}</span><h1 id="outcome-title">${escapeHtml(outcome)}</h1><h2>${escapeHtml(report.mission.title)}</h2><p>${escapeHtml(reasonText(report))}</p>
        <div class="metrics" aria-label="Mission evidence summary"><div class="metric proven"><b>${report.totals.proven}</b><span>Proven</span></div><div class="metric contradicted"><b>${report.totals.contradicted}</b><span>Contradicted</span></div><div class="metric unproven"><b>${report.totals.unproven}</b><span>Unproven</span></div><div class="metric"><b>${escapeHtml(money(report.mission.totalCost))}</b><span>Total cost</span></div><div class="metric"><b>${escapeHtml(report.mission.durationMs ? formatDuration(report.mission.durationMs) : '—')}</b><span>Wall time</span></div></div>
      </div>
      <div class="receipt"><strong>${report.receipt.signatureStatus ? escapeHtml(statusLabel(report.receipt.signatureStatus)) : 'EVIDENCE RECORDED'}</strong><span>base ${escapeHtml(shortSha(baseSha))} → head ${escapeHtml(shortSha(headSha))}</span><code>${escapeHtml(report.digest.slice(0, 18))}…</code></div>
    </section>

    <section class="section" id="command"><div class="section-header"><div><span class="eyebrow">Command</span><h2>Mission graph and live lanes</h2><p>Tasks, isolated attempts, handoffs and verifier activity share one evidence graph.</p></div></div>
      <div class="command-grid"><section class="panel" aria-labelledby="dag-title"><div class="panel-title"><h3 id="dag-title">Mission DAG</h3><span>${report.tasks.length} tasks</span></div>${renderDag(report)}</section>
      <aside class="panel arena-summary" aria-labelledby="summary-title"><div class="panel-title"><h3 id="summary-title">Arena snapshot</h3><span>${report.candidates.length} candidates</span></div><div class="candidate-list">${renderCandidateCards(report)}</div><p class="decision-reason">${escapeHtml(reasonText(report))}</p></aside></div>
      <div class="worktree-dock" aria-label="Worktree status">${renderWorktrees(report)}</div>
      <section class="panel" aria-labelledby="lanes-title"><div class="panel-title"><h3 id="lanes-title">Agent lanes</h3><span>${report.events.length} observable events · no private chain-of-thought</span></div><div class="lanes">${renderLanes(report)}</div></section>
    </section>

    <section class="section" id="arena"><div class="section-header"><div><span class="eyebrow">Arena</span><h2>Evidence decides the winner</h2><p>Trust and required claims are hard gates; cost and speed only break otherwise valid ties.</p></div></div>${renderArenaTable(report)}</section>

    <section class="section" id="evidence"><div class="section-header"><div><span class="eyebrow">Claim trial</span><h2>Claims, not people, are on trial</h2><p>Every statement resolves to proven, contradicted or unproven with a reproducible evidence trail.</p></div></div>
      <div class="claim-toolbar"><div class="claim-filters" role="group" aria-label="Filter claims"><button data-claim-filter="all" aria-pressed="true">All</button><button data-claim-filter="contradicted" aria-pressed="false">Contradicted</button><button data-claim-filter="unproven" aria-pressed="false">Unproven</button><button data-claim-filter="proven" aria-pressed="false">Proven</button></div><span class="claim-count" id="claim-count" aria-live="polite"></span></div>
      <div class="claims">${renderClaims(report)}</div>
    </section>
    <footer class="footer"><span>${escapeHtml(APP_NAME)} ${escapeHtml(VERSION)} · agents race, evidence decides</span><span>Case digest ${escapeHtml(report.digest)}</span></footer>
  </main>
  <aside class="inspector" id="inspector" aria-labelledby="inspector-title" aria-hidden="true"><header><div><span class="eyebrow">Evidence inspector</span><h2 id="inspector-title">Record</h2></div><button class="icon-button" id="close-inspector" type="button" aria-label="Close inspector">×</button></header><div class="inspector-body" id="inspector-body"></div></aside>
  <script type="application/json" id="report-data">${jsonForScript(report)}</script><script type="application/json" id="share-card-data">${jsonForScript(card)}</script><script>${reportScript()}</script>
</body></html>`;
}

function wrapWords(value, max = 42, lines = 2) {
  const words = text(value).split(/\s+/).filter(Boolean);
  const result = [];
  let line = '';
  for (const word of words) {
    if (!line || `${line} ${word}`.length <= max) line = line ? `${line} ${word}` : word;
    else { result.push(line); line = word; }
    if (result.length === lines) break;
  }
  if (result.length < lines && line) result.push(line);
  if (result.length === lines && words.join(' ').length > result.join(' ').length) result[lines - 1] = `${result[lines - 1].slice(0, Math.max(1, max - 1))}…`;
  return result;
}

function xml(value) {
  return escapeHtml(value);
}

/** Generate a share-safe 1200x630 SVG mission verdict card. */
export function createShareCard(input, options = {}) {
  const report = options.prepared ? input : prepareData(input, { ...options, shareSafe: options.shareSafe !== false });
  const winner = report.candidates.find((candidate) => candidate.winner);
  const title = winner ? `${winner.label} earned merge` : 'No evidence-backed winner';
  const missionLines = wrapWords(report.mission.title, 47, 2);
  const reasonLines = wrapWords(reasonText(report), 63, 2);
  const candidateRows = report.candidates.slice(0, 3).map((candidate, index) => {
    const y = 190 + index * 76;
    const state = candidate.winner ? 'WINNER' : statusLabel(candidate.eligibility);
    const color = candidate.winner ? '#55d98a' : candidate.eligibility === 'blocked' ? '#ff6b6b' : '#f6c453';
    return `<g><rect x="820" y="${y}" width="316" height="60" rx="12" fill="#18222e" stroke="${color}" stroke-opacity=".55"/><circle cx="848" cy="${y + 30}" r="14" fill="${color}" fill-opacity=".13"/><text x="848" y="${y + 35}" text-anchor="middle" class="small strong">${String.fromCharCode(65 + index)}</text><text x="874" y="${y + 25}" class="candidate">${xml(candidate.label.slice(0, 22))}</text><text x="874" y="${y + 43}" class="tiny" fill="${color}">${xml(state)}</text><text x="1115" y="${y + 35}" text-anchor="end" class="small">${candidate.claimCounts.proven}/${candidate.claimTotal}</text></g>`;
  }).join('');
  const missionText = missionLines.map((line, index) => `<text x="64" y="${238 + index * 38}" class="mission">${xml(line)}</text>`).join('');
  const reasonTextSvg = reasonLines.map((line, index) => `<text x="64" y="${334 + index * 24}" class="reason">${xml(line)}</text>`).join('');
  const baseSha = shortSha(report.mission.baseSha ?? report.mission.baseRef);
  const headSha = shortSha(winner?.headSha ?? report.mission.headSha);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="card-title card-desc">
  <title id="card-title">${xml(title)} — ${xml(report.mission.title)}</title><desc id="card-desc">${report.totals.proven} claims proven, ${report.totals.contradicted} contradicted, and ${report.totals.unproven} unproven. ${xml(reasonText(report))}</desc>
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101a24"/><stop offset=".55" stop-color="#090d12"/><stop offset="1" stop-color="#151126"/></linearGradient><style>.brand{font:800 24px ui-sans-serif,system-ui,sans-serif;fill:#f3f7fb}.eyebrow{font:700 13px ui-monospace,monospace;letter-spacing:1.6px;fill:#66d9ef}.verdict{font:850 49px ui-sans-serif,system-ui,sans-serif;letter-spacing:-2px;fill:#f3f7fb}.mission{font:700 27px ui-sans-serif,system-ui,sans-serif;fill:#f3f7fb}.reason{font:400 17px ui-sans-serif,system-ui,sans-serif;fill:#aab7c4}.metric{font:800 25px ui-sans-serif,system-ui,sans-serif;fill:#f3f7fb}.label{font:700 10px ui-monospace,monospace;letter-spacing:1px;fill:#aab7c4}.candidate{font:700 14px ui-sans-serif,system-ui,sans-serif;fill:#f3f7fb}.small{font:600 13px ui-sans-serif,system-ui,sans-serif;fill:#f3f7fb}.strong{font-weight:800}.tiny{font:800 9px ui-monospace,monospace;letter-spacing:1px}.footer{font:500 11px ui-monospace,monospace;fill:#aab7c4}</style></defs>
  <rect width="1200" height="630" fill="url(#bg)"/><path d="M0 0H1200V6H0Z" fill="#66d9ef"/><circle cx="1080" cy="-40" r="280" fill="#66d9ef" opacity=".035"/><circle cx="1160" cy="590" r="230" fill="#b69cff" opacity=".04"/>
  <g transform="translate(64 54)"><rect width="36" height="36" rx="10" fill="none" stroke="#66d9ef"/><text x="18" y="23" text-anchor="middle" class="tiny" fill="#66d9ef">ER</text><text x="50" y="27" class="brand">${xml(APP_NAME)}</text></g>
  <text x="1136" y="70" text-anchor="end" class="eyebrow">CASE ${xml(report.mission.id.slice(0, 24))}</text>
  <text x="64" y="145" class="eyebrow">MISSION VERDICT · ${xml(statusLabel(report.mission.status))}</text><text x="64" y="202" class="verdict">${xml(title.slice(0, 35))}</text>${missionText}${reasonTextSvg}
  <g transform="translate(64 414)"><rect width="198" height="76" rx="13" fill="#111820" stroke="#2a3948"/><text x="18" y="33" class="metric" fill="#55d98a">${report.totals.proven}</text><text x="18" y="55" class="label">PROVEN</text><rect x="210" width="198" height="76" rx="13" fill="#111820" stroke="#2a3948"/><text x="228" y="33" class="metric" fill="#ff6b6b">${report.totals.contradicted}</text><text x="228" y="55" class="label">CONTRADICTED</text><rect x="420" width="198" height="76" rx="13" fill="#111820" stroke="#2a3948"/><text x="438" y="33" class="metric">${xml(money(report.mission.totalCost))}</text><text x="438" y="55" class="label">TOTAL COST</text></g>
  <text x="820" y="154" class="eyebrow">ARENA · ${report.candidates.length} CANDIDATES</text>${candidateRows || '<text x="820" y="220" class="reason">No candidates recorded</text>'}
  <g transform="translate(64 536)"><circle cx="7" cy="7" r="7" fill="#66d9ef"/><path d="M18 7H180" stroke="#42566a" stroke-width="2"/><circle cx="190" cy="7" r="7" fill="#b69cff"/><path d="M201 7H363" stroke="#42566a" stroke-width="2"/><circle cx="373" cy="7" r="7" fill="${winner ? '#55d98a' : '#f6c453'}"/><text x="0" y="30" class="label">PLAN</text><text x="167" y="30" class="label">RACE</text><text x="344" y="30" class="label">EVIDENCE</text></g>
  <line x1="64" y1="585" x2="1136" y2="585" stroke="#2a3948"/><text x="64" y="608" class="footer">${xml(baseSha)} → ${xml(headSha)} · ${xml(formatDuration(report.mission.durationMs || 0))} · DIGEST ${xml(report.digest.slice(0, 16))}</text><text x="1136" y="608" text-anchor="end" class="footer">AGENTS RACE. EVIDENCE DECIDES.</text>
</svg>`;
}

export function createReportBundle(input, options = {}) {
  const prepared = prepareData(input, options);
  return {
    html: createReport(prepared, { ...options, shareSafe: false }),
    svg: createShareCard(prepared, { prepared: true }),
    data: prepared,
  };
}

/** Write a share-safe, standalone case file, data record and social preview. */
export async function writeReportArtifacts(input, options = {}) {
  if (!options.outputDir) throw new Error('writeReportArtifacts requires outputDir.');
  const outputDir = path.resolve(options.outputDir);
  await ensureDir(outputDir);
  const html = path.join(outputDir, 'case.html');
  const json = path.join(outputDir, 'case.json');
  const svg = path.join(outputDir, 'verdict.svg');
  await Promise.all([
    writeText(html, createReport(input, { ...options, shareSafe: true, live: false })),
    writeJson(json, redactForShare(input)),
    writeText(svg, createShareCard(input, { ...options, shareSafe: true })),
  ]);
  return { outputDir, html, json, svg };
}
