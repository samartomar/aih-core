import assert from 'node:assert/strict';

/** npm 11 returns an array; npm 12 keys pack results by package name. */
export function readCorePackMetadata(text) {
  const result = JSON.parse(text);
  const entries = Array.isArray(result) ? result : result && typeof result === 'object' ? Object.values(result) : [];
  assert.equal(entries.length, 1, 'Expected exactly one packed package');
  const packed = entries[0];
  assert.equal(packed?.name, '@aihq/core', 'Expected Core pack metadata');
  assert.ok(typeof packed.filename === 'string' && /^aihq-core-[A-Za-z0-9.+-]+\.tgz$/.test(packed.filename), 'Expected a Core archive filename');
  return packed;
}
