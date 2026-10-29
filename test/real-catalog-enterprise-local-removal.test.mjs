// Enterprise removal must read organization policy from the same place Enterprise Prepare does. The single-managementId
// form accepts the local policy file the removals[] form already accepts, then removes and verifies a real Catalog item.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { sandbox } from './hook-group-fixture.mjs';
import { approve, assertVendoredRelease, controls, realSelections } from './real-catalog-fixture.mjs';
import { recipeIdentity } from './fixtures/github-org.mjs';

let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const open = () => { const s = sandbox('aih-enterprise-local-removal-'); live.push(s); return s; };

const enterprisePolicy = selections => ({ schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'enterprise',
  selections: selections.map((selection, index) => ({ ...selection, organizationSelectionId: `local-org-${index}` })) });

/** One local organization document admitting every selected real recipe and its removal. */
const localOrganization = (s, selections) => {
  const path = join(s.root, 'org-policy.json');
  writeFileSync(path, JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'local-enterprise-org',
    selections: selections.map((selection, index) => ({ selectionId: `local-org-${index}`,
      recipeIdentity: recipeIdentity(selection.recipe.inline), scopes: ['project'], inputs: {}, lifecycle: { remove: true } })) }));
  return { provider: 'local', path };
};

test('the single-managementId form removes an Enterprise item with the same local policy source as removals[]', async () => {
  assertVendoredRelease();
  const s = open();
  const selections = realSelections();
  const source = localOrganization(s, selections);
  const prepared = await prepare({ useCase: 'policy', policy: enterprisePolicy(selections),
    target: { project: s.project }, organizationSource: source }, controls());
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.review.mode, 'enterprise');
  assert.deepEqual(prepared.review.inputs.organization.source, { provider: 'local', fileName: 'org-policy.json' });
  const installed = await apply(prepared.prepared, approve(prepared.review), controls());
  assert.equal(installed.completion, 'complete', JSON.stringify(installed.diagnostics));

  const managementId = 'superpowers.skill.verification-before-completion';
  const skill = '.claude/skills/verification-before-completion/SKILL.md';
  assert.equal(existsSync(join(s.project, skill)), true);

  const removal = await prepareManagedRemoval({ target: { project: s.project }, managementId, scope: 'project',
    mode: 'enterprise', organizationSource: source }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  assert.equal(removal.schema, 'urn:aihq:core:managed-removal-preparation:1.1.0');
  assert.equal(removal.preparation.status, 'ready', JSON.stringify(removal.preparation.diagnostics));
  assert.deepEqual(removal.preparation.review.inputs.organization.source, { provider: 'local', fileName: 'org-policy.json' });

  const run = await apply(removal.preparation.prepared, approve(removal.preparation.review), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.ok(run.operations.length > 0);
  assert.deepEqual([...new Set(run.operations.map(operation => operation.verification.status))], ['passed']);
  assert.deepEqual([...new Set(run.operations.map(operation => operation.verification.reason))], ['member-checked']);
  const removed = run.members.filter(member => member.intent !== 'write');
  assert.ok(removed.length > 0);
  assert.ok(removed.every(member => member.check === 'absent' || member.check === 'present-matching'),
    JSON.stringify(removed.filter(member => !['absent', 'present-matching'].includes(member.check))));
  assert.equal(existsSync(join(s.project, skill)), false);

  const again = await prepareManagedRemoval({ target: { project: s.project }, managementId, scope: 'project',
    mode: 'enterprise', organizationSource: source }, { logging: 'off' });
  assert.equal(again.disposition, 'absent', JSON.stringify(again));
});
