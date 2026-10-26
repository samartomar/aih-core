import type { LocalPolicySource, ReadLocalPolicyResult } from './runtime.mjs';
export declare function validLocalPolicySource(source: unknown): boolean;
export declare function localPolicySourceLabel(source: LocalPolicySource): { provider: 'local'; fileName: string };
export declare function readLocalPolicy(source: unknown, controls?: { signal?: AbortSignal }): Promise<ReadLocalPolicyResult>;
