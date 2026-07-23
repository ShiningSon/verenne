import readline from 'node:readline';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { findRepoRoot } from './git.js';
import { runMission, verifyCurrentPatch } from './mission.js';
import { createMemoryStore } from './memory.js';
import { loadMission, stateRoot } from './state.js';
import { APP_NAME, VERSION, readJson } from './utils.js';

const MCP_PROTOCOLS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);

const repoProperty = {
  type: 'string',
  description: 'Optional path inside a repository pre-authorized when this MCP server started. Defaults to the startup repository.',
};

const TOOLS = [
  {
    name: 'run_mission',
    description: 'Run coding agents in isolated worktrees and select a patch using independent evidence. Does not apply the winner.',
    inputSchema: {
      type: 'object', required: ['task'], additionalProperties: false,
      properties: {
        task: { type: 'string' },
        mode: { type: 'string', enum: ['arena', 'swarm', 'relay'] },
        agents: { type: 'array', items: { type: 'string' } },
        base: { type: 'string' },
        repo: repoProperty,
      },
    },
  },
  {
    name: 'mission_status', description: 'Read one mission and its evidence-based decision.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, repo: repoProperty }, additionalProperties: false },
  },
  {
    name: 'list_missions', description: 'List local missions for the repository.',
    inputSchema: { type: 'object', properties: { repo: repoProperty }, additionalProperties: false },
  },
  {
    name: 'remember', description: 'Append a project decision, fact, or failure note to local memory.',
    inputSchema: {
      type: 'object', required: ['title', 'content'], additionalProperties: false,
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        repo: repoProperty,
      },
    },
  },
  {
    name: 'recall', description: 'Retrieve relevant project memory for a task.',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 }, repo: repoProperty },
      additionalProperties: false,
    },
  },
  {
    name: 'verify_current_patch', description: 'Verify the current working tree against base-owned policy without running an agent.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, base: { type: 'string' }, repo: repoProperty }, additionalProperties: false },
  },
];

function content(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError };
}

function repoKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function canonicalRepo(value, base = process.cwd()) {
  const requested = path.resolve(base, value ?? '.');
  const root = await findRepoRoot(requested);
  return await realpath(root);
}

/** Resolve and freeze the repository authority granted to one MCP server process. */
export async function createMcpContext(options = {}) {
  const startupRepoRoot = await canonicalRepo(options.repoRoot ?? process.cwd());
  const roots = [startupRepoRoot];
  for (const candidate of options.allowedRepos ?? []) {
    const root = await canonicalRepo(candidate, startupRepoRoot);
    if (!roots.some((item) => repoKey(item) === repoKey(root))) roots.push(root);
  }
  return Object.freeze({
    startupRepoRoot,
    allowedRepoRoots: Object.freeze(roots),
  });
}

async function resolveRepo(value, context) {
  if (value != null && typeof value !== 'string') throw new Error('Repository path must be a string.');
  const root = value
    ? await canonicalRepo(value, context.startupRepoRoot)
    : context.startupRepoRoot;
  const allowed = context.allowedRepoRoots.find((item) => repoKey(item) === repoKey(root));
  if (!allowed) {
    throw new Error('Repository is outside this MCP server\'s startup allowlist. Start a separate server for that repository or authorize it at startup.');
  }
  return allowed;
}

function assertArguments(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.');
  return value;
}

async function callTool(name, rawArgs, context) {
  if (!TOOLS.some((tool) => tool.name === name)) return content({ error: `Unknown tool: ${name}` }, true);
  const args = assertArguments(rawArgs);
  const repoRoot = await resolveRepo(args.repo, context);
  if (name === 'run_mission') {
    const result = await runMission({ repoRoot, task: args.task, mode: args.mode, agents: args.agents, base: args.base });
    return content({ missionId: result.mission.id, status: result.mission.status, decision: result.mission.decision, artifacts: result.artifacts });
  }
  if (name === 'mission_status') {
    const mission = await loadMission(repoRoot, args.id ?? 'latest');
    return content(mission ?? { status: 'not_found' }, !mission);
  }
  if (name === 'list_missions') {
    return content(await readJson(path.join(stateRoot(repoRoot), 'index.json'), { missions: [] }));
  }
  if (name === 'remember') {
    return content(await createMemoryStore(repoRoot).add({ title: args.title, content: args.content, type: args.type, tags: args.tags, source: 'mcp' }));
  }
  if (name === 'recall') {
    return content(await createMemoryStore(repoRoot).search(args.query, { limit: args.limit }));
  }
  return content(await verifyCurrentPatch({ repoRoot, task: args.task, base: args.base }));
}

export async function handleMcpMessage(message, options = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (message.method === 'initialize') {
    const requestedProtocol = message.params?.protocolVersion;
    return {
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: MCP_PROTOCOLS.includes(requestedProtocol) ? requestedProtocol : MCP_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: APP_NAME, version: VERSION },
      },
    };
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } };
  if (message.method === 'tools/call') {
    try {
      const context = options.context ?? await createMcpContext(options);
      const result = await callTool(message.params?.name, message.params?.arguments, context);
      return { jsonrpc: '2.0', id: message.id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id: message.id, result: content({ error: error.message }, true) };
    }
  }
  if (message.method?.startsWith('notifications/')) return null;
  return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

/** Create a handler pinned to a resolved startup repository and optional explicit allowlist. */
export async function createMcpHandler(options = {}) {
  const context = await createMcpContext(options);
  return async (message) => await handleMcpMessage(message, { context });
}

export async function startMcpServer({ input = process.stdin, output = process.stdout, repoRoot, allowedRepos } = {}) {
  const handle = await createMcpHandler({ repoRoot, allowedRepos });
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const response = await handle(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export { TOOLS as mcpTools };
