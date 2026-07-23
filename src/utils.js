import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'Verenne Code';
export const CLI_NAME = 'verenne';
export const VERSION = '1.0.0';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function shortId(prefix = 'mission') {
  const now = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${prefix}-${now}-${randomBytes(3).toString('hex')}`;
}

export function slug(value, fallback = 'lane') {
  const result = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return result || fallback;
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw new Error(`Cannot read JSON at ${filePath}: ${error.message}`, { cause: error });
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, value, 'utf8');
}

export function formatDuration(milliseconds = 0) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function tokenize(value) {
  return [...new Set(String(value ?? '')
    .toLowerCase()
    .match(/[a-z0-9_./-]{2,}|[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function parseList(value) {
  if (Array.isArray(value)) return value.flatMap(parseList);
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function terminalWidth() {
  return Math.max(72, Math.min(140, process.stdout.columns || 96));
}
