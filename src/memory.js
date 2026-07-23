import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.js';
import { ensureDir, sha256, shortId, tokenize } from './utils.js';

function memoryPath(repoRoot) {
  return path.join(repoRoot, STATE_DIR, 'memory.ndjson');
}

function scoreMemory(memory, queryTerms) {
  const searchable = tokenize(`${memory.title} ${memory.content} ${(memory.tags ?? []).join(' ')}`);
  const overlap = queryTerms.filter((term) => searchable.includes(term));
  const recencyDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / 86_400_000);
  const recency = 1 / (1 + recencyDays / 30);
  return overlap.length * 4 + (memory.importance ?? 0.5) * 2 + recency;
}

export function createMemoryStore(repoRoot) {
  return {
    async add(input) {
      const item = {
        id: input.id ?? shortId('mem'),
        type: input.type ?? 'note',
        title: input.title,
        content: input.content,
        tags: [...new Set(input.tags ?? [])],
        importance: input.importance ?? 0.5,
        source: input.source ?? 'human',
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      item.digest = sha256(JSON.stringify(item));
      await ensureDir(path.dirname(memoryPath(repoRoot)));
      await appendFile(memoryPath(repoRoot), `${JSON.stringify(item)}\n`, 'utf8');
      return item;
    },

    async list() {
      try {
        const raw = await readFile(memoryPath(repoRoot), 'utf8');
        return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    async search(query, options = {}) {
      const terms = tokenize(query);
      const items = await this.list();
      return items
        .map((item) => ({ ...item, relevance: scoreMemory(item, terms) }))
        .filter((item) => item.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, options.limit ?? 8);
    },
  };
}
