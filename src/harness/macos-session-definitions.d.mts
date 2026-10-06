import type { RepairDefinition11, RepairDefinition11Variant, TrustCapabilities, TrustDefinitionDiagnostic } from './contracts.mjs';
export type RepairDefinition12 = Omit<RepairDefinition11, 'schema' | 'variants' | 'id'> & {
  schema: 'urn:aihq:harness:repair:1.2.0'; id: 'node-npm-ca' | 'user-tools-ca' | 'jvm-ca';
  variants: readonly (RepairDefinition11Variant & { sessionProfileIds: readonly string[] })[];
};
export declare const repairDefinitionSchema12: 'urn:aihq:harness:repair:1.2.0';
export declare const macosRepairIndex: readonly RepairDefinition12[];
export declare function selectMacosRepairDefinition(query: { requestSchema?: string; repairId: string; definitionSchema: string }): RepairDefinition12 | undefined;
export declare function validateRepairDefinition12(value: unknown, options?: {
  adapters?: readonly { id: string }[]; capabilities?: TrustCapabilities; resolveRecipeRef?: (ref: string) => boolean
}): { valid: boolean; diagnostics: TrustDefinitionDiagnostic[] };
