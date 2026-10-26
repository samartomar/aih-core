// Shared capability gate for inline, acquired and read-only recipe consumers.
const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'];
export function recipeFormatsForPolicy(schema: unknown): string[] {
  // Execution policy 1.4.0 adds selection metadata and admits the recipe formats 1.3.0 admits, plus recipe 1.4.0
  // (one-member configuration edits and one-server approval).
  if (schema === 'urn:aihq:core:execution-policy:1.4.0') return [...recipeFormatsForPolicy('urn:aihq:core:execution-policy:1.3.0'), 'urn:aihq:core:recipe:1.4.0'];
  const index = versions.findIndex(version => schema === `urn:aihq:core:execution-policy:${version}`);
  return index < 0 ? [] : versions.slice(0, index + 1).map(version => `urn:aihq:core:recipe:${version}`);
}
