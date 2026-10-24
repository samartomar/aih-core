import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const schema = path => JSON.parse(readFileSync(new URL(`../src/core/schemas/${path}`, import.meta.url), 'utf8'));
const start = readme.indexOf('\n## What each result status lets you claim\n');
const end = start < 0 ? -1 : readme.indexOf('\n## ', start + 1);
const section = start < 0 ? '' : readme.slice(start, end < 0 ? undefined : end);
const rows = section.split('\n').filter(line => line.startsWith('| `')).map(line =>
  line.slice(1, -1).split(' | ').map(cell => cell.trim()));
const row = (field, value) => rows.find(cells => cells[0] === `\`${field}\`` && cells[1].startsWith(`\`${value}\``));

test('the result-claims table covers every published status value', () => {
  assert.ok(section, 'README has the result-claims section');
  const runs = readdirSync(new URL('../src/core/schemas/run-result/', import.meta.url)).map(name => schema(`run-result/${name}`));
  const removals = readdirSync(new URL('../src/core/schemas/managed-removal-preparation/', import.meta.url))
    .map(name => schema(`managed-removal-preparation/${name}`));
  const expected = [
    ...runs.flatMap(run => run.properties.operations.items.properties.application.enum.map(value => ['application', value])),
    ...runs.flatMap(run => run.properties.operations.items.properties.verification.properties.status.enum
      .map(value => ['verification.status', value])),
    ...removals.flatMap(removal => removal.properties.disposition.enum.map(value => ['disposition', value])),
    ...runs.flatMap(run => run.properties.completion.enum.map(value => ['completion', value])),
  ];
  assert.equal(runs.length > 0 && removals.length > 0, true);
  for (const [field, value] of expected) assert.ok(row(field, value), `missing ${field} ${value}`);
  assert.ok(rows.some(cells => cells[0] === '`verification.status`' && cells[1] === '`unverified`, reason `no-supplied-check`'),
    'missing no-supplied-check row');
});

test('each row states what it establishes and what may and may not be claimed', () => {
  assert.match(section, /\| Field \| Value \| Establishes \| May claim \| May not claim \|/);
  assert.ok(rows.length > 0);
  for (const cells of rows) {
    assert.equal(cells.length, 5, cells.join(' | '));
    for (const cell of cells.slice(2)) assert.ok(cell.length > 0, cells.join(' | '));
  }
});

test('the section explains confirming an unverified removal and the pending 1.4 member values', () => {
  assert.match(section, /applied removal is not by itself "removed"/);
  assert.match(section, /listManagedSelections/);
  assert.match(section, /prepareManagedRemoval/);
  assert.match(section, /run result 1\.4/);
  assert.match(section, /https:\/\/github\.com\/samartomar\/aih-core\/issues\/99/);
});

test('a prepared removal is ready for review only when its inner preparation is ready', () => {
  const prepared = row('disposition', 'prepared');
  assert.ok(prepared);
  assert.match(prepared[2], /`preparation\.status`/);
  assert.match(prepared[2], /`blocked`/);
  assert.match(prepared[3], /only when `preparation\.status` is `ready`/);
});
