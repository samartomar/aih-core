// The vendored Catalog copy carries only what the removal journeys install: the two hook items, their notices and
// one skill, and ECC's notices with the two agents that share their copy, each byte-checked against its published
// material digest, plus the release documents and provenance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertVendoredRelease, catalogRoot, fileTree, itemOf, realSelections } from './real-catalog-fixture.mjs';

const JOURNEY = ['superpowers.skill.verification-before-completion', 'superpowers.hook.session-start', 'superpowers.notices',
  'extensions.hook.git-guard', 'extensions.notices'];
const SHARED_COPY = ['ecc.notices', 'ecc.agent.a11y-architect', 'ecc.agent.agent-evaluator'];
const ecc = JSON.parse(readFileSync(join(catalogRoot, 'release-ecc.content.json'), 'utf8'));
const eccItem = id => ecc.items.find(item => item.id === id);

test('the vendored Catalog copy holds exactly the journey items, their notices and licences', () => {
  assertVendoredRelease();
  assert.deepEqual(realSelections().map(selection => selection.item.itemId), JOURNEY);
  const provenance = JSON.parse(readFileSync(join(catalogRoot, 'provenance.json'), 'utf8'));
  const materials = new Set([...JOURNEY.map(itemOf), ...SHARED_COPY.map(eccItem)].flatMap(item => item.materials.map(member => member.packagePath)));
  const expected = ['provenance.json', 'rule-texts.json', ...Object.keys(provenance.files), ...materials].sort();
  assert.deepEqual(Object.keys(fileTree(catalogRoot.replace(/[\\/]$/, ''))).sort(), expected);
  assert.equal(expected.length, 44);
  assert.equal(materials.size, 37);
  for (const licence of ['obra/superpowers/5bf4e78011075bcfc0dc295f0724994cd123ee71/LICENSE',
    'samartomar/aih-extensions/2481164a51ea7f9e480d51ef52f3d5cf15b017fa/LICENSE',
    'samartomar/aih-extensions/2481164a51ea7f9e480d51ef52f3d5cf15b017fa/NOTICE.md',
    'samartomar/aih-extensions/2481164a51ea7f9e480d51ef52f3d5cf15b017fa/licenses/addyosmani-agent-skills.LICENSE',
    'samartomar/aih-extensions/2481164a51ea7f9e480d51ef52f3d5cf15b017fa/licenses/mattpocock-skills.LICENSE'])
    assert.ok(materials.has(`release/materials/github.com/${licence}`), licence);
});
