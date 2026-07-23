import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, shortId, writeJson } from './utils.js';
import { STATE_DIR } from './config.js';

export function stateRoot(repoRoot) {
  return path.join(repoRoot, STATE_DIR);
}

export function validateMissionId(missionId) {
  const value = String(missionId ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid mission identifier: ${value || '(empty)'}`);
  }
  return value;
}

export function missionDir(repoRoot, missionId) {
  return path.join(stateRoot(repoRoot), 'missions', validateMissionId(missionId));
}

export async function createMissionState(repoRoot, input) {
  const id = input.id ?? shortId('mission');
  const directory = missionDir(repoRoot, id);
  await ensureDir(path.join(directory, 'lanes'));
  await ensureDir(path.join(directory, 'artifacts'));
  const now = new Date().toISOString();
  const mission = {
    schemaVersion: 1,
    id,
    title: input.title ?? input.task,
    task: input.task,
    mode: input.mode,
    status: 'queued',
    repoRoot,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    policy: input.policy,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    agents: input.agents ?? [],
    tasks: input.tasks ?? [],
    intent: input.intent ?? null,
    candidates: [],
    handoffs: [],
    decision: null,
    artifacts: {},
  };
  await writeJson(path.join(directory, 'mission.json'), mission);
  return mission;
}

export async function loadMission(repoRoot, missionId) {
  const id = missionId === 'latest' || !missionId ? await latestMissionId(repoRoot) : missionId;
  if (!id) return null;
  return await readJson(path.join(missionDir(repoRoot, id), 'mission.json'));
}

export async function saveMission(repoRoot, mission) {
  await writeJson(path.join(missionDir(repoRoot, mission.id), 'mission.json'), mission);
  return mission;
}

export async function recordEvent(repoRoot, missionId, event) {
  const complete = {
    id: event.id ?? shortId('evt'),
    observedAt: new Date().toISOString(),
    ...event,
  };
  const filePath = path.join(missionDir(repoRoot, missionId), 'events.ndjson');
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(complete)}\n`, 'utf8');
  return complete;
}

export async function readEvents(repoRoot, missionId) {
  try {
    const raw = await readFile(path.join(missionDir(repoRoot, missionId), 'events.ndjson'), 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function latestMissionId(repoRoot) {
  const index = await readJson(path.join(stateRoot(repoRoot), 'index.json'), { missions: [] });
  return index.missions.at(-1)?.id ?? null;
}

export async function indexMission(repoRoot, mission) {
  const filePath = path.join(stateRoot(repoRoot), 'index.json');
  const index = await readJson(filePath, { schemaVersion: 1, missions: [] });
  const existing = index.missions.findIndex((item) => item.id === mission.id);
  const summary = { id: mission.id, title: mission.title, mode: mission.mode, status: mission.status, createdAt: mission.createdAt, endedAt: mission.endedAt };
  if (existing >= 0) index.missions[existing] = summary;
  else index.missions.push(summary);
  await writeJson(filePath, index);
}
