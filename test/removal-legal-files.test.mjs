import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLegalFile } from '../dist/core/internal/removal-plan.js';

// Removal preparation 1.2.0 keeps an item's licence and notice files with a changed member; Catalog carries no
// material role for them, so the file name decides.
const legal = name => isLegalFile({ kind: 'file', path: `.claude/skills/item/${name}` });

test('licence and notice file names are recognised with or without a text extension or SPDX-like suffix', () => {
  for (const name of ['LICENSE', 'LICENCE', 'license', 'LICENSE.md', 'LICENSE.txt', 'LICENSES', 'UNLICENSE', 'COPYING', 'COPYING.LESSER',
    'COPYRIGHT', 'NOTICE', 'NOTICES', 'NOTICE.txt', 'THIRD_PARTY_NOTICES.txt', 'ThirdPartyNotices.txt', 'third-party-notices.md',
    'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.MIT', 'LICENSE.Apache-2.0']) assert.equal(legal(name), true, name);
});

test('source files and other names that merely start with a legal word are not kept as licence or notice', () => {
  for (const name of ['license-check.js', 'notice_handler.py', 'licenses.ts', 'notice.sh', 'licensed.md', 'LICENSE.json',
    'copyright-year.js', 'SKILL.md', 'README.md']) assert.equal(legal(name), false, name);
  assert.equal(isLegalFile({ kind: 'block', path: 'LICENSE', blockId: 'b', startMarker: 's', endMarker: 'e' }), false, 'only whole files');
});
