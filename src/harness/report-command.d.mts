import type { DiagnosticStatus } from './report/data.mjs';

export interface ReportCommandRequest {
  /** Directory to create. It must not exist and its parent must. */
  output: string;
  /** Strict-JSON text of a supplied snapshot. When present nothing is acquired. */
  snapshotJson?: string;
  /** Explicit bounded offline probes for a fresh diagnostic. Defaults to Node and Git. */
  targets?: string[];
  /** Render the labelled design sample instead of the snapshot's values. */
  demo?: boolean;
}

export interface ReportCommandSummary {
  status: 'complete';
  mode: 'report' | 'demo';
  source: 'fresh' | 'snapshot';
  /** The installed distribution that ran this command. */
  package: { name: string; version: string };
  /** Producer identity carried by the snapshot: supplied provenance, not authenticated. `revision` is null when unknown. */
  producer: { name: string; version: string; revision: string | null };
  evidence: { originalSha256: string | null; authentication: 'not-authenticated' };
  output: { directory: string; json: string; html: string };
  diagnosticStatus: DiagnosticStatus;
  counts: { passed: number; failed: number; unavailable: number; skipped: number };
  totals: { tools: number; observations: number; checks: number; diagnostics: number };
}

export type ReportCommandErrorCode = 'INPUT_INVALID' | 'CANCELLED' | 'INCOMPLETE';

/** A refused report command. `reason` is a fixed token that never carries caller values. */
export declare class ReportCommandError extends Error {
  readonly code: ReportCommandErrorCode;
  readonly reason: string;
  constructor(code: ReportCommandErrorCode, reason: string);
}

/** Acquire (or import) one snapshot and write matching `report.json` and `report.html` into a new directory. */
export declare function runReportCommand(request: ReportCommandRequest,
  controls?: { signal?: AbortSignal }): Promise<ReportCommandSummary>;
