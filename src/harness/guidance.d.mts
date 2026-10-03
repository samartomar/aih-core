export type GuidancePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';
export type GuidanceFact =
  | { kind: 'check'; evidenceId: string; id?: string; target?: string; outcome: string; reason: string }
  | { kind: 'observation'; evidenceId: string; id: string; target: string }
  | { kind: 'tool'; evidenceId: string; target: string; state: string; selection: string }
  | { kind: 'diagnostic'; evidenceId: string; code: string; reason: string }
  | { kind: 'operation'; evidenceId: string; id?: string; application: string; verification: string; reason: string; scope?: 'user' | 'project' }
  | { kind: 'status'; evidenceId: string; value: string };
export interface GuidanceRequest {
  kind: 'inspect' | 'prepare' | 'run';
  useCase?: 'policy' | 'repair';
  platform: GuidancePlatform;
  facts: readonly GuidanceFact[];
  repair?: { id: string; targets: readonly string[] };
}
export interface DerivedGuidanceItem {
  id: string; target: string; reason: string; audience: 'developer' | 'administrator';
  summary: string; steps: string[]; evidenceIds: string[];
  repairs: { id: string; targets: string[]; requiredInputs: { name: string; type: string; description: string }[] }[];
}
export declare const guidanceSubjects: readonly string[];
export declare const clientGuidanceTargets: readonly string[];
export declare function deriveGuidance(request: GuidanceRequest): DerivedGuidanceItem[];
export declare function subjectLabel(id: string): string | undefined;
export declare function reasonLabel(reason: string): string | undefined;
