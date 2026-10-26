// Shared capability gate for inline, acquired and read-only recipe consumers.
const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'];
export function recipeFormatsForPolicy(schema: unknown): string[] {
  // Execution policy 1.4.0 adds selection metadata only; it admits the recipe formats 1.3.0 admits.
  const policy = schema === 'urn:aihq:core:execution-policy:1.4.0' ? 'urn:aihq:core:execution-policy:1.3.0' : schema;
  const index = versions.findIndex(version => policy === `urn:aihq:core:execution-policy:${version}`);
  return index < 0 ? [] : versions.slice(0, index + 1).map(version => `urn:aihq:core:recipe:${version}`);
}
