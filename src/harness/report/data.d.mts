/**
 * Type declarations for the experimental data interface (`@aihq/core/report`).
 * Data only: no rendering, filesystem or host access.
 */

/** Versioned identity of the ReportSnapshot shape produced by this module. */
export declare const SNAPSHOT_SCHEMA: 'urn:aihq:report:snapshot:1.0.0';

/** The single supported producer contract (schema identity of `diagnostic`). */
export declare const DIAGNOSTIC_CONTRACT: 'urn:aihq:harness:diagnostic:1.0.0';

/** `INPUT_INVALID` = malformed caller data; `SCHEMA_UNSUPPORTED` = unknown version/contract. */
export type ReportInputErrorCode = 'INPUT_INVALID' | 'SCHEMA_UNSUPPORTED';

/** Invalid or unsupported caller input; the message never contains raw caller values. */
export declare class ReportInputError extends Error {
  readonly code: ReportInputErrorCode;
  constructor(code: ReportInputErrorCode, message: string);
}

export type Acquisition = 'supplied' | 'newly-acquired';
export type DiagnosticStatus = 'completed' | 'cancelled' | 'invalid' | 'unavailable';
export type ToolState = 'binary' | 'runnable' | 'broken' | 'config-only' | 'absent';
export type ToolSelection = 'requested' | 'detected' | 'unselected';
export type CheckOutcome = 'passed' | 'failed' | 'unavailable' | 'skipped';

export interface ToolEntry {
  id: string;
  label: string;
  state: ToolState;
  selection: ToolSelection;
  config?: string;
}

export interface Observation {
  id: string;
  target: string;
  detail: string;
}

export interface CheckEntry {
  id: string;
  target: string;
  outcome: CheckOutcome;
  reason: string;
  detail: string;
}

export interface DiagnosticEntry {
  code: string;
  reason: string;
  message: string;
}

export interface ProducerIdentity {
  name: '@aihq/core';
  version: string;
  revision: string | null;
}

export interface CreateReportInput {
  /** A bounded, schema-valid `@aihq/core` Harness diagnostic result. */
  diagnostic: unknown;
  /** Supplied provenance, not attestation. */
  producer: ProducerIdentity;
  /** ISO 8601 UTC instant, e.g. `2026-10-03T12:00:00.000Z`. */
  observedAt: string;
  acquisition: Acquisition;
  /** SHA-256 (64 lowercase hex) of the raw evidence bytes; never recomputed here. */
  originalSha256?: string;
  redaction?: {
    /** Exact local home/root paths to replace case-insensitively with `<homePath>`. */
    homePaths?: string[];
    /** Exact secret strings to replace with `[REDACTED]`. */
    secretValues?: string[];
  };
}

export interface ReportSnapshot {
  schema: 'urn:aihq:report:snapshot:1.0.0';
  compatibility: 'experimental';
  producer: {
    name: '@aihq/core';
    version: string;
    revision: string | null;
    contract: 'urn:aihq:harness:diagnostic:1.0.0';
  };
  capture: { observedAt: string; acquisition: Acquisition };
  evidence: {
    originalSha256: string | null;
    authentication: 'not-authenticated';
    structuralValidation: 'passed';
    projection: 'redacted';
  };
  status: DiagnosticStatus;
  tools: ToolEntry[];
  observations: Observation[];
  checks: CheckEntry[];
  diagnostics: DiagnosticEntry[];
  metrics: {
    budgetMs: number;
    elapsedMs: number;
    maxActiveProbes: number;
    counts: { passed: number; failed: number; unavailable: number; skipped: number };
  };
}

export interface SnapshotValidation {
  valid: boolean;
  errors: string[];
}

/** Validate one supplied diagnostic result and project it into a redacted snapshot. */
export declare function createReport(input: CreateReportInput): ReportSnapshot;

/** Structural validation of a snapshot value; never throws for malformed input. */
export declare function validateSnapshot(value: unknown): SnapshotValidation;

/** Parse, validate and re-redact a versioned snapshot JSON document. */
export declare function importSnapshot(json: string, redaction?: CreateReportInput['redaction']): ReportSnapshot;

/** Validate and serialize a snapshot to deterministic, re-redacted JSON. */
export declare function exportSnapshot(report: ReportSnapshot): string;
