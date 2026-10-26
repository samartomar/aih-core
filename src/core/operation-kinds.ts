import recipeSchema10 from './schemas/recipe/1.0.0.json' with { type: 'json' };
import recipeSchema11 from './schemas/recipe/1.1.0.json' with { type: 'json' };
import recipeSchema12 from './schemas/recipe/1.2.0.json' with { type: 'json' };
import recipeSchema13 from './schemas/recipe/1.3.0.json' with { type: 'json' };
import recipeSchema14 from './schemas/recipe/1.4.0.json' with { type: 'json' };
import type { Operation, ProcessOperation, Recipe } from './types.js';

/**
 * Whether a fresh Prepare can establish an operation's effects. `observable` operations name a file target whose bytes
 * Prepare reads and compares, so it can report them `already-satisfied`; `opaque` operations run a process whose
 * effects Prepare cannot observe (`opaque-process`). Treat a kind you do not recognize as `opaque`.
 */
export type OperationEffectsVisibility = 'observable' | 'opaque';
export type RecipeOperationKind = Operation['kind'];
export type RecipeSchemaId = Recipe['schema'];
export interface RecipeOperationKindRecord { readonly kind: RecipeOperationKind; readonly effects: OperationEffectsVisibility }

// Prepare's classification: only a process operation is reviewed as `opaque-process`; every other kind
// resolves a target and compares its bytes. Typed against the engine's operation union.
const visibility = { 'file.write': 'observable', 'config.entries': 'observable', 'config.member': 'observable', 'text.block': 'observable',
  'file.remove': 'observable', 'hook.group': 'observable', 'process.run': 'opaque' } as const satisfies
  Record<RecipeOperationKind, OperationEffectsVisibility>;
type OpaqueKind = { [K in RecipeOperationKind]: (typeof visibility)[K] extends 'opaque' ? K : never }[RecipeOperationKind];
const opaqueIsProcess: [OpaqueKind] extends [ProcessOperation['kind']] ?
  [ProcessOperation['kind']] extends [OpaqueKind] ? true : never : never = true;
void opaqueIsProcess;

interface RecipeSchemaShape { $id: string; properties: { operations: { items: { oneOf: { $ref: string }[] } } };
  $defs: Record<string, { properties: { kind: { const: string } } }> }
/** The operation kinds a recipe schema admits, in its declared order. */
function kindsOf(schema: RecipeSchemaShape): readonly RecipeOperationKindRecord[] {
  return Object.freeze(schema.properties.operations.items.oneOf.map(({ $ref }) => {
    const kind = schema.$defs[$ref.slice('#/$defs/'.length)]!.properties.kind.const as RecipeOperationKind;
    if (!Object.hasOwn(visibility, kind)) throw new Error(`Unclassified recipe operation kind ${kind}`);
    return Object.freeze({ kind, effects: visibility[kind] });
  }));
}

/**
 * The operation kinds of each supported recipe format and whether a fresh Prepare can establish their effects,
 * keyed by recipe schema ID. Portable data: importing it performs no host observation.
 */
export const recipeOperationKinds: Readonly<Record<RecipeSchemaId, readonly RecipeOperationKindRecord[]>> = Object.freeze(
  Object.fromEntries([recipeSchema10, recipeSchema11, recipeSchema12, recipeSchema13, recipeSchema14].map(schema =>
    [schema.$id, kindsOf(schema as unknown as RecipeSchemaShape)])) as Record<RecipeSchemaId, readonly RecipeOperationKindRecord[]>);
