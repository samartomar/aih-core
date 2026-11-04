// Explicit type exports: each name appears in a request, control or result of an operation exported here.
// Portable document types, validators and their schema identities belong to '@aihq/core/contracts'.
export type { Json, JsonObject, Diagnostic, Slot, InputSpec, TargetPath, OperationBase, FileOperation, ConfigEntrySet,
  ConfigEntryRemove, ConfigOperation, ConfigMemberOperation, ApprovalMarker, TextBlockOperation, RemoveOperation, Executable, ProcessInvocation, ProcessOperation,
  HookGroupOperation, Operation, FileCheck, ProcessCheck, RecipeCheck, MaterialSource, MaterialIdentity, MaterialMember,
  InlineMaterial, MaterialRecipeReference, GitMaterialSource, GitMaterialProvenance, Prerequisite, Recipe, Selection, SelectionMetadata, ItemScanRecord, ItemMaterial, InclusionOrigin, CatalogItemRef, CatalogReleaseReference, ExecutionPolicy, OrganizationTargetFact,
  OrganizationTargetDeclaration, OrganizationTargetDeclaration10, OrganizationTargetDeclaration11, OrganizationApplicability, OrganizationObligationResultBase, OrganizationAdvisoryResult,
  OrganizationFulfillmentResult } from './types.js';
export { verifyNativeClient } from './native-verification.js';
export type { NativeVerificationControls } from './native-verification.js';
export type { NativeClientId, NativeMember, NativeTreeFile, NativeVerificationRequest,
  NativeVerificationBundle, NativeStageOutcome, NativeStageEvidence, NativeStage,
  NativeVerificationResult } from './native-contracts.js';
export type { PreparedHandle, PolicyRequest, HostControls, Authorization, Effective, RecordStatus, ReviewOperation,
  HookGroupReview, ReviewCheck, OrganizationBinding, OrganizationObligationsReview, PreparedReview, MacosPreparedInputs,
  ResolutionInput, OperationSelection, PreparationResult, OperationResult, CheckResult, RunResult, GitHubPolicySource,
  PreparedSelection, ReviewSize, StaleBinding, RunDiagnostic, RunMember, ScanSummary } from './host-types.js';
export { authenticateEvidence, associateEvidence } from './evidence/index.js';
export type { EvidenceAssociation, AuthenticationTrust, VerificationPublisher, VerificationKey,
  AssociationResult, AssociationReason, AssociateEvidenceInput, AssociateEvidenceControls } from './evidence/index.js';
import { prepare as preparePolicy, apply as applyPolicy } from './recipe-engine.js';
import { forgetProvenState } from './internal/state.js';
import { prepareRepair, applyRepair, isRepairHandle, type RepairRequest } from './repair.js';
import { prepareTrust, applyTrust, isTrustHandle } from './trust.js';
import { prepareMacosSession, applyMacosSession, isMacosSessionHandle } from './macos-session.js';
import type { MacosRepairRequest } from './macos-session-contracts.js';
export { verifyMacosSession } from './macos-session.js';
export type { MacosSessionClientId, MacosSessionContext, MacosSessionLaunch, MacosSessionApplication, MacosSessionSelection,
  MacosRepairRequest, MacosSessionState, MacosSessionApplicationReview, MacosSessionEffect, MacosSessionReview,
  MacosSessionConfiguration, MacosSessionVerification, MacosSessionApplicationRun, MacosSessionRun,
  MacosSessionVerificationRequest, MacosSessionObservation, MacosSessionCheck, MacosSessionRecordStatus,
  MacosSessionVerificationResult } from './macos-session-contracts.js';
import type { TrustRepairRequest, CertificateExportRequest } from './trust-contracts.js';
export type { Sha256, TrustRepairId, TrustRoute, TrustRouteOrExport, TrustNetwork, TrustSourceKind, TrustCompleteness,
  TrustSourceScope, TrustProjection, TrustOutputFormat, TrustOutputEffect, TrustCertificateDisposition, SuppliedTrustSource,
  TrustSources, TrustResolution, TrustRepairStep, TrustRepairRequest, CertificateExportRequest, TrustSourceAdapter,
  TrustSourceReview, TrustTargetClient, TrustTargetPolicy, TrustSecondarySource, TrustTargetVerification, TrustTargetReview,
  CertificateReview, TrustOutputReview, TrustInputs, TrustRunOutput, TrustRunTarget, TrustRunTrust } from './trust-contracts.js';
import type { Authorization, HostControls, PolicyRequest, PreparedHandle } from './host-types.js';
import { isProxy } from 'node:util/types';
import { nodeRuntimeSupported } from './internal/node-runtime.js';
import { preparePlan } from './plan/prepare.js';
import { applyPlan } from './plan/apply.js';
import { isPlanHandle } from './plan/handles.js';
import type { PreparationResult, RunResult } from './host-types.js';
import { PLAN_REQUEST, type Approval, type PlanControls, type PlanHandle, type PlanPreparation, type PlanRequest, type Run } from './plan/types.js';
/** Any `urn:aihq:core:plan-request:*` document goes to the plan path, which answers `unsupported-version` for other versions. */
const isPlanRequest = (request: unknown): boolean => {
  if (!request || typeof request !== 'object' || isProxy(request)) return false;
  const schema = Object.getOwnPropertyDescriptor(request, 'schema')?.value;
  return schema === PLAN_REQUEST || typeof schema === 'string' && schema.startsWith('urn:aihq:core:plan-request:');
};
export type { RepairRequest } from './repair.js';
/** A plan request (`urn:aihq:core:plan-request:0.1.0`) returns the 0.1.0 preparation (contract 3, 14.1). */
export function prepare(request: PlanRequest, controls?: PlanControls): Promise<PlanPreparation>;
export function prepare(request: PolicyRequest | RepairRequest | TrustRepairRequest | CertificateExportRequest | MacosRepairRequest, controls?: HostControls): Promise<PreparationResult>;
export function prepare(request: PlanRequest | PolicyRequest | RepairRequest | TrustRepairRequest | CertificateExportRequest | MacosRepairRequest, controls: HostControls | PlanControls = {}): Promise<PreparationResult | PlanPreparation> {
  if (isPlanRequest(request)) return preparePlan(request, controls);
  return prepareOlder(request as PolicyRequest, controls as HostControls);
}
function prepareOlder(request: PolicyRequest | RepairRequest | TrustRepairRequest | CertificateExportRequest | MacosRepairRequest, controls: HostControls = {}) {
  forgetProvenState();
  if (!nodeRuntimeSupported()) return preparePolicy(request as PolicyRequest, controls);
  const kind = request && typeof request === 'object' && !isProxy(request) ?
    Object.getOwnPropertyDescriptor(request, 'useCase')?.value : undefined;
  const schema = request && typeof request === 'object' && !isProxy(request) ? Object.getOwnPropertyDescriptor(request, 'schema')?.value : undefined;
  if (schema === 'urn:aihq:core:repair-request:1.1.0') return prepareMacosSession(request as MacosRepairRequest, controls);
  if (schema !== undefined || kind === 'certificate-export') return prepareTrust(request as TrustRepairRequest | CertificateExportRequest, controls);
  return kind === 'repair' ? prepareRepair(request as RepairRequest, controls) : preparePolicy(request as PolicyRequest, controls);
}
/** A 0.1.0 handle (plan request or `prepareRemoval`) returns the 0.1.0 run (contract 7). */
export function apply(handle: PlanHandle, approval: Approval, controls?: PlanControls): Promise<Run>;
export function apply(prepared: PreparedHandle, authorization: Authorization, controls?: HostControls): Promise<RunResult>;
export function apply(prepared: PreparedHandle | PlanHandle, authorization: Authorization | Approval, controls: HostControls | PlanControls = {}): Promise<RunResult | Run> {
  if (isPlanHandle(prepared)) return applyPlan(prepared, authorization, controls);
  return applyOlder(prepared as PreparedHandle, authorization as Authorization, controls as HostControls);
}
function applyOlder(prepared: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
  forgetProvenState();
  if (isMacosSessionHandle(prepared)) return applyMacosSession(prepared, authorization, controls);
  return isTrustHandle(prepared) ? applyTrust(prepared, authorization, controls) : isRepairHandle(prepared) ? applyRepair(prepared, authorization, controls) : applyPolicy(prepared, authorization, controls);
}
export { list, prepareRemoval } from './plan/lifecycle.js';
export type { PlanRequest, PlanControls, PlanPreparation, PlanStep, Plan, PlanFile, PlanResolution, Preparation, Refusal, Invalid,
  UnsupportedVersion, Problem, Review, ReviewStep, ReviewConflict, Approval, Run, RunStep, RunMember as PlanRunMember, StaleChange, PlanHandle,
  Inventory, InventoryEntry, InventoryMember, ListResult, RemovalSelector as PlanRemovalSelector, RemovalMember as PlanRemovalMember, RemovalEntry as PlanRemovalEntry,
  RemovalPreparation, RemovalResult } from './plan/types.js';
export { inspect } from './inspection.js';
export type { InspectRequest, InspectControls, InspectResult, PersistedConfigurationValue } from './inspection.js';
export { writeSupportReport } from './support-report.js';
export type { SupportReportResult, WriteSupportReportOptions } from './support-report.js';
export type { ReportFileResult, ReportFileStatus } from './internal/report-file.js';

export { checkFileState } from './file-state.js';
export type { FileStateRequest, FileStateControls, FileStateStatus, FileStateOutcome, FileStateTargetPath, FileStateTarget,
  FileStateCheck, FileStateOmission, FileStateResult } from './file-state-types.js';
export { listManagedSelections } from './managed-inventory.js';
export type { ManagedInventoryRequest, ManagedInventoryControls, ManagedInventoryResult,
  ManagedInventorySelection, ManagedInventoryIndex, ManagedInventoryMember, ManagedInventorySelection11,
  ManagedInventoryResult11 } from './managed-inventory.js';
export { prepareManagedRemoval } from './managed-removal.js';
export type { ManagedRemovalRequest, ManagedRemovalDisposition, ManagedRemovalPreparationResult, ManagedRemovalsRequest, ManagedRemovalPreparationResult12,
  RemovalSelector, RemovalEntry, RemovalMember, RemovalMemberAction } from './managed-removal.js';
export { prepareUpdate } from './managed-update.js';
export type { ManagedUpdateRequest, ManagedUpdatePreparationResult, UpdateSelector, UpdateEntry, UpdateMember, UpdateMemberAction,
  UpdateItemFacts } from './managed-update.js';
export { resolveStateLocation } from './resolve-state-location.js';
export type { ResolvedStateLocation, ResolvedStateLocationMarker } from './resolve-state-location.js';
