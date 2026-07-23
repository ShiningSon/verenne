import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createMcpHandler, handleMcpMessage, mcpTools } from '../src/mcp.js';
import { runProcess } from '../src/process.js';
import { APP_NAME, VERSION } from '../src/utils.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'verenne-mcp-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function makeRepo(root, name) {
  const repo = path.join(root, name);
  await mkdir(repo);
  const result = await runProcess('git', ['init', '-b', 'main'], { cwd: repo, timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr || result.error);
  return repo;
}

function call(id, name, args = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function toolValue(response) {
  return JSON.parse(response.result.content[0].text);
}

test('MCP identity and schemas describe the pinned repository boundary', async () => {
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.equal(response.result.serverInfo.name, APP_NAME);
  assert.equal(response.result.serverInfo.version, VERSION);
  assert.equal(mcpTools.length, 6);
  for (const tool of mcpTools) {
    assert.match(tool.inputSchema.properties.repo.description, /pre-authorized|startup/i);
  }
});

test('MCP negotiates supported legacy clients and declines unknown revisions to the stable current protocol', async () => {
  const legacy = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(legacy.result.protocolVersion, '2025-03-26');
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
});

test('an MCP handler stays pinned to its startup repo and rejects arbitrary repo arguments', async (t) => {
  const root = await temporaryDirectory(t);
  const startup = await makeRepo(root, 'startup');
  const outside = await makeRepo(root, 'outside');
  const nested = path.join(startup, 'nested');
  await mkdir(nested);
  const handle = await createMcpHandler({ repoRoot: startup });

  const defaultResult = await handle(call(1, 'list_missions'));
  assert.equal(defaultResult.result.isError, false);
  assert.deepEqual(toolValue(defaultResult), { missions: [] });

  const nestedResult = await handle(call(2, 'list_missions', { repo: nested }));
  assert.equal(nestedResult.result.isError, false, 'a subdirectory resolving to the startup repo is safe');

  const escaped = await handle(call(3, 'list_missions', { repo: outside }));
  assert.equal(escaped.result.isError, true);
  assert.match(toolValue(escaped).error, /outside.*allowlist|authorize/i);
});

test('additional repositories work only when explicitly allowlisted at server startup', async (t) => {
  const root = await temporaryDirectory(t);
  const startup = await makeRepo(root, 'startup');
  const authorized = await makeRepo(root, 'authorized');
  const handle = await createMcpHandler({ repoRoot: startup, allowedRepos: [authorized] });
  const response = await handle(call(1, 'list_missions', { repo: authorized }));
  assert.equal(response.result.isError, false);
  assert.deepEqual(toolValue(response), { missions: [] });
});

test('MCP returns structured protocol and tool errors', async (t) => {
  const root = await temporaryDirectory(t);
  const startup = await makeRepo(root, 'startup');
  const handle = await createMcpHandler({ repoRoot: startup });
  const invalidArgs = await handle(call(1, 'list_missions', []));
  assert.equal(invalidArgs.result.isError, true);
  assert.match(toolValue(invalidArgs).error, /JSON object/);
  const unknown = await handle(call(2, 'not_a_tool'));
  assert.equal(unknown.result.isError, true);
  assert.match(toolValue(unknown).error, /Unknown tool/);
  const missingMethod = await handle({ jsonrpc: '2.0', id: 3, method: 'missing' });
  assert.equal(missingMethod.error.code, -32601);
});
