import support10 from '../harness/schemas/package-support/1.0.0.json' with { type: 'json' };
import support11 from '../harness/schemas/package-support/1.1.0.json' with { type: 'json' };
import { registerSchemas, schemaCheck, validateAcceptedDocument } from './internal/contract-validation.js';
import type { Diagnostic, ValidationResult } from './types.js';

export interface ContractFixture { readonly export: string; readonly expect: 'accept' | 'refuse'; readonly code?: string }
export interface SupportedContract {
  readonly id: string;
  readonly role: 'accepts' | 'produces' | 'both';
  readonly schemaExport: string;
  readonly versions?: readonly string[];
  readonly fixtures?: readonly ContractFixture[];
}
export interface PackageSupport {
  readonly schema: 'urn:aihq:package-support:1.0.0' | 'urn:aihq:package-support:1.1.0';
  readonly package: { readonly name: string; readonly version: string };
  readonly contracts: readonly SupportedContract[];
  readonly entries: readonly ({ readonly export: string; readonly runtime: 'portable' } |
    { readonly export: string; readonly runtime: 'node'; readonly nodeRange: string })[];
}
export interface ContractReadResult { accepted: boolean; code?: string }
export interface CheckContractsRequest {
  declarations: readonly PackageSupport[];
  /** The host binds these adapters to the package named by each accepting declaration. */
  readers: Readonly<Record<string, ((bytes: Uint8Array) => ContractReadResult | Promise<ContractReadResult>) | undefined>>;
  loadFixture: (packageName: string, exportSpecifier: string) => Uint8Array | 'unavailable' | Promise<Uint8Array | 'unavailable'>;
}
export interface ContractCheck {
  contractId: string;
  readerPackage: string;
  fixturePackage: string;
  fixtureExport?: string;
  expect?: 'accept' | 'refuse';
  expectedCode?: string;
  actual?: ContractReadResult;
  status: 'passed' | 'failed' | 'unavailable';
  reason?: 'reader-missing' | 'fixtures-missing' | 'fixture-unavailable' | 'reader-error' | 'outcome-mismatch';
  /** The accepting package whose reader needs attention; package versions never infer compatibility. */
  updatePackage?: string;
}
export interface ContractCheckResult { ok: boolean; checks: ContractCheck[]; diagnostics: Diagnostic[] }

registerSchemas(support10, support11);
const accepted = { [support10.$id]: schemaCheck(support10.$id), [support11.$id]: schemaCheck(support11.$id) };
export const validatePackageSupport = (value: unknown): ValidationResult => validateAcceptedDocument(value, accepted, () => []);

/** Runs supplied readers against other packages' declared bytes, without host effects. */
export async function checkContracts({ declarations, readers, loadFixture }: CheckContractsRequest): Promise<ContractCheckResult> {
  const diagnostics = declarations.flatMap(declaration => validatePackageSupport(declaration).diagnostics);
  if (diagnostics.length) return { ok: false, checks: [], diagnostics };
  const checks: ContractCheck[] = [];
  for (const [consumerIndex, consumer] of declarations.entries()) for (const contract of consumer.contracts) {
    if (contract.role === 'produces') continue;
    for (const [producerIndex, producer] of declarations.entries()) {
      if (producerIndex === consumerIndex) continue;
      for (const published of producer.contracts.filter(item => item.id === contract.id && item.role !== 'accepts')) {
        const base = { contractId: contract.id, readerPackage: consumer.package.name, fixturePackage: producer.package.name };
        if (!published.fixtures?.length) {
          checks.push({ ...base, status: 'unavailable', reason: 'fixtures-missing' });
          continue;
        }
        for (const fixture of published.fixtures) {
          const row: ContractCheck = { ...base, fixtureExport: fixture.export, expect: fixture.expect,
            ...(fixture.code === undefined ? {} : { expectedCode: fixture.code }), status: 'unavailable' };
          checks.push(row);
          const reader = Object.hasOwn(readers, contract.id) ? readers[contract.id] : undefined;
          if (!reader) { row.reason = 'reader-missing'; row.updatePackage = consumer.package.name; continue; }
          let bytes: Uint8Array | 'unavailable';
          try { bytes = await loadFixture(producer.package.name, fixture.export); }
          catch { row.reason = 'fixture-unavailable'; continue; }
          // TextEncoder or a host bridge can return bytes from a different realm.
          if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]') {
            row.reason = 'fixture-unavailable'; continue;
          }
          let actual: ContractReadResult;
          try { actual = await reader(bytes); }
          catch { row.status = 'failed'; row.reason = 'reader-error'; row.updatePackage = consumer.package.name; continue; }
          if (!actual || typeof actual.accepted !== 'boolean' || (actual.code !== undefined && typeof actual.code !== 'string')) {
            row.status = 'failed'; row.reason = 'reader-error'; row.updatePackage = consumer.package.name; continue;
          }
          row.actual = { accepted: actual.accepted, ...(actual.code === undefined ? {} : { code: actual.code }) };
          row.status = actual.accepted === (fixture.expect === 'accept') &&
            (fixture.code === undefined || fixture.code === actual.code) ? 'passed' : 'failed';
          if (row.status === 'failed') { row.reason = 'outcome-mismatch'; row.updatePackage = consumer.package.name; }
        }
      }
    }
  }
  return { ok: checks.every(check => check.status === 'passed'), checks, diagnostics: [] };
}
