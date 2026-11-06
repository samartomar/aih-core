// The Windows state access-list check ends with an explicit verdict; one it can't reach in time is retried once and
// then stays a refusal that can be retried (`state-protection-unverified`), distinct from a real access-list problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStateAcl, classifyStateProtection, stateProtectionCounts } from '../dist/core/internal/state.js';

test('only the exact ok token with exit 0 admits; a refusal token refuses; anything else is unverified', () => {
  assert.equal(classifyStateProtection({ status: 0, stdout: 'aihq-state:ok' }), 'ok');
  assert.equal(classifyStateProtection({ status: 0, stdout: Buffer.from('aihq-state:ok\r\n') }), 'ok');
  assert.equal(classifyStateProtection({ status: 0, stdout: 'aihq-state:refused' }), 'refused');
  assert.equal(classifyStateProtection({ status: 1, stdout: 'aihq-state:refused' }), 'refused');
  // A stand-in that just exits 0, or prints anything else, never admits.
  assert.equal(classifyStateProtection({ status: 0, stdout: '' }), 'unverified');
  assert.equal(classifyStateProtection({ status: 0, stdout: 'ok' }), 'unverified');
  assert.equal(classifyStateProtection({ status: 1, stdout: 'aihq-state:ok' }), 'unverified');
  assert.equal(classifyStateProtection({ status: 1, stdout: 'aihq-state:error' }), 'unverified');
  assert.equal(classifyStateProtection({ status: null, stdout: '' }), 'unverified');
  assert.equal(classifyStateProtection({ error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: 'aihq-state:ok' }), 'unverified');
  assert.equal(classifyStateProtection({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null }), 'unverified');
});

// A fake slow PowerShell: a Node script that sleeps, reads the paths from standard input, then prints a token.
function fake(sleepMs, token, exitCode = 0) {
  const folder = mkdtempSync(join(tmpdir(), 'aih-fake-ps-'));
  const script = join(folder, 'fake-powershell.mjs');
  writeFileSync(script, `const until = Date.now() + ${sleepMs}; while (Date.now() < until) {}\n` +
    `let input = ''; process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => {\n` +
    `  const paths = input.split('\\n').filter(Boolean).map(line => Buffer.from(line, 'base64').toString('utf8'));\n` +
    `  if (process.env.AIHQ_FAKE_EXPECT && paths.join('|') !== process.env.AIHQ_FAKE_EXPECT) { process.stdout.write('aihq-state:error'); process.exit(1); }\n` +
    `  process.stdout.write(${JSON.stringify(token)}); process.exit(${exitCode}); });\n`);
  return { folder, options: { program: process.execPath, programArgs: [script] } };
}

test('a check that times out is retried once with the longer budget, and its verdict is used', () => {
  const { folder, options } = fake(1500, 'aihq-state:ok');
  try {
    const before = stateProtectionCounts.aclChecks;
    assert.equal(checkStateAcl(folder, false, [folder], { ...options, budgets: [300, 20_000] }), 'ok');
    assert.equal(stateProtectionCounts.aclChecks - before, 2);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a check that never answers in time is unverified after exactly one retry', () => {
  const { folder, options } = fake(3000, 'aihq-state:ok');
  try {
    const before = stateProtectionCounts.aclChecks;
    assert.equal(checkStateAcl(folder, false, [folder], { ...options, budgets: [200, 400] }), 'unverified');
    assert.equal(stateProtectionCounts.aclChecks - before, 2);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a refusal is final and not retried', () => {
  const { folder, options } = fake(0, 'aihq-state:refused');
  try {
    const before = stateProtectionCounts.aclChecks;
    assert.equal(checkStateAcl(folder, false, [folder], { ...options, budgets: [20_000, 20_000] }), 'refused');
    assert.equal(stateProtectionCounts.aclChecks - before, 1);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a program that cannot be started is unverified, and a cancelled operation stops before the retry', () => {
  const missing = join(tmpdir(), 'aih-no-such-powershell', 'powershell.exe');
  assert.equal(checkStateAcl(tmpdir(), false, [tmpdir()], { program: missing, budgets: [1000, 1000] }), 'unverified');
  const controller = new AbortController(); controller.abort();
  assert.throws(() => checkStateAcl(tmpdir(), false, [tmpdir()], { program: missing, signal: controller.signal }), /cancelled/);
});

test('every path of a batch reaches one check, with non-ASCII names intact', () => {
  const { folder, options } = fake(0, 'aihq-state:ok');
  const paths = Array.from({ length: 80 }, (_, index) => join(folder, `receipt-${index}-é.json`));
  const previous = process.env.AIHQ_FAKE_EXPECT;
  process.env.AIHQ_FAKE_EXPECT = paths.join('|');
  try {
    const before = stateProtectionCounts.aclChecks;
    assert.equal(checkStateAcl(folder, false, paths, { ...options, budgets: [20_000] }), 'ok');
    assert.equal(stateProtectionCounts.aclChecks - before, 1);
  } finally {
    if (previous === undefined) delete process.env.AIHQ_FAKE_EXPECT; else process.env.AIHQ_FAKE_EXPECT = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
