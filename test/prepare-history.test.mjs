// Routine history of a policy Prepare. Every operation of a requirer requires every operation of the selections it
// requires, so a shared document's operations were repeated once per requiring operation: for the first product's
// 256-selection pick that made the record about 7.2 MB, over the 1 MiB bound, and Prepare reported record-limit.
// History names such a selection once instead, and leaves out `operationSelections` when the review operations already
// carry it; both expand back to exactly what Prepare returned. The first test uses the vendored Catalog 1.7.0 ECC
// content; the second the packed Catalog named by AIH_CATALOG_PACK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../dist/core/index.js';
import { toolBindings } from '../dist/harness/contracts.mjs';
import { catalogRoot } from './real-catalog-fixture.mjs';
import { catalogPack, composePolicy, eccDefault, privateInputsFor, setRequest } from './fixtures/catalog-pack.mjs';

const LIMIT = 1_048_576;
const pack = await catalogPack();
const scratch = mkdtempSync(join(tmpdir(), 'aih-prepare-history-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  rmSync(scratch, { recursive: true, force: true });
  if (pack.folder) rmSync(pack.folder, { recursive: true, force: true });
});
const projectFolder = name => { const folder = join(scratch, name); mkdirSync(folder); return realpathSync(folder); };

/** The saved record, checked against what Prepare returned: each operation's requirements and `operationSelections`. */
function savedHistory(prepared) {
  assert.equal(prepared.record.status, 'written', JSON.stringify(prepared.record));
  assert.ok(!prepared.diagnostics.some(item => item.reason === 'record-limit'), JSON.stringify(prepared.diagnostics));
  const file = join(home, '.aih', 'core', prepared.record.reference);
  const bytes = statSync(file).size;
  assert.ok(bytes <= LIMIT, `history record is ${bytes} bytes`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const operations = record.review.operations;
  assert.equal(operations.length, prepared.review.operations.length);
  const ofSelection = selectionId => operations.filter(operation => operation.selectionId === selectionId).map(operation => operation.id);
  operations.forEach((operation, index) => {
    const returned = prepared.review.operations[index];
    assert.equal(operation.id, returned.id);
    const expanded = [...(operation.requiresSelections ?? []).flatMap(ofSelection), ...operation.requires];
    assert.equal(expanded.length, new Set(expanded).size, `${operation.id}: a requirement is recorded twice`);
    assert.deepEqual(new Set(expanded), new Set(returned.requires), `${operation.id}: requirements`);
  });
  assert.equal(record.operationSelections, undefined, 'operationSelections is derived from the review operations');
  assert.deepEqual(operations.map(({ id, selectionId }) => ({ id, selectionId: selectionId ?? null,
    operationId: selectionId ? id.slice(selectionId.length + 1) : null })), prepared.operationSelections);
  return { record, bytes };
}

test('history names a required shared document selection once and expands to the returned requirements', async () => {
  const path = 'release-ecc.content.json';
  const bytes = readFileSync(join(catalogRoot, path));
  const ecc = JSON.parse(bytes);
  const claude = toolBindings.find(binding => binding.tool === 'claude');
  const agents = ['ecc.agent.a11y-architect', 'ecc.agent.agent-evaluator'];
  const selection = (id, origins, requires) => {
    const found = ecc.items.find(entry => entry.id === id);
    return { id, managementId: `project--aihq.catalog--${id}`, scope: 'project', configuration: {}, requires,
      item: { framework: 'ecc', itemId: id, contentSha256: found.contentSha256, behaviourSha256: found.behaviourSha256 },
      tool: 'claude', name: found.name ?? found.label, kind: found.kind, origins, bindingDigest: claude.digest };
  };
  const policy = { schema: 'urn:aihq:core:execution-policy:1.6.0', mode: 'vibe',
    catalogReleases: [{ framework: 'ecc', source: { kind: 'local', input: 'catalog' }, path,
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }],
    selections: [
      selection('ecc.notices', agents.map(itemId => ({ reasonIncluded: 'required-by', requiredBy: { framework: 'ecc', itemId } })), []),
      ...agents.map(id => selection(id, [{ reasonIncluded: 'chosen' }], ['ecc.notices']))] };
  const project = projectFolder('fixture');
  const prepared = await prepare({ useCase: 'policy', policy, target: { project } },
    { logging: 'on', materialRoots: { catalog: catalogRoot } });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const { record } = savedHistory(prepared);
  const notices = record.review.operations.filter(operation => operation.selectionId === 'ecc.notices');
  assert.ok(notices.length > 1, 'the notices copy has several operations');
  for (const operation of record.review.operations.filter(operation => agents.includes(operation.selectionId))) {
    assert.deepEqual(operation.requiresSelections, ['ecc.notices'], operation.id);
    assert.ok(!operation.requires.some(id => id.startsWith('ecc.notices/')), operation.id);
  }
  // Returned results and the review digest's input are unchanged: only history uses the reference.
  assert.ok(prepared.review.operations.every(operation => !('requiresSelections' in operation)));
});

test('the 256-selection first-product pick prepares with its history saved under 1 MiB', { skip: pack.skip, timeout: 900_000 }, async () => {
  const policy = composePolicy(pack, { sets: [...eccDefault(pack), setRequest(pack, 'superpowers', 'superpowers')], recipeless: true });
  assert.equal(policy.selections.length, 256);
  const project = projectFolder('pack');
  const prepared = await prepare({ useCase: 'policy', policy, target: { project } },
    { logging: 'on', materialRoots: { catalog: pack.root }, privateInputs: privateInputsFor(pack, policy) });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const { bytes } = savedHistory(prepared);
  console.log(`review: ${prepared.review.operations.length} operations; history record ${bytes} bytes`);
});
