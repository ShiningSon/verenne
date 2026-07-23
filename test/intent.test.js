import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveIntentContract, evaluateIntentCoverage } from '../src/intent.js';

test('intent contract preserves explicit requested outcomes and optionality', () => {
  const contract = deriveIntentContract([
    '- Fix the authentication race',
    '- Add regression coverage',
    '- Optional: update the diagram',
  ].join('\n'));
  assert.equal(contract.requirements.length, 3);
  assert.equal(contract.requirements[0].id, 'R01');
  assert.equal(contract.requirements[0].required, true);
  assert.equal(contract.requirements[2].required, false);
  assert.match(contract.digest, /^[a-f0-9]{64}$/);
});

test('intent coverage distinguishes observed delivery links from unsupported claims', () => {
  const contract = deriveIntentContract('- Fix the race\n- Add a regression test');
  const coverage = evaluateIntentCoverage(contract, {
    requirements: [
      { id: 'R01', status: 'completed', paths: ['src/auth.js'], claims: ['fix'] },
      { id: 'R02', status: 'completed', paths: ['test/auth.test.js'], gates: ['test'], claims: ['regression'] },
    ],
  }, {
    analysis: { changedPaths: ['src/auth.js'] },
    gates: [{ id: 'gate:test', gateId: 'test', status: 'PASS' }],
  }, [
    { id: 'fix', kind: 'bug_fixed', required: true, verdict: 'PROVEN' },
    { id: 'regression', kind: 'tests_added', required: true, verdict: 'PROVEN' },
  ]);
  assert.equal(coverage.requirements[0].status, 'EVIDENCED');
  assert.equal(coverage.requirements[1].status, 'EVIDENCED');
  assert.equal(coverage.counts.evidenced, 2);
  assert.deepEqual(coverage.requiredMissing, []);
});

test('explicitly incomplete required intent blocks eligibility inputs', () => {
  const contract = deriveIntentContract('Implement password reset');
  const coverage = evaluateIntentCoverage(contract, {
    requirements: [{ id: 'R01', status: 'blocked', summary: 'No mail provider configured' }],
  }, { analysis: { changedPaths: [] }, gates: [] });
  assert.deepEqual(coverage.requiredMissing, ['R01']);
  assert.equal(coverage.requirements[0].status, 'MISSING');
});

test('intent links policy gate ids to suite-qualified replay evidence', () => {
  const contract = deriveIntentContract('Tests pass');
  const coverage = evaluateIntentCoverage(contract, {
    requirements: [{ id: 'R01', status: 'completed', gates: ['test'], claims: ['tests'] }],
  }, {
    analysis: { changedPaths: [] },
    gates: [{ id: 'gate:test:candidate', gateId: 'test', status: 'PASS' }],
  }, [
    { id: 'tests', kind: 'tests_passed', required: true, verdict: 'PROVEN' },
  ]);
  assert.equal(coverage.requirements[0].status, 'EVIDENCED');
  assert.deepEqual(coverage.requirements[0].gates, ['test']);
  assert.deepEqual(coverage.requiredUnevidenced, []);
});
