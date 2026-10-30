// Apply at the first product's size: Claude Code with ECC's default pick and Superpowers' starting set, 256 recipe-less
// selections from the packed Catalog named by AIH_CATALOG_PACK, prepared and applied by the real Core into a disposable
// project with routine history on. Apply finishes within a time budget, writes each shared notice copy once and saves
// its history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, prepare } from '../dist/core/index.js';
import { catalogPack, composePolicy, eccDefault, privateInputsFor, setRequest } from './fixtures/catalog-pack.mjs';

// Linear Apply takes a few seconds here; the quadratic one took minutes. The budget leaves room for slower hosts.
const APPLY_BUDGET_MS = Number(process.env.AIH_APPLY_BUDGET_MS ?? 30_000);
const pack = await catalogPack();
const skip = pack.skip;
const scratch = mkdtempSync(join(tmpdir(), 'aih-apply-scale-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
  if (pack.folder) rmSync(pack.folder, { recursive: true, force: true });
});

test('the 256-selection first-product pick applies within budget, writes each notice copy once and saves its history', { skip, timeout: 900_000 }, async () => {
  const policy = composePolicy(pack, { sets: [...eccDefault(pack), setRequest(pack, 'superpowers', 'superpowers')], recipeless: true });
  assert.equal(policy.selections.length, 256);
  const folder = join(scratch, 'project'); mkdirSync(folder);
  const project = realpathSync(folder);
  const controls = { logging: 'on', materialRoots: { catalog: pack.root }, privateInputs: privateInputsFor(pack, policy) };
  const prepared = await prepare({ useCase: 'policy', policy, target: { project } }, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const writes = prepared.review.operations.filter(operation => operation.kind === 'file.write');
  const planned = writes.map(operation => relative(project, operation.details.target).replaceAll('\\', '/'));
  const notices = planned.filter(path => path.startsWith('.aih/notices/ecc/ecc.notices/'));
  console.log(`review: ${prepared.review.operations.length} operations, ${writes.length} file writes onto ${new Set(planned).size} paths; ` +
    `${notices.length} ECC notice writes onto ${new Set(notices).size} paths`);

  const started = performance.now();
  const run = await apply(prepared.prepared, { reviewDigest: prepared.review.reviewDigest, approved: true, origin: 'automation' }, controls);
  const elapsed = performance.now() - started;
  console.log(`apply: ${(elapsed / 1000).toFixed(1)} s, completion ${run.completion}, record ${JSON.stringify(run.record)}`);
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));

  // Each shared notice copy is planned and written once: one copy per framework document and scope.
  assert.ok(notices.length > 0, 'the pick delivers ECC notices');
  assert.equal(notices.length, new Set(notices).size, 'each ECC notice file is planned once');
  assert.equal(planned.length, new Set(planned).size, 'no file is planned twice');
  const written = run.members.filter(member => member.kind === 'file' && member.outcome === 'written')
    .map(member => relative(project, member.path).replaceAll('\\', '/'));
  assert.equal(written.length, new Set(written).size, 'each file is written once');

  // History is saved.
  assert.deepEqual(run.record, { status: 'written', reference: `runs/${run.runId}.json` });
  const history = join(home, '.aih', 'core', run.record.reference);
  assert.ok(existsSync(history));
  assert.equal(JSON.parse(readFileSync(history, 'utf8')).runId, run.runId);

  assert.ok(elapsed < APPLY_BUDGET_MS, `Apply took ${Math.round(elapsed)} ms (budget ${APPLY_BUDGET_MS} ms)`);
});
