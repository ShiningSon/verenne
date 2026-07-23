import http from 'node:http';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReport, createShareCard, redactForShare } from './report.js';
import { latestMissionId, loadMission, readEvents } from './state.js';
import { readMissionWinnerSeed, runMission } from './mission.js';
import { shortId } from './utils.js';

const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);
const CSRF_COOKIE = 'verenne_csrf';

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function write(response, status, type, body, method = 'GET', extraHeaders = {}) {
  const content = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extraHeaders,
  });
  response.end(method === 'HEAD' ? undefined : content);
}

async function readJsonBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error('Request body exceeds the local composer limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Expected a JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

/**
 * Create a loopback-only dashboard server controller.
 * Call `listen()` to start it, `publish(nextState)` to notify SSE clients, and `close()` to stop it.
 */
export function createReportServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACKS.has(host) && options.allowRemote !== true) {
    throw new Error(`Refusing to expose the dashboard on non-loopback host ${host}. Pass allowRemote: true explicitly to override.`);
  }

  let currentData = options.data ?? options.initialData ?? {};
  let revision = Number(options.revision ?? 0);
  let boundPort = null;
  const clients = new Set();
  const csrfToken = randomBytes(24).toString('base64url');

  async function state() {
    if (typeof options.getData === 'function') {
      const next = await options.getData();
      if (next != null) currentData = next;
    }
    return currentData;
  }

  function event(name, payload) {
    const message = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) response.write(message);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const base = `http://${request.headers.host ?? `${host}:${boundPort ?? options.port ?? 0}`}`;
      const url = new URL(request.url ?? '/', base);
      const method = request.method ?? 'GET';
      const requestHostname = new URL(base).hostname;
      if (requestHostname !== host && !(host === '::1' && requestHostname === '[::1]')) {
        write(response, 421, 'application/json; charset=utf-8', { error: 'Misdirected dashboard request.' }, method);
        return;
      }

      if (method === 'OPTIONS') {
        response.writeHead(204, { Allow: 'GET, HEAD, POST, OPTIONS', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }

      if (url.pathname === '/events' && method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        });
        response.write(`retry: 1200\nevent: ready\ndata: ${JSON.stringify({ revision })}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }

      if (url.pathname === '/api/command' && method === 'POST') {
        const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        const origin = request.headers.origin;
        if (contentType !== 'application/json') {
          write(response, 415, 'application/json; charset=utf-8', { ok: false, error: 'Commands require application/json.' });
          return;
        }
        if (origin && new URL(origin).host !== request.headers.host) {
          write(response, 403, 'application/json; charset=utf-8', { ok: false, error: 'Cross-origin command rejected.' });
          return;
        }
        const headerToken = request.headers['x-verenne-token'];
        const cookieToken = cookieValue(request.headers.cookie, CSRF_COOKIE);
        if (headerToken !== csrfToken && cookieToken !== csrfToken) {
          write(response, 403, 'application/json; charset=utf-8', { ok: false, error: 'Invalid local command token.' });
          return;
        }
        const body = await readJsonBody(request);
        const command = String(body.command ?? body.task ?? '').trim();
        if (!command) {
          write(response, 400, 'application/json; charset=utf-8', { ok: false, error: 'Command cannot be empty.' });
          return;
        }
        if (typeof options.onCommand !== 'function') {
          write(response, 501, 'application/json; charset=utf-8', { ok: false, error: 'This live view has no command handler attached.' });
          return;
        }
        const result = await options.onCommand({ command, body, observedAt: new Date().toISOString() });
        revision += 1;
        event('command', { revision, accepted: true });
        write(response, 202, 'application/json; charset=utf-8', { ok: true, revision, result: result ?? null });
        return;
      }

      if (!['GET', 'HEAD'].includes(method)) {
        write(response, 405, 'application/json; charset=utf-8', { error: 'Method not allowed.' }, method, { Allow: 'GET, HEAD' });
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const data = await state();
        const body = createReport(data, { shareSafe: options.shareSafe !== false, live: typeof options.onCommand === 'function', revision });
        write(response, 200, 'text/html; charset=utf-8', body, method, {
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          'Set-Cookie': `${CSRF_COOKIE}=${csrfToken}; Path=/; HttpOnly; SameSite=Strict`,
        });
        return;
      }

      if (url.pathname === '/api/state') {
        const data = await state();
        const visible = options.shareSafe === false ? data : redactForShare(data);
        write(response, 200, 'application/json; charset=utf-8', { revision, data: visible }, method);
        return;
      }

      if (url.pathname === '/share.svg') {
        const data = await state();
        write(response, 200, 'image/svg+xml; charset=utf-8', createShareCard(data, { shareSafe: options.shareSafe !== false }), method, {
          'Content-Disposition': 'inline; filename="mission-verdict.svg"',
        });
        return;
      }

      if (url.pathname === '/healthz') {
        write(response, 200, 'application/json; charset=utf-8', { ok: true, revision, clients: clients.size }, method);
        return;
      }

      write(response, 404, 'application/json; charset=utf-8', { error: 'Not found.' }, method);
    } catch (error) {
      write(response, error.statusCode ?? 500, 'application/json; charset=utf-8', {
        error: error.statusCode ? error.message : 'Dashboard request failed.',
      });
    }
  });

  const controller = {
    server,
    host,
    get port() { return boundPort; },
    get url() { return boundPort == null ? null : `http://${host === '::1' ? '[::1]' : host}:${boundPort}`; },
    get revision() { return revision; },
    get csrfToken() { return csrfToken; },
    async listen() {
      if (server.listening) return controller;
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen({ host, port: Number(options.port ?? 0) });
      });
      const address = server.address();
      boundPort = typeof address === 'object' && address ? address.port : Number(options.port ?? 0);
      return controller;
    },
    publish(nextData, detail = {}) {
      if (nextData != null) currentData = nextData;
      revision += 1;
      event('mission', { revision, ...detail });
      return revision;
    },
    async close() {
      for (const response of clients) response.end();
      clients.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      boundPort = null;
    },
  };

  return controller;
}

export async function startReportServer(options = {}) {
  const controller = await createReportServer(options).listen();
  if (options.open === true) openBrowser(controller.url);
  return controller;
}

function openBrowser(url) {
  if (!url) return;
  let command;
  let args;
  if (process.platform === 'win32') {
    command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe');
    args = [url];
  } else if (process.platform === 'darwin') {
    command = '/usr/bin/open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {});
    child.unref();
  } catch {
    // The URL is still printed by the CLI when no desktop opener is available.
  }
}

function dashboardData(mission, events) {
  const candidates = mission?.candidates ?? [];
  return {
    mission,
    events,
    worktrees: candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      status: candidate.eligibilityStatus === 'ELIGIBLE' ? 'verified' : 'review',
      headSha: candidate.headSha,
      additions: candidate.stats?.additions,
      deletions: candidate.stats?.deletions,
    })),
  };
}

/** Start a repository-backed command center with live refresh and optional follow-up dispatch. */
export async function startDashboardServer(options = {}) {
  if (!options.repoRoot) return await startReportServer(options);
  let selectedMissionId = options.missionId === 'latest' || !options.missionId
    ? await latestMissionId(options.repoRoot)
    : options.missionId;
  if (!selectedMissionId) throw new Error('No mission found for the dashboard.');

  let lastData;
  const readData = async () => {
    const mission = await loadMission(options.repoRoot, selectedMissionId);
    if (!mission && lastData?.mission?.id === selectedMissionId) return lastData;
    if (!mission) throw new Error(`Mission not found: ${selectedMissionId}`);
    return dashboardData(mission, await readEvents(options.repoRoot, selectedMissionId));
  };
  lastData = await readData();
  let lastRevisionKey = JSON.stringify([lastData.mission?.status, lastData.mission?.endedAt, lastData.events.length]);
  let controller;
  const dispatch = options.onCommand ?? (options.dispatch === false ? undefined : async ({ command, body }) => {
    const previous = lastData.mission;
    const agents = (previous.agents ?? []).map((agent) => agent.id).filter(Boolean);
    const wantsNew = body?.continuation === 'new';
    const seedPatch = !wantsNew && previous.decision?.status === 'READY' && !previous.applied?.commitSha
      ? await readMissionWinnerSeed(options.repoRoot, previous)
      : null;
    const task = seedPatch
      ? `Preserve the previously verified outcome:\n${seedPatch.task}\n\nImplement this follow-up request:\n${command}`
      : command;
    const missionId = shortId('mission');
    selectedMissionId = missionId;
    lastData = dashboardData({
      id: missionId,
      title: command,
      task: command,
      mode: previous.mode ?? 'arena',
      status: 'queued',
      agents: previous.agents,
      tasks: [{ id: 'task-1', title: command, task: command, dependsOn: [] }],
      lineage: seedPatch ? { parentMissionId: seedPatch.parentMissionId, parentCandidateId: seedPatch.parentCandidateId, inheritedDiffDigest: seedPatch.diffDigest } : undefined,
      candidates: [],
      tuning: previous.tuning,
      createdAt: new Date().toISOString(),
    }, []);
    controller?.publish(lastData, { missionId, queued: true });
    void runMission({
      id: missionId,
      repoRoot: options.repoRoot,
      task,
      title: command,
      mode: seedPatch ? 'arena' : previous.mode ?? 'arena',
      base: seedPatch?.baseSha,
      seedPatch,
      agents,
      profile: previous.tuning?.profile,
      model: previous.tuning?.model,
      effort: previous.tuning?.effort,
      variant: previous.tuning?.variant,
    }).then(async (result) => {
      lastData = dashboardData(result.mission, await readEvents(options.repoRoot, missionId));
      controller?.publish(lastData, { missionId, status: result.mission.status });
    }).catch(async () => {
      try { lastData = await readData(); controller?.publish(lastData, { missionId, failed: true }); } catch { /* mission runner reports its own failure */ }
    });
    return { missionId, status: 'queued' };
  });

  controller = createReportServer({ ...options, data: lastData, getData: readData, onCommand: dispatch });
  await controller.listen();
  const timer = setInterval(async () => {
    try {
      const next = await readData();
      const key = JSON.stringify([next.mission?.status, next.mission?.endedAt, next.events.length]);
      if (key !== lastRevisionKey) {
        lastRevisionKey = key;
        lastData = next;
        controller.publish(next, { missionId: selectedMissionId });
      }
    } catch {
      // Keep the local dashboard alive through transient atomic file replacements.
    }
  }, Number(options.pollMs ?? 750));
  timer.unref?.();
  const originalClose = controller.close.bind(controller);
  controller.close = async () => { clearInterval(timer); await originalClose(); };
  if (options.open === true) openBrowser(controller.url);
  return controller;
}
