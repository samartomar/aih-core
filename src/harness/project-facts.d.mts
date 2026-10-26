// Bounded read-only project facts diagnostic (Project basics). Reads only; runs nothing.
export type ProjectFactConfidence = 'detected' | 'inferred';
/** Fields Core knows how to render into Project basics; the diagnostic may add fields only with a new Core version. */
export type ProjectFactField = 'stack' | 'packageManager' | 'nodeVersion' | 'testCommand' | 'buildCommand' | 'lintCommand';
export interface ProjectFact { field: ProjectFactField; value: string; confidence: ProjectFactConfidence }
export interface DetectProjectFactsRequest { project: string }
export interface DetectProjectFactsControls { signal?: AbortSignal; budgetMs?: number }
export interface DetectProjectFactsLimits { budgetMs: number; elapsedMs: number; reads: number; maxReads: number }
export interface DetectProjectFactsDiagnostic { code: string; reason: string; message: string }
export type DetectProjectFactsResult =
  | { status: 'complete'; project: string; facts: ProjectFact[]; diagnostics: DetectProjectFactsDiagnostic[]; limits: DetectProjectFactsLimits }
  | { status: 'incomplete'; project: string; facts: ProjectFact[]; diagnostics: DetectProjectFactsDiagnostic[]; limits: DetectProjectFactsLimits }
  | { status: 'invalid'; facts: null; diagnostics: DetectProjectFactsDiagnostic[]; limits: DetectProjectFactsLimits }
  | { status: 'cancelled'; facts: null; diagnostics: DetectProjectFactsDiagnostic[]; limits: DetectProjectFactsLimits };
export declare function detectProjectFacts(request: DetectProjectFactsRequest,
  controls?: DetectProjectFactsControls): Promise<DetectProjectFactsResult>;
