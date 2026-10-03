import type { Diagnostic, ExecutionPolicy, Json } from './types.js';

export interface FileStateRequest { policy: ExecutionPolicy; target: { project: string } }
export interface FileStateControls {
  signal?: AbortSignal;
  budgetMs?: number;
  privateInputs?: Record<string, Record<string, Json>>;
  materialRoots?: Record<string, string>;
}
export type FileStateStatus = 'complete' | 'incomplete' | 'invalid' | 'cancelled';
export type FileStateOutcome = 'match' | 'changed' | 'unverified';
export interface FileStateTargetPath { root: 'project' | 'userHome' | 'userState'; path: string }
export interface FileStateTarget {
  id: string;
  operationIds: string[];
  target: FileStateTargetPath | null;
  outcome: 'match' | 'changed' | 'absent' | 'unavailable';
  reason: string;
}
export interface FileStateCheck { id: string; outcome: 'passed' | 'failed' | 'unavailable' | 'not-checked'; reason: string }
export interface FileStateOmission {
  kind: 'process' | 'recipe' | 'prerequisite' | 'managed-set' | 'removal' | 'evidence';
  id: string;
  reason: string;
}
export interface FileStateResult {
  schema: 'urn:aihq:core:file-state-result:1.0.0';
  package: { name: string; version: string };
  status: FileStateStatus;
  fileState: FileStateOutcome;
  authority: 'not-evaluated';
  targets: FileStateTarget[];
  checks: FileStateCheck[];
  notChecked: FileStateOmission[];
  coverage: {
    comparedTargets: number;
    unavailableTargets: number;
    comparedChecks: number;
    unavailableChecks: number;
    notChecked: number;
  };
  diagnostics: Diagnostic[];
  limits: { budgetMs: number; elapsedMs: number; targetBytes: number; materialBytes: number };
}
