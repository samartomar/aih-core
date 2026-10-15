/**
 * Type declarations for normalized claim sets (`@aihq/core/report`).
 * Data only: no rendering, filesystem or host access.
 */

/** Versioned identity of the claim set this module accepts. */
export declare const CLAIMS_SCHEMA: 'urn:aihq:report:claims:1.0.0';

/** Every claim-set schema identity this version reads. */
export declare const CLAIMS_ACCEPTED_VERSIONS: readonly ['urn:aihq:report:claims:1.0.0'];

/** Versioned identity of the claims projection this module produces. */
export declare const CLAIMS_PROJECTION_SCHEMA: 'urn:aihq:report:claims-projection:1.0.0';

export type CalculationMethodId = 'configuration-check-score' | 'verified-repair-count' | 'context-change';

export interface CalculationMethod {
  readonly id: CalculationMethodId;
  readonly version: '1.0.0';
}

/** The explicit, versioned calculation methods a request may select. */
export declare const CALCULATION_METHODS: readonly CalculationMethod[];

export interface ClaimRef {
  id: string;
  revision: string;
}

export interface NamedVersion {
  id: string;
  version: string;
}

export interface ClaimSubject {
  kind: string;
  id: string;
}

export interface RecordRef {
  id: string;
  schema: string;
  /** 64 lowercase hex characters; never recomputed here. */
  sha256?: string;
}

export type ScopeKind = 'machine' | 'repository' | 'workspace' | 'user-content';
export type ClaimKind = 'measured' | 'estimated' | 'declared' | 'unknown';
export type CoverageState = 'complete' | 'partial' | 'unknown';
export type ApplicabilityState = 'current' | 'recheck-needed' | 'unknown';

export interface ClaimValue {
  amount: number | string | boolean;
  unit: string;
}

export type ClaimAuthentication =
  | { status: 'not-authenticated' }
  | {
    status: 'authenticated' | 'verification-failed';
    verifier: NamedVersion;
    method: NamedVersion;
    /** RFC 3339 UTC instant with an explicit `Z` or `+00:00` offset. */
    verifiedAt: string;
    evidence: RecordRef[];
  };

interface ClaimBase {
  id: string;
  revision: string;
  producer: NamedVersion;
  /** Schema identity of the producer record this claim was normalized from. */
  recordSchema: string;
  subject: ClaimSubject;
  /** Exact scope; `targets` never implies "all". */
  scope: { kind: ScopeKind; targets: string[] };
  sources: RecordRef[];
  /** Stable source event identity, or null when no reliable identity exists. */
  observation: string | null;
  /** RFC 3339 UTC instant with an explicit `Z` or `+00:00` offset. */
  capturedAt: string;
  measure: string;
  method?: NamedVersion;
  coverage: { state: CoverageState; reason: string };
  authentication: ClaimAuthentication;
  applicability: { state: ApplicabilityState; reason: string; inputs: ClaimRef[] };
}

/** A claim with a known value; `kind: 'estimated'` also requires `method`. */
export interface ValuedClaim extends ClaimBase {
  kind: 'measured' | 'estimated' | 'declared';
  value: ClaimValue;
  unknownReason?: undefined;
}

/** A claim whose value is unknown; the value stays absent, never zero. */
export interface UnknownClaim extends ClaimBase {
  kind: 'unknown';
  unknownReason: string;
  value?: undefined;
}

export type Claim = ValuedClaim | UnknownClaim;

export interface ConfigurationCheckScoreRequest {
  id: string;
  method: 'configuration-check-score';
  version: '1.0.0';
  checkSet: NamedVersion;
  selected: ClaimRef[];
  inapplicable: { claim: ClaimRef; reason: string }[];
}

export interface RepairAttemptRequest {
  operation: string;
  subject: ClaimSubject;
  condition: string;
  precheck: ClaimRef | null;
  repair: ClaimRef | null;
  postcheck: ClaimRef | null;
}

export interface VerifiedRepairCountRequest {
  id: string;
  method: 'verified-repair-count';
  version: '1.0.0';
  attempts: RepairAttemptRequest[];
}

export interface ContextChangeRequest {
  id: string;
  method: 'context-change';
  version: '1.0.0';
  before: ClaimRef;
  after: ClaimRef;
}

export type CalculationRequest =
  | ConfigurationCheckScoreRequest
  | VerifiedRepairCountRequest
  | ContextChangeRequest;

export type ActionCategory = 'blocker' | 'urgent-review' | 'important-unknown' | 'optional-improvement';

export interface ActionSuggestion {
  id: string;
  category: ActionCategory;
  reason: string;
  subjects: ClaimSubject[];
  evidence: ClaimRef[];
  prerequisites: string[];
  route: { kind: 'operation' | 'guidance'; id: string };
}

export interface ClaimSet {
  schema: 'urn:aihq:report:claims:1.0.0';
  claims: Claim[];
  calculations?: CalculationRequest[];
  actions?: ActionSuggestion[];
}

export interface ClaimSetValidation {
  valid: boolean;
  errors: string[];
}

export type ClaimSetRead =
  | { status: 'supported'; claimSet: ClaimSet }
  | {
    status: 'rejected';
    code: 'SCHEMA_UNSUPPORTED' | 'INPUT_INVALID';
    /** The encountered `schema` string, or null when none was readable. */
    schema: string | null;
    errors: string[];
    /** The exact, unchanged input string (empty when the input was not a string). */
    original: string;
  };

export type DedupStatus = 'unique' | 'canonical' | 'duplicate' | 'conflict' | 'unidentified';

export type ProjectedClaim = Claim & {
  dedup: { status: DedupStatus; canonical: ClaimRef | null };
};

export interface DuplicateObservation {
  producer: string;
  observation: string;
  claim: ClaimRef;
  merged: ClaimRef[];
  /** How many claims collapsed into the canonical claim, including it. */
  imports: number;
}

export interface ConflictingObservation {
  producer: string;
  observation: string;
  claims: ClaimRef[];
  reason: 'same-observation-different-content';
}

interface CalculationHead {
  id: string;
  method: NamedVersion;
  status: 'available' | 'unavailable';
  reason: string | null;
  inputs: ClaimRef[];
}

/**
 * Whether an aggregate rests on an established event identity. It is
 * `not-established` when any input claim has `observation: null`: the numbers
 * are still computed, but a re-import of that event cannot be recognised, so they
 * are not a deduplicated aggregate. `unidentified` lists those inputs, sorted.
 */
export interface Deduplication {
  status: 'established' | 'not-established';
  unidentified: ClaimRef[];
}

export interface ConfigurationCheckScoreResult extends CalculationHead {
  checkSet: NamedVersion;
  counts: { passed: number; failed: number; unknown: number; inapplicable: number };
  numerator: number;
  denominator: number;
  /** `passed / (passed + failed + unknown) * 100`, or null when no check applied. */
  score: number | null;
  /**
   * Every selected claim whose own outcome is failed, so failures stay visible
   * when the score is high or the observation is in conflict. Duplicates of one
   * event are listed once, as their canonical claim.
   */
  failed: ClaimRef[];
  /**
   * Selected members of conflicting observations, sorted. Each conflicted
   * observation counts once as unknown in `counts` whatever its members report.
   */
  conflicts: ClaimRef[];
  excluded: { claim: ClaimRef; reason: string }[];
  deduplication: Deduplication;
}

export type RepairAttemptReason =
  | 'uncorrelated'
  | 'conflicting-evidence'
  | 'unknown-precondition'
  | 'already-healthy'
  | 'external-repair'
  | 'unknown-cause'
  | 'applied-unverified'
  | 'repair-not-verified'
  | 'no-recovery'
  | 'verified';

export interface RepairAttemptResult extends RepairAttemptRequest {
  counted: boolean;
  reason: RepairAttemptReason;
}

export interface VerifiedRepairCountResult extends CalculationHead {
  /** Distinct failed conditions among verified attempts. */
  count: number;
  attempts: RepairAttemptResult[];
  deduplication: Deduplication;
}

export type ContextChangeUnavailableReason =
  | 'unknown-value'
  | 'incomparable-measure'
  | 'incomparable-kind'
  | 'incomparable-unit'
  | 'incomparable-method'
  | 'unsupported-kind'
  | 'unsupported-unit'
  | 'invalid-amount';

export type ContextChangeResult =
  | (CalculationHead & { status: 'unavailable'; reason: ContextChangeUnavailableReason })
  | (CalculationHead & {
    status: 'available';
    reason: null;
    before: number;
    after: number;
    unit: string;
    absoluteDifference: number;
    direction: 'decrease' | 'increase' | 'unchanged';
    /** `(before - after) / before * 100`; present only when `before > 0`. */
    percentage: number | null;
    percentageReason?: 'zero-baseline';
  });

export type CalculationResult =
  | ConfigurationCheckScoreResult
  | VerifiedRepairCountResult
  | ContextChangeResult;

export interface OrderedAction extends ActionSuggestion {
  order: { rank: number; category: ActionCategory; reason: string; tie: 'id' };
}

export interface ClaimsProjection {
  schema: 'urn:aihq:report:claims-projection:1.0.0';
  source: { schema: 'urn:aihq:report:claims:1.0.0' };
  claims: ProjectedClaim[];
  observations: {
    duplicates: DuplicateObservation[];
    conflicts: ConflictingObservation[];
    unidentified: ClaimRef[];
  };
  calculations: CalculationResult[];
  actions: OrderedAction[];
}

/** Structural and semantic validation of a claim set; never throws for malformed input. */
export declare function validateClaimSet(value: unknown): ClaimSetValidation;

/** Parse and validate a claim-set JSON document; never throws, preserving the input on rejection. */
export declare function readClaimSet(json: string): ClaimSetRead;

/**
 * Validate and deterministically project a claim set. Throws `ReportInputError`
 * (`SCHEMA_UNSUPPORTED` or `INPUT_INVALID`); never mutates the input.
 */
export declare function projectClaims(claimSet: unknown): ClaimsProjection;
