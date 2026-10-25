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
export type Operation = FileOperation | ConfigOperation | TextBlockOperation | RemoveOperation | ProcessOperation | HookGroupOperation;
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
  schema: 'urn:aihq:core:recipe:1.0.0' | 'urn:aihq:core:recipe:1.1.0' | 'urn:aihq:core:recipe:1.2.0' | 'urn:aihq:core:recipe:1.3.0';
  id: string;
  description: string;
  inputs: Record<string, InputSpec>;
  materials: (InlineMaterial | MaterialIdentity)[];
  targets: ('project' | 'user')[];
  prerequisites: Prerequisite[];
  operations: Operation[];
  checks: RecipeCheck[];
}
export interface Selection {
  id: string;
  managementId: string;
  scope: 'project' | 'user';
  configuration: Record<string, Json>;
  requires: string[];
  organizationSelectionId?: string;
  recipe: { inline: Recipe } | { reference: MaterialRecipeReference };
}
export interface ExecutionPolicy {
  schema: 'urn:aihq:core:execution-policy:1.0.0' | 'urn:aihq:core:execution-policy:1.1.0' | 'urn:aihq:core:execution-policy:1.2.0' | 'urn:aihq:core:execution-policy:1.3.0';
  mode: 'vibe' | 'enterprise';
  selections: Selection[];
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
export interface OrganizationObligationResultBase {
  selectionId: string; recipeIdentity: string; applicability: OrganizationApplicability;
  unknown: OrganizationTargetFact[]; selections: string[];
}
export interface OrganizationAdvisoryResult extends OrganizationObligationResultBase { status: 'taken' | 'not-taken' }
export interface OrganizationFulfillmentResult extends OrganizationObligationResultBase {
  status: 'fulfilled' | 'not-fulfilled' | 'not-applicable' | 'unknown';
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
export type OrganizationPolicy = OrganizationPolicy10 | OrganizationPolicy11;
export interface OrganizationParseResult extends ValidationResult { document?: OrganizationPolicy }
