import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { readJson, writeJson, writeText } from './utils.js';
import { createAbortError, runProcess, commandExists, throwIfAborted } from './process.js';

const BUILTIN_ADAPTER_PRIORITY = Object.freeze({
  claude: 500,
  codex: 490,
  opencode: 480,
  gemini: 470,
  aider: 460,
});

function interpolate(value, variables) {
  return String(value).replace(/\{([a-z_]+)\}/gi, (_, name) => variables[name] ?? `{${name}}`);
}

function tuningValue(value, label) {
  if (value == null || value === '') return undefined;
  const normalized = String(value).trim();
  if (!normalized || /[\0\r\n]/u.test(normalized)) throw new Error(`${label} contains invalid control characters.`);
  return normalized;
}

function normalizeTuning(tuning = {}) {
  return {
    profile: tuningValue(tuning.profile, 'Profile'),
    model: tuningValue(tuning.model, 'Model'),
    effort: tuningValue(tuning.effort, 'Effort'),
    variant: tuningValue(tuning.variant, 'Variant'),
  };
}

export function resolveAdapterTuning(config, adapterId, options = {}) {
  const profileName = tuningValue(options.profile, 'Profile');
  const profile = profileName ? config.profiles?.[profileName]?.[adapterId] ?? {} : {};
  const adapter = config.adapters?.[adapterId] ?? {};
  const lookup = (kind) => tuningValue(
    options[kind]?.[adapterId]
      ?? options[kind]?.['*']
      ?? profile[kind]
      ?? adapter[kind],
    kind,
  );
  return {
    profile: profileName,
    model: lookup('model'),
    effort: lookup('effort'),
    variant: lookup('variant'),
  };
}

function assertSafePromptTransport(adapter) {
  const args = adapter.args ?? [];
  if (args.some((arg) => String(arg).includes('{prompt}'))) {
    throw new Error(`${adapter.label ?? 'Adapter'} places the task in process arguments. Use stdin: "prompt" or {prompt_file} so task text is not exposed in the process list.`);
  }
  const usesPromptFile = args.some((arg) => String(arg).includes('{prompt_file}'));
  if (adapter.stdin !== 'prompt' && !usesPromptFile) {
    throw new Error(`${adapter.label ?? 'Adapter'} has no safe prompt transport. Configure stdin: "prompt" or a {prompt_file} argument.`);
  }
  return usesPromptFile;
}

function buildAdapterArgs(adapter, variables, rawTuning) {
  const tuning = normalizeTuning(rawTuning);
  const args = (adapter.args ?? []).map((arg) => interpolate(arg, variables));
  const additions = [];
  for (const [key, templateKey] of [['model', 'modelArgs'], ['effort', 'effortArgs'], ['variant', 'variantArgs']]) {
    if (!tuning[key]) continue;
    const template = adapter[templateKey];
    if (!Array.isArray(template) || template.length === 0) {
      throw new Error(`${adapter.label ?? 'Adapter'} does not declare support for ${key} tuning. Remove the ${key} override or add ${templateKey} to its adapter configuration.`);
    }
    additions.push(...template.map((arg) => interpolate(arg, { ...variables, ...tuning })));
  }
  const position = Math.max(0, Math.min(args.length, Number(adapter.tuningPosition ?? args.length)));
  args.splice(position, 0, ...additions);
  return { args, tuning };
}

function safeEnvironment(config, adapter, extra = {}) {
  const allowed = new Set([...(config.runtime?.allowedEnv ?? []), ...(adapter.allowedEnv ?? [])]);
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key)) environment[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value != null) environment[key] = String(value);
  }
  return environment;
}

function adapterPriority(config, id, adapter) {
  const preferredIndex = (config.defaultAgents ?? []).indexOf(id);
  const preferred = preferredIndex >= 0 ? 10_000 - preferredIndex * 100 : 0;
  const capability = (adapter.modelArgs ? 8 : 0)
    + (adapter.effortArgs ? 4 : 0)
    + (adapter.variantArgs ? 2 : 0)
    + (adapter.stdin === 'prompt' ? 1 : 0);
  return preferred + (BUILTIN_ADAPTER_PRIORITY[id] ?? 100) + capability;
}

export function adapterCapabilities(adapter = {}) {
  return {
    promptTransport: adapter.stdin === 'prompt'
      ? 'stdin'
      : (adapter.args ?? []).some((arg) => String(arg).includes('{prompt_file}')) ? 'file' : 'unsafe',
    structuredOutput: adapter.result === 'stdout',
    model: Array.isArray(adapter.modelArgs),
    effort: Array.isArray(adapter.effortArgs),
    variant: Array.isArray(adapter.variantArgs),
  };
}

export function rankAdapterRows(rows, config = {}) {
  return [...rows].sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    if ((left.priority ?? 0) !== (right.priority ?? 0)) return (right.priority ?? 0) - (left.priority ?? 0);
    return String(left.label ?? left.id).localeCompare(String(right.label ?? right.id));
  });
}

function unavailableGuidance(id, adapter) {
  const label = adapter.label ?? id;
  const command = adapter.command ?? id;
  return `Command "${command}" was not found on PATH. Install and sign in to ${label}, then restart this terminal; or set adapters.${id}.command to its executable.`;
}

export async function inspectAdapters(config, agentIds = Object.keys(config.adapters ?? {}), options = {}) {
  if (!Array.isArray(agentIds)) {
    options = agentIds ?? {};
    agentIds = Object.keys(config.adapters ?? {});
  }
  throwIfAborted(options.signal);
  const ids = [...new Set(agentIds)];
  const detector = options.commandExists ?? commandExists;
  const rows = await Promise.all(ids.map(async (id) => {
    throwIfAborted(options.signal);
    const adapter = config.adapters?.[id];
    if (!adapter) {
      return { id, label: id, available: false, priority: 0, reason: `Adapter "${id}" is not configured.` };
    }
    const available = await detector(adapter.command);
    const tuning = resolveAdapterTuning(config, id, options);
    let version;
    if (available && options.probeVersion === true) {
      const probe = await runProcess(adapter.command, adapter.versionArgs ?? ['--version'], { timeoutMs: 8_000, maxOutputBytes: 16_000, signal: options.signal });
      if (probe.aborted) throw createAbortError(probe.abortReason);
      version = probe.code === 0 ? (probe.stdout || probe.stderr).trim().split(/\r?\n/, 1)[0].slice(0, 160) : undefined;
    }
    return {
      id,
      label: adapter.label ?? id,
      command: adapter.command,
      available,
      priority: adapterPriority(config, id, adapter),
      tuning,
      version,
      capabilities: adapterCapabilities(adapter),
      reason: available ? 'Detected on PATH.' : unavailableGuidance(id, adapter),
    };
  }));
  return options.rank === false ? rows : rankAdapterRows(rows, config);
}

export function explainAdapterFailure(adapter, result) {
  if (!result || (result.code === 0 && !result.timedOut && !result.error)) return null;
  const label = adapter.label ?? adapter.command ?? 'Agent';
  if (result.timedOut) {
    return {
      kind: 'timeout',
      message: `${label} exceeded its time limit.`,
      nextStep: 'Retry with a smaller task or increase runtime.timeoutMs in the project configuration.',
    };
  }
  if (result.error) {
    const missing = /not found|enoent|trusted path/i.test(result.error);
    return {
      kind: missing ? 'unavailable' : 'startup',
      message: missing ? `${label} is not available on PATH.` : `${label} could not start.`,
      nextStep: missing
        ? `Install ${label}, restart the terminal, and run doctor to confirm detection.`
        : 'Run doctor, then check the configured executable and permissions.',
    };
  }
  const authentication = /auth|login|credential|api[ _-]?key|unauthori[sz]ed|forbidden/i.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  return {
    kind: authentication ? 'authentication' : 'exit',
    message: `${label} exited with code ${result.code}.`,
    nextStep: authentication
      ? `Sign in with ${label}'s native CLI (or configure its provider key), then retry.`
      : 'Open the lane stderr log for the provider-native error, fix it, and retry this mission.',
  };
}

function jsonDocuments(output) {
  const text = String(output ?? '').trim();
  if (!text) return [];
  try { return [JSON.parse(text)]; } catch { /* JSONL or mixed provider output */ }
  return text.split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function extractProviderUsage(output) {
  const documents = jsonDocuments(output);
  const openCode = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
  let openCodeSteps = 0;
  for (const document of documents) {
    const part = document?.part ?? document?.properties?.part;
    if (!part || ![document?.type, part?.type].some((value) => ['step_finish', 'step-finish'].includes(String(value)))) continue;
    const tokens = part.tokens;
    if (!tokens || typeof tokens !== 'object') continue;
    const number = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
    openCode.inputTokens += number(tokens.input);
    openCode.outputTokens += number(tokens.output);
    openCode.reasoningTokens += number(tokens.reasoning);
    openCode.cachedInputTokens += number(tokens.cache?.read);
    openCode.cacheWriteTokens += number(tokens.cache?.write);
    openCode.totalTokens += number(tokens.total) || number(tokens.input) + number(tokens.output) + number(tokens.reasoning);
    openCode.costUsd += number(part.cost);
    openCodeSteps += 1;
  }
  if (openCodeSteps > 0) return { ...openCode, source: 'opencode-step-finish', steps: openCodeSteps };

  const metrics = {};
  const aliases = new Map([
    ['inputtokens', 'inputTokens'], ['prompttokens', 'inputTokens'], ['prompttokencount', 'inputTokens'],
    ['outputtokens', 'outputTokens'], ['completiontokens', 'outputTokens'], ['candidatestokencount', 'outputTokens'],
    ['cachedinputtokens', 'cachedInputTokens'], ['cachedprompttokens', 'cachedInputTokens'],
    ['totaltokens', 'totalTokens'], ['totaltokencount', 'totalTokens'],
    ['totalcostusd', 'costUsd'], ['costusd', 'costUsd'],
  ]);
  const seen = new WeakSet();
  const visit = (value, depth = 0) => {
    if (depth > 12 || value == null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const [key, item] of Object.entries(value)) {
      const metric = aliases.get(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const numeric = typeof item === 'number' ? item : typeof item === 'string' && item.trim() ? Number(item) : Number.NaN;
      if (metric && Number.isFinite(numeric) && numeric >= 0) metrics[metric] = Math.max(metrics[metric] ?? 0, numeric);
      visit(item, depth + 1);
    }
  };
  for (const document of documents) visit(document);
  if (Object.keys(metrics).length === 0) return null;
  if (metrics.totalTokens == null && (metrics.inputTokens != null || metrics.outputTokens != null)) {
    metrics.totalTokens = (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
  }
  return { ...metrics, source: 'provider-output' };
}

export async function runAdapter({ config, adapterId, worktreePath, prompt, promptPath, missionId, laneId, onOutput, tuning = {}, signal }) {
  const adapter = config.adapters?.[adapterId];
  if (!adapter) {
    const configured = Object.keys(config.adapters ?? {});
    throw new Error(`Unknown adapter: ${adapterId}. Configured adapters: ${configured.join(', ') || 'none'}.`);
  }
  const usesPromptFile = assertSafePromptTransport(adapter);
  const safePrompt = String(prompt ?? '');
  if (!safePrompt.trim()) throw new Error(`${adapter.label ?? adapterId} received an empty task prompt.`);
  if (usesPromptFile && !promptPath) throw new Error(`${adapter.label ?? adapterId} requires a prompt file, but no promptPath was provided.`);
  const safePromptPath = promptPath ? path.resolve(promptPath) : undefined;
  const variables = { prompt_file: safePromptPath, worktree: worktreePath, mission: missionId, lane: laneId };
  const built = buildAdapterArgs(adapter, variables, tuning);
  const startedAt = new Date().toISOString();
  const result = await runProcess(adapter.command, built.args, {
    cwd: worktreePath,
    timeoutMs: adapter.timeoutMs ?? config.runtime?.timeoutMs,
    env: safeEnvironment(config, adapter, {
      VERENNE_MISSION_ID: missionId,
      VERENNE_LANE_ID: laneId,
      VERENNE_PROMPT_FILE: safePromptPath,
    }),
    input: adapter.stdin === 'prompt' ? safePrompt : undefined,
    onStdout: onOutput,
    onStderr: onOutput,
    signal,
  });
  const endedAt = new Date().toISOString();
  const usage = extractProviderUsage(result.stdout);
  return {
    ...result,
    adapterId,
    model: built.tuning.model,
    effort: built.tuning.effort,
    variant: built.tuning.variant,
    profile: built.tuning.profile,
    failure: explainAdapterFailure(adapter, result),
    usage,
    cost: usage?.costUsd == null ? undefined : { value: usage.costUsd, currency: 'USD', kind: 'provider-reported' },
    startedAt,
    endedAt,
  };
}

export async function readAgentResult(worktreePath, processResult) {
  const contractPath = path.join(worktreePath, '.verenne-result.json');
  let contract;
  try {
    let metadata;
    try { metadata = await stat(contractPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (metadata) {
      if (!metadata.isFile()) throw new Error('Result contract is not a regular file.');
      if (metadata.size > 2_000_000) throw new Error('Result contract exceeds the 2 MB limit.');
      contract = JSON.parse(await readFile(contractPath, 'utf8'));
      if (!contract || Array.isArray(contract) || typeof contract !== 'object') throw new Error('Result contract must be a JSON object.');
      for (const field of ['claims', 'requirements', 'acceptanceCriteria', 'tests', 'visualEvidence', 'screenshots', 'artifacts', 'openRisks']) {
        if (contract[field] != null && !Array.isArray(contract[field])) throw new Error(`Result field ${field} must be an array.`);
        if (contract[field]?.length > 200) throw new Error(`Result field ${field} exceeds the 200-item limit.`);
      }
      if (contract.summary != null && typeof contract.summary !== 'string') throw new Error('Result summary must be a string.');
      if (String(contract.summary ?? '').length > 20_000) throw new Error('Result summary exceeds the 20,000-character limit.');
      const boundedStrings = (value, depth = 0) => {
        if (depth > 8) throw new Error('Result contract nesting exceeds 8 levels.');
        if (typeof value === 'string' && value.length > 100_000) throw new Error('Result contract contains an oversized string.');
        if (Array.isArray(value)) for (const item of value) boundedStrings(item, depth + 1);
        else if (value && typeof value === 'object') for (const item of Object.values(value)) boundedStrings(item, depth + 1);
      };
      boundedStrings(contract);
    }
  } catch (error) {
    return {
      source: '.verenne-result.json:invalid',
      summary: 'The agent wrote an invalid structured result contract.',
      claims: [], requirements: [], tests: [], visualEvidence: [],
      openRisks: [error.message],
      contractError: error.message,
    };
  }
  if (contract) return { source: '.verenne-result.json', ...contract };
  const failure = processResult.failure;
  return {
    source: 'process-output',
    summary: failure
      ? `${failure.message} ${failure.nextStep}`
      : String(processResult.stdout ?? '').trim().slice(-4_000) || String(processResult.stderr ?? '').trim().slice(-4_000) || 'Agent produced no structured summary.',
    claims: failure ? [] : extractFallbackClaims(processResult.stdout),
    tests: [],
    visualEvidence: [],
    openRisks: failure ? [failure.nextStep] : [],
  };
}

function extractFallbackClaims(output) {
  const text = String(output ?? '');
  const claims = [];
  const patterns = [
    ['tests_passed', /(?:all\s+)?tests?\s+(?:are\s+)?pass(?:ed|ing)?/gi],
    ['tests_added', /(?:added|wrote|created)\s+(?:new\s+)?tests?/gi],
    ['docs_updated', /(?:updated|added)\s+(?:the\s+)?(?:docs|documentation|readme)/gi],
    ['no_breaking_changes', /no\s+breaking\s+changes?/gi],
    ['ui_updated', /(?:updated|implemented|built)\s+(?:the\s+)?(?:ui|interface|screen|page)/gi],
    ['security_fixed', /(?:fixed|resolved|patched)\s+(?:the\s+)?(?:security|vulnerability|injection|xss|csrf)/gi],
  ];
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) claims.push({ kind, text: match[0], required: false });
  }
  return claims;
}

function demoRequirements(intent, paths, claims) {
  return (intent?.requirements ?? []).map((requirement) => ({
    id: requirement.id,
    status: 'completed',
    summary: 'Delivered by the scripted product-tour candidate.',
    paths,
    gates: ['trusted-tests'],
    claims,
  }));
}

export async function runScriptedDemoAdapter({ worktreePath, laneId, intent }) {
  const startedAt = new Date().toISOString();
  const sourcePath = path.join(worktreePath, 'src', 'limiter.js');
  const testPath = path.join(worktreePath, 'test', 'limiter.test.js');
  const packagePath = path.join(worktreePath, 'package.json');

  if (laneId === 'sprinter') {
    const packageJson = await readJson(packagePath);
    packageJson.scripts.test = 'node --test test/happy.test.js';
    await writeJson(packagePath, packageJson);
    await writeText(sourcePath, `export function allow(request, limit = 2) {\n  return (request.count ?? 0) < limit;\n}\n`);
    await writeJson(path.join(worktreePath, '.verenne-result.json'), {
      summary: 'Added rate limiting and verified the happy path.',
      claims: [
        { id: 'sprinter-tests', kind: 'tests_passed', text: 'All tests pass.', required: true },
        { id: 'sprinter-feature', kind: 'feature_implemented', text: 'Per-user rate limiting is implemented.', required: true },
        { id: 'sprinter-security', kind: 'security_fixed', text: 'Rate limiting is enforced per user.', required: true },
      ],
      tests: [{ command: 'npm test', exitCode: 0 }],
      requirements: demoRequirements(intent, ['src/limiter.js'], ['sprinter-tests', 'sprinter-feature', 'sprinter-security']),
      visualEvidence: [], openRisks: [],
    });
  } else if (laneId === 'builder') {
    await writeText(sourcePath, [
      'const counters = new Map();',
      '',
      'export function allow(request, limit = 2) {',
      "  const key = request.userId || `ip:${request.ip || 'anonymous'}`;",
      '  const count = counters.get(key) || 0;',
      '  counters.set(key, count + 1);',
      '  return count < limit;',
      '}',
      '',
      'export function reset() { counters.clear(); }',
      '',
    ].join('\n'));
    await writeText(testPath, [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { allow, reset } from '../src/limiter.js';",
      '',
      "test('limits each user independently', () => {",
      '  reset();',
      "  assert.equal(allow({ userId: 'a' }), true);",
      "  assert.equal(allow({ userId: 'a' }), true);",
      "  assert.equal(allow({ userId: 'a' }), false);",
      "  assert.equal(allow({ userId: 'b' }), true);",
      '});',
      '',
    ].join('\n'));
    await writeJson(path.join(worktreePath, '.verenne-result.json'), {
      summary: 'Added isolated per-user counters with regression coverage.',
      claims: [
        { id: 'builder-tests', kind: 'tests_passed', text: 'All trusted tests pass.', required: true },
        { id: 'builder-feature', kind: 'feature_implemented', text: 'Per-user rate limiting is implemented.', required: true },
        { id: 'builder-regression', kind: 'tests_added', text: 'Added a per-user regression test.', required: true },
        { id: 'builder-security', kind: 'security_fixed', text: 'Rate limiting is enforced per user.', required: true },
        { id: 'builder-compat', kind: 'no_breaking_changes', text: 'Existing authentication behavior is unchanged.', required: true },
      ],
      tests: [{ command: 'npm test', exitCode: 0 }],
      requirements: demoRequirements(intent, ['src/limiter.js', 'test/limiter.test.js'], ['builder-tests', 'builder-feature', 'builder-regression', 'builder-security', 'builder-compat']),
      visualEvidence: [], openRisks: [],
    });
  } else {
    await writeText(sourcePath, [
      "import fs from 'node:fs';",
      '',
      'export function allow(request, limit = 2) {',
      "  const database = JSON.parse(fs.readFileSync('./rate-limits.json', 'utf8'));",
      '  database[request.userId] = (database[request.userId] || 0) + 1;',
      "  fs.writeFileSync('./rate-limits.json', JSON.stringify(database));",
      '  return database[request.userId] <= limit;',
      '}',
      '',
    ].join('\n'));
    await writeText(path.join(worktreePath, 'README.md'), '# Rate limiter\n\nNow uses durable per-user counters.\n');
    await writeJson(path.join(worktreePath, '.verenne-result.json'), {
      summary: 'Added durable rate limiting and documentation.',
      claims: [
        { id: 'drifter-tests', kind: 'tests_passed', text: 'Tests pass.', required: true },
        { id: 'drifter-feature', kind: 'feature_implemented', text: 'Durable rate limiting is implemented.', required: true },
        { id: 'drifter-docs', kind: 'docs_updated', text: 'Documentation is updated.', required: false },
        { id: 'drifter-security', kind: 'security_fixed', text: 'Rate limiting is enforced per user.', required: true },
      ],
      tests: [], visualEvidence: [], openRisks: ['Synchronous disk I/O'],
      requirements: demoRequirements(intent, ['src/limiter.js', 'README.md'], ['drifter-tests', 'drifter-feature', 'drifter-security']),
    });
  }

  return {
    command: 'built-in-demo', args: [laneId], code: 0, signal: null,
    stdout: `Demo lane ${laneId} completed.`, stderr: '', timedOut: false,
    outputTruncated: false, durationMs: Date.now() - new Date(startedAt).getTime(),
    adapterId: 'demo', startedAt, endedAt: new Date().toISOString(),
  };
}
