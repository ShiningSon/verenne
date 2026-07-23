import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCurrentPatch } from './mission.js';
import { git } from './git.js';
import { writeReportArtifacts } from './report.js';
import { APP_NAME, VERSION, ensureDir, readJson, writeJson, writeText } from './utils.js';

async function appendEnvironmentFile(env, variable, value) {
  const filePath = env[variable];
  if (filePath) await appendFile(filePath, `${value}\n`, 'utf8');
}

function input(env, name, fallback = '') {
  return env[`INPUT_${name.replaceAll('-', '_').toUpperCase()}`] || fallback;
}

async function loadEvent(env) {
  return env.GITHUB_EVENT_PATH ? await readJson(env.GITHUB_EVENT_PATH, {}) : {};
}

async function loadClaims(value, { repoRoot, event }) {
  if (!value) return [];
  if (value === 'pr-body') {
    const body = event.pull_request?.body ?? '';
    return body.split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s+/.test(line))
      .map((line) => ({
        text: line.replace(/^\s*[-*]\s+/, '').trim(),
        required: true,
        source: 'pull-request-body',
      }))
      .filter((claim) => claim.text);
  }
  const filePath = path.resolve(repoRoot, value);
  const parsed = await readJson(filePath);
  const claims = parsed?.claims ?? parsed;
  if (!Array.isArray(claims)) throw new Error(`Claims file must contain an array: ${filePath}`);
  return claims.map((claim) => typeof claim === 'string'
    ? { text: claim, required: true, source: 'claims-file' }
    : { ...claim, required: claim?.required !== false });
}

function safeRuleId(value, fallback) {
  const result = String(value ?? fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

function safeArtifactUri(value) {
  if (!value) return null;
  const normalized = String(value).replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  return clean === '..' || clean.startsWith('../') ? null : clean.replace(/^\.\//, '');
}

function sarifLocation(value, line) {
  const uri = safeArtifactUri(value);
  if (!uri) return undefined;
  const startLine = Number.isSafeInteger(Number(line)) && Number(line) > 0 ? Number(line) : 1;
  return [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }];
}

/** Build SARIF without exposing absolute runner paths. */
export function createSarif(candidate = {}) {
  const findings = [];
  for (const claim of candidate.claims ?? []) {
    if (claim.verdict !== 'CONTRADICTED') continue;
    findings.push({
      ruleId: safeRuleId(claim.ruleId ?? claim.kind, 'contradicted-claim'),
      level: claim.required ? 'error' : 'warning',
      message: `${claim.text ?? 'Agent claim'}: ${claim.reason ?? claim.rationale ?? 'The claim conflicts with repository evidence.'}`,
      locations: sarifLocation(claim.path ?? claim.paths?.[0], claim.line),
      category: 'claim',
    });
  }
  for (const gate of candidate.gates ?? []) {
    if (!gate.required || !['FAIL', 'ERROR'].includes(gate.status)) continue;
    findings.push({
      ruleId: safeRuleId(`gate-${gate.id ?? gate.gateId ?? gate.kind ?? 'required'}`, 'required-gate'),
      level: 'error',
      message: `${gate.label ?? gate.id ?? 'Required gate'} ${gate.status.toLowerCase()}: ${gate.reason ?? 'Independent replay did not pass.'}`,
      category: 'gate',
    });
  }
  for (const violation of candidate.trustViolations ?? []) {
    findings.push({
      ruleId: safeRuleId(`trust-${violation.id ?? violation.kind ?? 'violation'}`, 'trust-violation'),
      level: ['critical', 'high'].includes(violation.severity) ? 'error' : 'warning',
      message: violation.message ?? violation.reason ?? 'A candidate trust boundary was violated.',
      locations: sarifLocation(violation.path ?? violation.paths?.[0]),
      category: 'trust',
    });
  }

  const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))];
  const rules = ruleIds.map((id) => ({
    id,
    shortDescription: { text: id.replaceAll('-', ' ') },
    defaultConfiguration: {
      level: findings.some((finding) => finding.ruleId === id && finding.level === 'error') ? 'error' : 'warning',
    },
  }));
  const results = findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: finding.level,
    message: { text: finding.message },
    ...(finding.locations ? { locations: finding.locations } : {}),
    properties: { category: finding.category, candidateId: candidate.id ?? 'working-tree' },
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: APP_NAME, semanticVersion: VERSION, rules } },
      results,
    }],
  };
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|').trim();
}

export function buildStepSummary({ verdict, candidate, artifacts }) {
  const counts = candidate.claimCounts ?? {};
  const gates = candidate.gates ?? [];
  const passedGates = gates.filter((gate) => gate.status === 'PASS').length;
  const claims = candidate.claims ?? [];
  return [
    `# ${APP_NAME} verdict: ${verdict}`,
    '',
    '| Proven | Contradicted | Unproven | Gates |',
    '| ---: | ---: | ---: | ---: |',
    `| ${counts.proven ?? 0} | ${counts.contradicted ?? 0} | ${counts.unproven ?? 0} | ${passedGates}/${gates.length} passed |`,
    '',
    ...claims.map((claim) => `- **${claim.verdict}** — ${oneLine(claim.text)}${claim.reason ?? claim.rationale ? `: ${oneLine(claim.reason ?? claim.rationale)}` : ''}`),
    '',
    `Standalone case file: \`${oneLine(artifacts.html)}\``,
    `SARIF results: \`${oneLine(artifacts.sarif)}\``,
  ].join('\n');
}

function escapeWorkflowData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function annotationForClaim(claim) {
  const command = claim.required ? 'error' : 'warning';
  const title = escapeWorkflowProperty('Contradicted agent claim');
  const message = escapeWorkflowData(`${claim.text ?? 'Agent claim'}${claim.reason ? `: ${claim.reason}` : ''}`);
  return `::${command} title=${title}::${message}\n`;
}

function resolveBase(env, event) {
  const value = input(env, 'base')
    || env.GITHUB_BASE_SHA
    || event.merge_group?.base_sha
    || event.pull_request?.base?.sha
    || event.before
    || 'HEAD^';
  if (!/^0+$/.test(value)) return value;
  const defaultBranch = event.repository?.default_branch;
  if (defaultBranch) return `origin/${defaultBranch}`;
  throw new Error('The event has no parent commit. Pass the trusted base explicitly or check out the repository default branch.');
}

async function ensureBaseAvailable(repoRoot, base) {
  const present = await git(['cat-file', '-e', `${base}^{commit}`], { cwd: repoRoot, allowFailure: true });
  if (present.code === 0) return;
  if (!/^[a-f0-9]{40}$/i.test(base)) throw new Error(`Trusted base ${base} is unavailable locally. Use actions/checkout with fetch-depth: 0.`);
  const fetched = await git(['fetch', '--no-tags', '--depth=1', 'origin', base], { cwd: repoRoot, allowFailure: true, timeoutMs: 180_000 });
  if (fetched.code !== 0) throw new Error(`Cannot fetch trusted base ${base}: ${fetched.stderr || fetched.stdout}`);
}

/** Execute the JavaScript action. Dependencies may be injected for deterministic tests. */
export async function runAction(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const verify = options.verify ?? verifyCurrentPatch;
  const reportWriter = options.reportWriter ?? writeReportArtifacts;
  const repoRoot = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  const event = await loadEvent(env);
  const claims = await loadClaims(input(env, 'claims'), { repoRoot, event });
  const base = resolveBase(env, event);
  const task = input(env, 'task', 'Verify pull request claims');
  const outputDir = path.resolve(repoRoot, input(env, 'output', '.verenne/report'));
  await ensureDir(outputDir);
  if (options.verify == null) await ensureBaseAvailable(repoRoot, base);

  const verified = await verify({ repoRoot, base, task, claims, outputDir });
  const verdict = verified.decision.status === 'READY' ? 'VERIFIED' : 'BLOCKED';
  const mission = {
    ...verified.mission,
    status: verdict === 'VERIFIED' ? 'ready' : 'blocked',
    endedAt: new Date().toISOString(),
    candidates: [verified.candidate],
    decision: verified.decision,
    agents: [{ id: 'pull-request', label: 'Pull request' }],
    handoffs: [],
  };
  const reportArtifacts = await reportWriter({ mission, events: [] }, { outputDir });
  const artifacts = {
    ...reportArtifacts,
    sarif: path.join(outputDir, 'results.sarif'),
    summary: path.join(outputDir, 'step-summary.md'),
  };
  await writeJson(artifacts.sarif, createSarif(verified.candidate));

  const counts = verified.candidate.claimCounts ?? { proven: 0, contradicted: 0, unproven: 0 };
  for (const [name, value] of [
    ['verdict', verdict],
    ['proven', counts.proven ?? 0],
    ['contradicted', counts.contradicted ?? 0],
    ['unproven', counts.unproven ?? 0],
    ['report-path', artifacts.html],
    ['sarif-path', artifacts.sarif],
    ['report-json-path', artifacts.json],
    ['share-card-path', artifacts.svg],
  ]) await appendEnvironmentFile(env, 'GITHUB_OUTPUT', `${name}=${value}`);

  const summary = buildStepSummary({ verdict, candidate: verified.candidate, artifacts });
  await writeText(artifacts.summary, `${summary}\n`);
  await appendEnvironmentFile(env, 'GITHUB_STEP_SUMMARY', summary);

  for (const claim of verified.candidate.claims ?? []) {
    if (claim.verdict === 'CONTRADICTED') stdout.write(annotationForClaim(claim));
  }
  return { verdict, exitCode: verdict === 'BLOCKED' ? 2 : 0, artifacts, mission };
}

async function main() {
  const result = await runAction();
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`::error title=Verenne verification failed::${escapeWorkflowData(error.message)}\n`);
    process.exitCode = 1;
  });
}
