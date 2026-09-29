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
export interface CaDiagnostic { code: 'INPUT_INVALID'; reason: string; message: string; block?: number; offset?: number }
export type SuppliedCaResult = { valid: false; diagnostics: CaDiagnostic[]; assessedBlocks: number; assessmentLimit?: string } |
  { valid: true; diagnostics: []; assessedBlocks: number; duplicates: number;
    certificates: { fingerprint: string; subject: string; validFrom: string; validTo: string; pem: string }[];
    material: string; evaluatedAt: string };
export declare function validateSuppliedCa(bytes: Uint8Array, options?: { now?: number }): SuppliedCaResult;
export declare function composeExistingTrust(existing: Uint8Array | undefined, additions: string,
  options?: { includeNodeDefaults?: boolean }): string | undefined;
export declare function renderRepair(request: { id: 'node-npm-ca'; targets: ('node' | 'npm')[];
  bundlePath: string; bundleSha256: string; fingerprints: string[]; offline: boolean }): object;
export declare function prepareRepairDefinition(request: { id: string; variantRef: string;
  targets: string[]; files: Record<string, Uint8Array>;
  ordinaryInputs?: Record<string, string | boolean | number>; existing?: Uint8Array;
  managedPath?: string; offline?: boolean; validateOnly?: boolean }):
  { status: 'invalid' | 'blocked'; diagnostics: { code: string; reason: string; message: string; block?: number }[] } |
  { status: 'completed'; fingerprints: string[]; evaluatedAt: string; count: number; duplicates: number;
    bundle?: string; recipe?: object };
export declare function repairObservationRequests(request: { id: string; targets: string[] }):
  { id: string; operationId: string; executable: string; args: string[]; timeoutMs: number; maxOutputBytes: number }[];
export declare function assessRepairObservations(request: { id: string; managedPath: string;
  observations: { id: string; output: string }[] }):
  { id: string; operationId: string; raw: string; expectedRaw: string; conflict: boolean;
    observedValue: string | null; reason: string }[];
