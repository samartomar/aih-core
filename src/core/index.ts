export type * from './types.js';
export { verifyNativeClient } from './native-verification.js';
export type { NativeVerificationControls } from './native-verification.js';
export type { NativeClientId, NativeMember, NativeTreeFile, NativeVerificationRequest,
  NativeVerificationBundle, NativeStageOutcome, NativeStageEvidence, NativeStage,
  NativeVerificationResult } from './native-contracts.js';
export type * from './host-types.js';
export { authenticateEvidence, associateEvidence } from './evidence/index.js';
export type { EvidenceAssociation, AuthenticationTrust, VerificationPublisher, VerificationKey,
  AssociationResult, AssociationReason, AssociateEvidenceInput, AssociateEvidenceControls } from './evidence/index.js';
import { prepare as preparePolicy, apply as applyPolicy } from './recipe-engine.js';
import { prepareRepair, applyRepair, isRepairHandle, type RepairRequest } from './repair.js';
import { prepareTrust, applyTrust, isTrustHandle } from './trust.js';
import type { TrustRepairRequest, CertificateExportRequest } from './trust-contracts.js';
export type * from './trust-contracts.js';
import type { Authorization, HostControls, PolicyRequest, PreparedHandle } from './host-types.js';
import { isProxy } from 'node:util/types';
export type { RepairRequest } from './repair.js';
export function prepare(request: PolicyRequest | RepairRequest | TrustRepairRequest | CertificateExportRequest, controls: HostControls = {}) {
  const kind = request && typeof request === 'object' && !isProxy(request) ?
    Object.getOwnPropertyDescriptor(request, 'useCase')?.value : undefined;
  const schema = request && typeof request === 'object' && !isProxy(request) ? Object.getOwnPropertyDescriptor(request, 'schema')?.value : undefined;
  if (schema !== undefined || kind === 'certificate-export') return prepareTrust(request as TrustRepairRequest | CertificateExportRequest, controls);
  return kind === 'repair' ? prepareRepair(request as RepairRequest, controls) : preparePolicy(request as PolicyRequest, controls);
}
export function apply(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {}) {
  return isTrustHandle(prepared) ? applyTrust(prepared, authorization, controls) : isRepairHandle(prepared) ? applyRepair(prepared, authorization, controls) : applyPolicy(prepared, authorization, controls);
}
export { inspect } from './inspection.js';
export type { InspectRequest, InspectControls, InspectResult } from './inspection.js';
export { writeSupportReport } from './support-report.js';
export type { SupportReportResult, WriteSupportReportOptions } from './support-report.js';

export { checkFileState } from './file-state.js';
export type * from './file-state-types.js';
export { listManagedSelections } from './managed-inventory.js';
export type { ManagedInventoryRequest, ManagedInventoryControls, ManagedInventoryResult,
  ManagedInventorySelection } from './managed-inventory.js';
export { prepareManagedRemoval } from './managed-removal.js';
export type { ManagedRemovalRequest, ManagedRemovalDisposition, ManagedRemovalPreparationResult } from './managed-removal.js';
