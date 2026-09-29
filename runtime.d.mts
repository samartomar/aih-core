export interface DiagnoseRequest {
  requestId: string; targets?: string[]; network?: 'declared' | 'off'; probeConfiguredMcp?: boolean; project?: string;
}
export interface DiagnoseControls { signal?: AbortSignal; budgetMs?: number }
export interface DiagnoseResult {
  requestId: string; helper: { name: string; version: string }; status: 'completed' | 'cancelled' | 'invalid' | 'unavailable';
  tools: { id: string; label: string; state: string; selection: string; config?: string }[];
  observations: { id: string; target: string; detail: string }[];
  checks: { id: string; target: string; outcome: 'passed' | 'failed' | 'unavailable' | 'skipped'; reason: string; detail: string }[];
  diagnostics: { code: string; reason: string; message: string }[];
  repairChoices: { target: string; kind: 'manual-guidance'; reason: string; guidance: string }[];
  limits: { budgetMs: number; elapsedMs: number; maxActiveProbes: number };
}
export declare function validDiagnosticTargets(value: unknown): boolean;
export declare function diagnose(request: DiagnoseRequest, controls?: DiagnoseControls): Promise<DiagnoseResult>;
