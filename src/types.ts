export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Diagnostic {
  code: string;
  reason: string;
  message: string;
  path?: string;
  encountered?: string;
  supported?: string[];
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
export interface FileOperation {
  id: string;
  purpose: string;
  kind: 'file.write';
  scope: 'project' | 'user';
  target: TargetPath;
  content: Slot;
  requires: string[];
  checks: never[];
}
export interface Recipe {
  schema: 'urn:aihq:core:recipe:1.0.0';
  id: string;
  description: string;
  inputs: Record<string, InputSpec>;
  materials: never[];
  targets: ('project' | 'user')[];
  prerequisites: never[];
  operations: FileOperation[];
  checks: never[];
}
export interface Selection {
  id: string;
  managementId: string;
  scope: 'project' | 'user';
  configuration: Record<string, Json>;
  requires: string[];
  recipe: { inline: Recipe };
}
export interface ExecutionPolicy {
  schema: 'urn:aihq:core:execution-policy:1.0.0';
  mode: 'vibe';
  selections: Selection[];
  metadata?: Record<string, Json>;
}
