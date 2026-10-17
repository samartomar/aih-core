// Portable driver bundled by the artifact gate and run in a context with only
// browser globals. It imports portable entries only and calls the operations
// directly; digests use WebCrypto. Inputs are bytes and JSON text, parsed here so
// every result object belongs to this context.
import { recipeOperationKinds } from '@aihq/core/contracts';
import { targets } from '@aihq/core/harness';
import { CLAIMS_SCHEMA, validateClaimSet } from '@aihq/core/report';
import { getGuidance } from '@aihq/core/support';
import { releaseInventory } from '@aihq/catalog/contracts';
import { compareReleases, readRelease, resolveSelections } from '@aihq/catalog/reader';
import { readArtifact, readContentCoverage } from '@aihq/scan/read';

const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const open = async bytes => {
  const read = readRelease(bytes, { expectedSha256: await hex(bytes) });
  if (!read.valid) throw new Error(`release unreadable: ${JSON.stringify(read.diagnostics)}`);
  return read.release;
};
const check = (condition, message) => { if (!condition) throw new Error(message); };

export async function runPortableOperations({ current, baseline, artifact, preparationText, runText }) {
  const [preparation, run] = [JSON.parse(preparationText), JSON.parse(runText)];
  const hostGlobals = ['process', 'require', 'Buffer', 'module', 'setImmediate', 'global'].filter(name => Reflect.has(globalThis, name));
  check(hostGlobals.length === 0, `Node host globals are present: ${hostGlobals.join(', ')}`);
  const [first, second] = [await open(baseline), await open(current)];
  const compared = compareReleases({ first, second });
  check(compared.status === 'ok', 'compareReleases refused');
  const resolved = resolveSelections({ releases: { [second.sha256]: second },
    roots: [{ releaseSha256: second.sha256, itemId: 'consumer.absent-item', scope: 'project', configuration: {} }], skips: [] });
  check(resolved.status === 'refused' && resolved.diagnostics[0].code === 'ITEM_UNAVAILABLE', 'resolveSelections detail');
  const read = await readArtifact(artifact);
  check(read.status === 'read', 'readArtifact');
  const descriptors = read.report.source.capture.entries.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength }));
  const matched = await readContentCoverage({ read, descriptors });
  const mismatched = await readContentCoverage({ read, descriptors: descriptors.map(entry => ({ ...entry, byteLength: entry.byteLength + 1 })) });
  const prepareGuidance = getGuidance({ kind: 'prepare', result: preparation }, { platform: 'unknown' });
  const runGuidance = getGuidance({ kind: 'run', result: run }, { platform: 'unknown' });
  const claims = validateClaimSet({ schema: CLAIMS_SCHEMA, claims: [], calculations: [], actions: [] });
  return {
    nodeGlobalsAbsent: true,
    catalog: { inventory: releaseInventory.releases.length, compared: { sameRelease: compared.value.sameRelease, items: compared.value.items.length },
      resolveRefusal: resolved.diagnostics[0].code },
    scan: { matched: matched.status, mismatched: mismatched.status },
    core: { recipeSchemas: Object.keys(recipeOperationKinds).length, npx: targets.find(target => target.executables.includes('npx'))?.id,
      prepareGuidance: prepareGuidance.status, runGuidance: runGuidance.status, emptyClaimSet: claims.valid },
  };
}
