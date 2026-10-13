import { codeUnitCompare } from './canonical.js';
import type { MaterialIdentity } from '../types.js';

/** Frozen recipe-identity:1.0.0 descriptor shared by portable authors and Prepare. */
export function recipeIdentityDescriptor(recipeSha256: string, declarations: readonly MaterialIdentity[]) {
  const materials = declarations.map(({ id, sha256, byteLength }) => ({ id, sha256, byteLength }))
    .sort((a, b) => codeUnitCompare(a.id, b.id));
  return { schema: 'urn:aihq:core:recipe-identity:1.0.0', recipeSha256, materials };
}
