export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Diagnostic {
  code: string;
  reason: string;
  message: string;
  path?: string;
  encountered?: string;
  supported?: string[];
  block?: number;
  offset?: number;
  assessedBlocks?: number;
  assessmentLimit?: string;
  guidance?: string;
}
export interface ValidationResult {
  valid: boolean;
  schema?: string;
  diagnostics: Diagnostic[];
}
export interface ParseResult extends ValidationResult { document?: ExecutionPolicy }
export type Slot = { literal: Json } | { input: string };
export interface InputSpec {
  type: 'string' | 'boolean' | 'integer' | 'number';
  required: boolean;
  default?: Json;
  enum?: Json[];
  description?: string;
  sensitive?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export interface TargetPath {
  root: 'project' | 'userHome' | 'userState';
  segments: Slot[];
}
export interface OperationBase {
  id: string;
  purpose: string;
  scope: 'project' | 'user';
  requires: string[];
  checks: string[];
}
export interface FileOperation extends OperationBase {
  kind: 'file.write'; target: TargetPath; content?: Slot; material?: string; mode?: number;
}
export interface ConfigEntrySet { path: string[]; action: 'set'; value: Slot }
export interface ConfigEntryRemove { path: string[]; action: 'remove' }
export interface ConfigOperation extends OperationBase {
  kind: 'config.entries'; target: TargetPath; format: 'json' | 'jsonc' | 'toml' | 'ini' | 'yaml' | 'properties';
  entries: (ConfigEntrySet | ConfigEntryRemove)[];
  /** Recipe 1.4.0: this one-entry edit records a person's OK for one MCP server in `tool`. */
  approval?: ApprovalMarker;
}
/** Recipe 1.4.0: the edit is a tool approval for one server. It is never replaced or adopted, and a different choice is a conflict. */
export interface ApprovalMarker { tool: string }
/** Recipe 1.4.0: add or remove one scalar member of a JSON/JSONC array, keeping every other member. */
export interface ConfigMemberOperation extends OperationBase {
  kind: 'config.member'; target: TargetPath; format: 'json' | 'jsonc'; container: string[]; action: 'add' | 'remove';
  value: { literal: string | boolean | number };
  /** Arrays that must not already hold the value; a value found there is a conflict, never overwritten. */
  exclusiveWith?: string[][];
  approval?: ApprovalMarker;
}
export interface TextBlockOperation extends OperationBase {
  kind: 'text.block'; target: TargetPath; blockId: string;
  startMarker: string; endMarker: string; action: 'set' | 'remove'; content?: Slot;
}
export interface RemoveOperation extends OperationBase {
  kind: 'file.remove'; target: TargetPath;
}
export type Executable = { name: string } | { material: string };
export interface ProcessInvocation {
  executable: Executable; args: Slot[]; cwd: TargetPath; env: Record<string, Slot>;
  stdin?: Slot; timeoutMs?: number; maxOutputBytes?: number; acceptedExitCodes: number[];
}
export interface ProcessOperation extends OperationBase, ProcessInvocation {
  kind: 'process.run'; effects: string[];
}
export type JsonObject = { [key: string]: Json };
/** Recipe 1.1.0: one identified object inside a shared JSON/JSONC array. */
export interface HookGroupOperation extends OperationBase {
  kind: 'hook.group'; target: TargetPath; format: 'json' | 'jsonc'; container: string[]; groupId: string;
  selector: { path: (string | number)[] } & ({ value: string } | { input: string }); action: 'set' | 'remove'; group?: { literal: JsonObject };
  /** Recipe 1.3.0: replace existing scalar leaves with declared input values. */
  groupBindings?: { path: (string | number)[]; value: Slot }[];
}
export type Operation = FileOperation | ConfigOperation | ConfigMemberOperation | TextBlockOperation | RemoveOperation | ProcessOperation | HookGroupOperation;
export interface FileCheck { id: string; purpose: string; kind: 'file.sha256'; target: TargetPath; sha256: string }
export interface ProcessCheck extends ProcessInvocation { id: string; purpose: string; kind: 'process.exit' }
export type RecipeCheck = FileCheck | ProcessCheck;
export type MaterialSource = { kind: 'archive'; url: string; sha256: string; byteLength: number } | { kind: 'local'; input: string };
export interface MaterialIdentity { id: string; sha256: string; byteLength: number }
export interface MaterialMember extends MaterialIdentity { path: string }
export interface InlineMaterial extends MaterialMember { source: MaterialSource }
export interface MaterialRecipeReference {
  source: MaterialSource; path: string; sha256: string; byteLength: number; materials: MaterialMember[];
}
export type Prerequisite = { kind: 'platform'; os: string; architectures: string[] } | { kind: 'executable'; name: string };
export interface Recipe {
  schema: 'urn:aihq:core:recipe:1.0.0' | 'urn:aihq:core:recipe:1.1.0' | 'urn:aihq:core:recipe:1.2.0' | 'urn:aihq:core:recipe:1.3.0' | 'urn:aihq:core:recipe:1.4.0';
  id: string;
  description: string;
  inputs: Record<string, InputSpec>;
  materials: (InlineMaterial | MaterialIdentity)[];
  targets: ('project' | 'user')[];
  prerequisites: Prerequisite[];
  operations: Operation[];
  checks: RecipeCheck[];
}
/** Catalog's qualified inclusion identity: one reason a resolved item is selected, carried unchanged. */
export type InclusionOrigin =
  | { reasonIncluded: 'chosen' }
  | { reasonIncluded: 'in-set'; set: { framework: string; setId: string; setSha256: string }; options?: Record<string, string[]> }
  /** `framework` is absent only when the requiring Catalog release publishes no framework identity. */
  | { reasonIncluded: 'required-by'; requiredBy: { framework?: string; itemId: string } };
/** A Catalog item named by framework and item id; content identities never take part in matching. */
export interface CatalogItemRef { framework: string; itemId: string }
/** A Catalog set named by framework, set id and its exact digest. */
export interface CatalogSetRef { framework: string; setId: string; setSha256: string }
/**
 * Execution policy 1.4.0: descriptive selection metadata, given all together or not at all. It names the item a
 * recipe was rendered from and why it was included; it never adds operations, inputs or authority.
 */
export interface SelectionMetadata {
  item: CatalogItemRef & { contentSha256: string; behaviourSha256: string };
  /** A tool registry id. */
  tool: string;
  name: string;
  kind: 'skill' | 'agent' | 'command' | 'rule' | 'hook' | 'mcp-server' | 'document';
  /** One entry per simultaneous inclusion, so overlapping sets keep every origin. */
  origins: InclusionOrigin[];
}
export interface Selection extends Partial<SelectionMetadata> {
  id: string;
  managementId: string;
  scope: 'project' | 'user';
  configuration: Record<string, Json>;
  requires: string[];
  organizationSelectionId?: string;
  recipe: { inline: Recipe } | { reference: MaterialRecipeReference };
}
export interface ExecutionPolicy {
  schema: 'urn:aihq:core:execution-policy:1.0.0' | 'urn:aihq:core:execution-policy:1.1.0' | 'urn:aihq:core:execution-policy:1.2.0' |
    'urn:aihq:core:execution-policy:1.3.0' | 'urn:aihq:core:execution-policy:1.4.0';
  mode: 'vibe' | 'enterprise';
  selections: Selection[];
  /** Execution policy 1.4.0: items left out by framework and item id; a selection naming one makes the policy invalid. */
  excludedItems?: CatalogItemRef[];
  /** Optional assessment references; never execution authority or a findings gate. */
  evidence?: import('./evidence/types.js').EvidenceAssociation[];
  managedSelections?: { id: string; scope: 'project' | 'user'; members: string[] }[];
  removals?: { managementId: string; scope: 'project' | 'user' }[];
  metadata?: Record<string, Json>;
}
export type OrganizationInputPermission = { fixed: Json } | { choices: Json[] } | { allowDeclared: true };
export interface OrganizationSelection {
  selectionId: string;
  recipeIdentity: string;
  scopes: ('project' | 'user')[];
  inputs: Record<string, OrganizationInputPermission>;
  lifecycle?: { replace?: boolean; adopt?: boolean; remove?: boolean };
}
export type OrganizationObligation = 'required' | 'recommended' | 'permitted' | 'prohibited';
export type OrganizationTargetFact = 'client' | 'repository';
/** Caller-declared target facts; an absent fact is unknown, never inferred. */
export interface OrganizationTargetFacts { client?: import('./internal/native-clients.js').NativeClientId; repository?: string }
export interface OrganizationTarget extends OrganizationTargetFacts { scope: 'project' | 'user' }
/** Caller-declared client and repository for organization applicability; declared, never inferred or verified. */
export interface OrganizationTargetDeclaration10 {
  schema: 'urn:aihq:core:organization-target:1.0.0';
  client: import('./internal/native-clients.js').NativeClientId;
  repository?: string;
}
/** Caller-declared Harness registry tool (canonical id and its surface) and repository; declared, never inferred or verified. */
export interface OrganizationTargetDeclaration11 {
  schema: 'urn:aihq:core:organization-target:1.1.0';
  tool: { id: string; surface: 'cli' | 'ide' };
  repository?: string;
}
export type OrganizationTargetDeclaration = OrganizationTargetDeclaration10 | OrganizationTargetDeclaration11;
export type OrganizationApplicability = 'applies' | 'not-applicable' | 'unknown';
/** A recipe entry carries `recipeIdentity`; a 1.2.0 entry naming content also carries `content`. */
export interface OrganizationObligationResultBase {
  selectionId: string; recipeIdentity?: string; content?: OrganizationContentSelector; applicability: OrganizationApplicability;
  unknown: OrganizationTargetFact[]; selections: string[];
}
/** `unavailable`: the entry selects a set whose members were not supplied, so it is never taken. */
export interface OrganizationAdvisoryResult extends OrganizationObligationResultBase { status: 'taken' | 'not-taken' | 'unavailable' }
export interface OrganizationFulfillmentResult extends OrganizationObligationResultBase {
  status: 'fulfilled' | 'not-fulfilled' | 'not-applicable' | 'unknown' | 'unavailable';
}
export interface OrganizationSelection11 extends OrganizationSelection {
  obligation: OrganizationObligation;
  clients?: import('./internal/native-clients.js').NativeClientId[];
  repositories?: string[];
}
export interface OrganizationPolicy10 {
  schema: 'urn:aihq:core:organization-policy:1.0.0';
  id: string;
  selections: OrganizationSelection[];
  metadata?: Record<string, Json>;
}
export interface OrganizationPolicy11 {
  schema: 'urn:aihq:core:organization-policy:1.1.0';
  id: string;
  selections: OrganizationSelection11[];
  metadata?: Record<string, Json>;
}
/** Catalog content an organization 1.2.0 entry selects; every named field must match. */
export interface OrganizationContentSelector {
  kind?: SelectionMetadata['kind'];
  item?: CatalogItemRef;
  framework?: string;
  set?: CatalogSetRef;
}
/**
 * Organization policy 1.2.0 entry: a 1.1.0 entry whose recipe identity and inputs become optional when it names content.
 * Only an entry with a recipe identity admits a selection; a content-only entry requires, recommends or prohibits.
 */
export interface OrganizationSelection12 extends Omit<OrganizationSelection11, 'recipeIdentity' | 'inputs'> {
  recipeIdentity?: string;
  inputs?: Record<string, OrganizationInputPermission>;
  content?: OrganizationContentSelector;
}
export interface OrganizationPolicy12 {
  schema: 'urn:aihq:core:organization-policy:1.2.0';
  id: string;
  selections: OrganizationSelection12[];
  metadata?: Record<string, Json>;
}
export type OrganizationPolicy = OrganizationPolicy10 | OrganizationPolicy11 | OrganizationPolicy12;
/** Catalog-resolved members of one exact set, supplied as data; Core never expands a set itself. */
export interface OrganizationSetMembers {
  set: CatalogSetRef;
  members: (CatalogItemRef & { kind?: SelectionMetadata['kind'] })[];
}
/** Options for organization validation and admission. Without a set's members, its selector is `unavailable`. */
export interface OrganizationPolicyOptions { setMembers?: OrganizationSetMembers[] }
/** A 1.2.0 set selector whose members were not supplied: never matched, reported rather than guessed. */
export interface OrganizationUnavailableSelector { reason: 'set-membership-unavailable'; path: string; set: CatalogSetRef }
export interface OrganizationValidationResult extends ValidationResult { unavailable?: OrganizationUnavailableSelector[] }
export interface OrganizationParseResult extends OrganizationValidationResult { document?: OrganizationPolicy }
