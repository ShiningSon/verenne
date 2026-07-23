import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getTrackedFiles } from './git.js';
import { createMemoryStore } from './memory.js';
import { normalizePath, sha256, tokenize, writeText } from './utils.js';

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.lockb']);

function pathScore(filePath, terms, pinned) {
  const normalized = normalizePath(filePath).toLowerCase();
  let score = pinned.some((item) => normalized === item.toLowerCase()) ? 100 : 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += normalized.endsWith(term) ? 12 : 6;
  }
  if (/test|spec/.test(normalized)) score += 2;
  if (/readme|agents\.md|claude\.md/.test(normalized)) score += 4;
  if (/node_modules|vendor|dist|build|coverage/.test(normalized)) score -= 100;
  if (BINARY_EXTENSIONS.has(path.extname(normalized))) score -= 100;
  return score;
}

async function readLimited(filePath, maximum) {
  const buffer = await readFile(filePath);
  const slice = buffer.subarray(0, maximum);
  return { text: slice.toString('utf8'), truncated: buffer.length > maximum, bytes: slice.length };
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function compileContext(repoRoot, task, config, destination) {
  const terms = tokenize(task);
  const pinned = config.context?.include ?? [];
  const maxFiles = config.context?.maxFiles ?? 24;
  const maxBytes = config.context?.maxBytes ?? 120_000;
  const tracked = await getTrackedFiles(repoRoot);
  const ranked = tracked
    .map((filePath) => ({ filePath, score: pathScore(filePath, terms, pinned) }))
    .filter((item) => item.score > -50)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, maxFiles * 3);

  const sections = [];
  let usedBytes = 0;
  const realRoot = await realpath(repoRoot);
  for (const item of ranked) {
    if (sections.length >= maxFiles || usedBytes >= maxBytes) break;
    const remaining = Math.min(20_000, maxBytes - usedBytes);
    if (remaining <= 0) break;
    try {
      const candidate = path.join(repoRoot, item.filePath);
      const resolved = await realpath(candidate);
      if (!isWithin(realRoot, resolved)) continue;
      const content = await readLimited(resolved, remaining);
      usedBytes += content.bytes;
      sections.push({ path: normalizePath(item.filePath), score: item.score, ...content });
    } catch {
      // A tracked file may disappear between discovery and read; omit it from context.
    }
  }

  const memories = await createMemoryStore(repoRoot).search(task, { limit: 6 });
  const markdown = [
    '# Verenne Code context pack',
    '',
    `Task: ${task}`,
    `Files: ${sections.length} · Bytes: ${usedBytes} · Memories: ${memories.length}`,
    '',
    memories.length ? '## Relevant project memory' : '',
    ...memories.flatMap((memory) => [`### ${memory.title}`, memory.content, '']),
    '## Repository context',
    '',
    ...sections.flatMap((section) => [
      `### ${section.path}${section.truncated ? ' (truncated)' : ''}`,
      '```',
      section.text,
      '```',
      '',
    ]),
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');

  await writeText(destination, markdown);
  return {
    path: destination,
    digest: sha256(markdown),
    fileCount: sections.length,
    byteCount: usedBytes,
    memoryCount: memories.length,
    files: sections.map((section) => section.path),
  };
}

export function buildAgentPrompt({ mission, lane, contextPath }) {
  const requirements = (mission.intent?.requirements ?? [])
    .map((item) => `- ${item.id} [${item.required ? 'required' : 'optional'}]: ${item.text}`);
  return [
    `You are lane ${lane.id} in Verenne Code mission ${mission.id}.`,
    '',
    'TASK',
    mission.task,
    '',
    'INTENT CONTRACT',
    ...(requirements.length ? requirements : ['- R01 [required]: Fulfill the task exactly as requested.']),
    '',
    `A curated repository context pack is available at: ${contextPath}`,
    '',
    'WORK RULES',
    '- Work only inside this isolated worktree.',
    '- Do not weaken, delete, skip, focus, or replace tests to make the result look green.',
    '- Do not modify Verenne Code policy or verification inputs.',
    '- Keep the patch within the requested scope.',
    '- Run relevant tests, but do not claim a gate passed unless you observed it.',
    '- Never expose secrets or hidden chain-of-thought. Give concise observable results.',
    '',
    'RESULT CONTRACT',
    'Before finishing, write .verenne-result.json in the worktree root:',
    '{',
    '  "summary": "what changed",',
    '  "claims": [{"id":"C01","kind":"bug_fixed","text":"The reported race is fixed","required":true}],',
    '  "tests": [{"command":"...","exitCode":0}],',
    '  "requirements": [{"id":"R01","status":"completed","paths":["src/example.js"],"gates":["test"],"claims":["C01"],"summary":"how the request was satisfied"}],',
    '  "visualEvidence": [],',
    '  "openRisks": []',
    '}',
    'Map every requirement, including anything incomplete, to changed paths, replay gates, and one or more specific required claim IDs. Generic completion is not proof. The file is a claim; Verenne Code independently checks every link.',
  ].join('\n');
}
