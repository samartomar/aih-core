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
  kind: 'config.entries'; target: TargetPath; format: 'json' | 'jsonc' | 'toml';
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
export type Operation = FileOperation | ConfigOperation | TextBlockOperation | RemoveOperation | ProcessOperation;
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
  schema: 'urn:aihq:core:recipe:1.0.0';
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
  schema: 'urn:aihq:core:execution-policy:1.0.0';
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
export interface OrganizationPolicy {
  schema: 'urn:aihq:core:organization-policy:1.0.0';
  id: string;
  selections: OrganizationSelection[];
  metadata?: Record<string, Json>;
}
export interface OrganizationParseResult extends ValidationResult { document?: OrganizationPolicy }
